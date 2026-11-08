/**
 * Linux 后端：bubblewrap。
 *
 * 选它的理由和 AppContainer 一样——不需要 daemon、不需要 root、不需要镜像，
 * 一个几百 KB 的静态二进制就能把文件系统、网络、PID 全切干净。
 * 差别在于它靠 mount namespace 白名单：**只绑定明确列出的目录**，
 * 而不是「挂载整个 / 再减去黑名单」。这个方向很重要，白名单出错是「跑不起来」，
 * 黑名单出错是「隔离失效」。
 *
 * 唯一的环境前提：内核允许非特权用户使用 user namespace。
 * 有些发行版把它关了（`kernel.unprivileged_userns_clone=0`），
 * 这时 `bwrap --version` 一切正常，真跑起来才报 `Creating new namespace failed`。
 * 所以这一项的可用性只能靠 selfTest 判定。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "../../types.ts";
import { realpathLoose } from "../policy.ts";
import type { IsolationAvailability, IsolationBackend, SelfTestReport, SpawnPlan } from "../isolation.ts";
import { decoyName } from "../isolation.ts";

/** 系统里可能需要只读挂进来的目录；不存在的自动跳过 */
const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix/store"];

/** 绑定 /etc 之后要盖掉的敏感文件（bwrap 允许把 /dev/null 绑到文件上） */
const MASKED_FILES = ["/etc/shadow", "/etc/gshadow", "/etc/sudoers"];

export interface BwrapArgsOptions {
  command: string;
  workspace: string;
  /** 是否放行出网。默认关闭：Agent 不需要网络时，关掉能把数据外带这条路一起关掉 */
  network: boolean;
  /** 额外的只读挂载，例如语言运行时目录 */
  extraRoBinds?: string[];
  env?: Record<string, string>;
  /** 存在性检查注入点，便于单测 */
  exists?: (p: string) => boolean;
}

export function buildBwrapArgs(opts: BwrapArgsOptions): string[] {
  const ws = realpathLoose(opts.workspace);
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const args: string[] = ["--die-with-parent", "--new-session"];

  for (const dir of SYSTEM_DIRS) {
    if (exists(dir)) args.push("--ro-bind", dir, dir);
  }
  for (const secret of MASKED_FILES) {
    if (exists(secret)) args.push("--ro-bind", "/dev/null", secret);
  }
  for (const extra of opts.extraRoBinds ?? []) {
    if (exists(extra)) args.push("--ro-bind", extra, extra);
  }

  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  // 工作区是唯一可写的地方；$HOME 根本不在命名空间里，所以 ~/.ssh 不是「被拒绝」，是「不存在」
  args.push("--bind", ws, ws);
  args.push("--unshare-all");
  if (opts.network) args.push("--share-net");
  args.push("--chdir", ws);

  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push("--setenv", k, v);
  }

  args.push("--", "/bin/sh", "-c", opts.command);
  return args;
}

function hasBwrap(): boolean {
  const res = spawnSync("bwrap", ["--version"], { encoding: "utf8", timeout: 10_000 });
  return res.status === 0;
}

export function createBwrapBackend(network: boolean): IsolationBackend {
  return {
    id: "bwrap",
    real: true,
    capture: "pipe",
    label: "bubblewrap（Linux mount namespace 白名单）",

    availability(): IsolationAvailability {
      if (process.platform !== "linux") {
        return { available: false, reason: `bubblewrap 只用于 Linux，当前是 ${process.platform}` };
      }
      if (!hasBwrap()) {
        return {
          available: false,
          reason: "未安装 bubblewrap（apt install bubblewrap / dnf install bubblewrap）",
        };
      }
      return { available: true, reason: "bubblewrap 已安装（是否真能建命名空间由 selfTest 判定）" };
    },

    async prepare(): Promise<void> {
      /* bwrap 不需要预先授权，挂载时就定了 */
    },

    plan(command: string, workspace: string): SpawnPlan {
      return {
        file: "bwrap",
        args: buildBwrapArgs({ command, workspace, network }),
      };
    },

    async selfTest(workspace: string, execInSandbox: ExecFn): Promise<SelfTestReport> {
      const token = `feima-${Math.random().toString(36).slice(2, 12)}`;
      const inName = decoyName();
      const hostName = decoyName();
      const insidePath = path.join(workspace, inName);
      const hostPath = path.join(os.homedir(), hostName);
      fs.writeFileSync(insidePath, token, "utf8");
      fs.writeFileSync(hostPath, "host-secret", "utf8");

      const readWorkspace = await execInSandbox(`cat "${insidePath}"`, workspace, { timeoutMs: 20_000 })
        .then((r) => r.stdout.includes(token))
        .catch(() => false);
      const denyHostRead = await execInSandbox(`cat "${hostPath}"`, workspace, { timeoutMs: 20_000 })
        .then((r) => !r.stdout.includes("host-secret"))
        .catch(() => true);
      const listWorkspace = await execInSandbox('ls -1', workspace, { timeoutMs: 30_000 })
        .then((r) => r.exitCode === 0 && r.stdout.trim().length > 0)
        .catch(() => false);
      const writeWorkspace = await execInSandbox(`echo ${token} > "${insidePath}.w"`, workspace, { timeoutMs: 20_000 })
        .then((r) => r.exitCode === 0)
        .catch(() => false);
      const denyHostWrite = await execInSandbox(`echo x > "${hostPath}.w"`, workspace, { timeoutMs: 20_000 })
        .then(() => !fs.existsSync(`${hostPath}.w`))
        .catch(() => true);

      for (const p of [insidePath, `${insidePath}.w`, hostPath, `${hostPath}.w`]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* 忽略 */
        }
      }

      const ok = readWorkspace && denyHostRead && writeWorkspace && denyHostWrite && listWorkspace;
      return {
        ok,
        readWorkspace,
        denyHostRead,
        writeWorkspace,
        listWorkspace,
        denyHostWrite,
        detail: [
          `读工作区 ${readWorkspace ? "通过" : "失败"}`,
          `读宿主家目录 ${denyHostRead ? "被拒" : "**未拦住**"}`,
          `写工作区 ${writeWorkspace ? "通过" : "失败"}`,
          `列目录 ${listWorkspace ? "通过" : "**被拒**"}`,
          `写宿主家目录 ${denyHostWrite ? "被拒" : "**未拦住**"}`,
        ].join("；"),
      };
    },

    async dispose(): Promise<void> {
      /* 无状态 */
    },
  };
}
