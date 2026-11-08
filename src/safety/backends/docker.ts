/**
 * Docker 后端（Linux / macOS）。
 *
 * 它是最"重"的一档：要 daemon、要镜像、要几十秒冷启动。放在这里的理由只有一个——
 * 当 bwrap 因为内核限制不可用时，它是唯一还能给出真隔离的退路。
 *
 * 一个刻意的限制：**只做同路径挂载**（`-v /abs/ws:/abs/ws`）。
 * 把工作区挂到 `/work` 再让 Agent 在容器里操作，会让所有工具返回的路径
 * 与宿主路径不一致；模型拿着容器内路径去拼下一条命令，宿主侧就找不到文件。
 * 同路径挂载保证"Agent 看到的路径"和"你在编辑器里打开的路径"是同一个字符串。
 * 代价是 Windows 上做不到（容器内没有 C: 盘），所以 Windows 走 AppContainer。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "../../types.ts";
import { realpathLoose } from "../policy.ts";
import type { IsolationAvailability, IsolationBackend, SelfTestReport, SpawnPlan } from "../isolation.ts";
import { decoyName } from "../isolation.ts";

export const DEFAULT_IMAGE = "node:22-alpine";

export interface DockerArgsOptions {
  command: string;
  workspace: string;
  image?: string;
  network: boolean;
  env?: Record<string, string>;
  /** 宿主 uid:gid，避免产物属主变成 root；测试时可固定 */
  user?: string;
}

export function buildDockerArgs(opts: DockerArgsOptions): string[] {
  const ws = realpathLoose(opts.workspace);
  const image = opts.image ?? DEFAULT_IMAGE;
  const args = [
    "run",
    "--rm",
    "-i",
    "--network",
    opts.network ? "bridge" : "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-v",
    `${ws}:${ws}`,
    "-w",
    ws,
  ];

  if (opts.user) args.push("--user", opts.user);
  for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);

  // --entrypoint 显式给出，避免镜像默认入口（如 tini）把 -c 当成参数吃掉
  args.push("--entrypoint", "/bin/sh", image, "-c", opts.command);
  return args;
}

function dockerDaemon(): { running: boolean; reason: string } {
  const res = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (res.error) return { running: false, reason: "未安装 docker 客户端" };
  if (res.status !== 0) {
    const err = `${res.stderr ?? ""}`.trim().split("\n").slice(0, 2).join(" ");
    return { running: false, reason: `docker 守护进程未运行（${err || "无响应"}）` };
  }
  return { running: true, reason: `docker ${(res.stdout ?? "").trim()}` };
}

export function createDockerBackend(network: boolean, image = DEFAULT_IMAGE): IsolationBackend {
  return {
    id: "docker",
    real: true,
    capture: "pipe",
    label: `docker 容器（镜像 ${image}）`,

    availability(): IsolationAvailability {
      if (process.platform === "win32") {
        return {
          available: false,
          reason: "容器内没有 C: 盘，无法做同路径挂载；Windows 用 appcontainer 后端",
        };
      }
      const d = dockerDaemon();
      return { available: d.running, reason: d.running ? d.reason : d.reason };
    },

    async prepare(): Promise<void> {
      /* 镜像由 docker run 自动拉取，不在 prepare 里做（会拖慢启动） */
    },

    plan(command: string, workspace: string): SpawnPlan {
      const user =
        typeof process.getuid === "function" ? `${process.getuid()}:${process.getgid?.() ?? 0}` : undefined;
      return {
        file: "docker",
        args: buildDockerArgs({ command, workspace, image, network, user }),
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

      const readWorkspace = await execInSandbox(`cat "${insidePath}"`, workspace, { timeoutMs: 60_000 })
        .then((r) => r.stdout.includes(token))
        .catch(() => false);
      const denyHostRead = await execInSandbox(`cat "${hostPath}"`, workspace, { timeoutMs: 60_000 })
        .then((r) => !r.stdout.includes("host-secret"))
        .catch(() => true);
      const listWorkspace = await execInSandbox('ls -1', workspace, { timeoutMs: 30_000 })
        .then((r) => r.exitCode === 0 && r.stdout.trim().length > 0)
        .catch(() => false);
      const writeWorkspace = await execInSandbox(`echo ${token} > "${insidePath}.w"`, workspace, { timeoutMs: 60_000 })
        .then((r) => r.exitCode === 0)
        .catch(() => false);
      const denyHostWrite = await execInSandbox(`echo x > "${hostPath}.w"`, workspace, { timeoutMs: 60_000 })
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
      /* 容器 --rm，无残留 */
    },
  };
}
