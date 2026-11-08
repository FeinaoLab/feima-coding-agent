/**
 * 执行层。
 *
 * 设计要点：
 * - 所有命令执行收敛到一个 ExecFn，工具层不允许自己 spawn。
 * - `strict` 表示"必须有真隔离"，没有可用后端就直接拒绝，绝不"先跑起来再说"。
 * - 启动验证：**真跑一次越界读取**（宿主家目录里放诱饵，沙盒内必须读不到），
 *   而不是"后端加载成功"。这一条是 v0.3 的核心——加载成功和隔离生效之间
 *   隔着内核开关、命名空间权限、ACL 授权三件事，任何一件都可能悄悄失败。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "../types.ts";
import { PolicyError, filterEnv, type Policy } from "./policy.ts";
import type {
  IsolationAvailability,
  IsolationBackend,
  IsolationBackendId,
  RunPaths,
  SelfTestReport,
  SpawnPlan,
} from "./isolation.ts";
import { createAppContainerBackend } from "./backends/appcontainer.ts";
import { createBwrapBackend } from "./backends/bwrap.ts";
import { createDockerBackend, DEFAULT_IMAGE } from "./backends/docker.ts";
import { checkCommandAllowed, type AllowRule } from "./allowlist.ts";

export type SandboxMode = "policy" | "strict";
export type IsolationChoice = "auto" | IsolationBackendId;

export interface SandboxOptions {
  mode: SandboxMode;
  policy: Policy;
  /** auto：strict 下自动挑可用的真后端；policy 下不启用隔离。显式指定则强制使用 */
  isolation?: IsolationChoice;
  /** 是否允许沙盒内出网 */
  network?: boolean;
  dockerImage?: string;
  /**
   * 命令白名单。接在 exec 而不是工具层：任何执行命令的路径都从这里过，
   * 将来多一个工具也不会漏掉。空数组表示不启用。
   */
  commandAllowlist?: AllowRule[];
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface Sandbox {
  mode: SandboxMode;
  /** 是否具备进程级隔离 */
  isolated: boolean;
  backendId: IsolationBackendId;
  /** 为什么是这个后端 / 为什么没有后端 */
  rationale: string;
  exec: ExecFn;
  describe(): string;
  /** 建 profile、授权目录等准备动作 */
  init(): Promise<void>;
  /** 真跑诱饵验证隔离生效 */
  verify(): Promise<SelfTestReport>;
  /** 撤销授权、清理诱饵 */
  dispose(): Promise<void>;
}

const isWin = process.platform === "win32";

function shellFor(command: string): SpawnPlan {
  if (isWin) {
    // Windows 上没有 bash 时 PowerShell 是等效通路——只封 bash 等于没封
    const ps = process.env.SYSTEMROOT
      ? path.join(process.env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    return {
      file: ps,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

/**
 * 合并环境变量时按大小写不敏感去重。
 *
 * Windows 把环境变量名当大小写不敏感，但 JS 对象不是：基础环境里是 `Path`，
 * 后端补的是 `PATH`，两者并存时 spawn 会传出两个同名条目，系统取哪个看运气。
 * 这一条踩过：从 Git Bash 启动时 Path 是 POSIX 格式且不含 System32，
 * 结果 AppContainer 里 CreateProcess 找不到 cmd.exe，只回一句 "failed: 2"。
 */
export function mergeEnv(base: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const lower = key.toLowerCase();
    for (const existing of Object.keys(out)) {
      if (existing.toLowerCase() === lower) delete out[existing];
    }
    out[key] = value;
  }
  return out;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* 进程可能已经退出 */
  }
}

/** auto 模式的候选顺序：平台原生优先，容器兜底 */
function candidates(network: boolean, image: string): IsolationBackend[] {
  const ac = createAppContainerBackend();
  const bwrap = createBwrapBackend(network);
  const docker = createDockerBackend(network, image);
  if (process.platform === "win32") return [ac, docker];
  if (process.platform === "linux") return [bwrap, docker];
  return [docker];
}

export interface Probe {
  id: IsolationBackendId;
  availability: IsolationAvailability;
}

interface Selection {
  backend: IsolationBackend | null;
  rationale: string;
  /** 所有候选的探测结果，doctor 要逐个展示，不能只报"不可用" */
  probes: Probe[];
}

function selectBackend(opts: SandboxOptions): Selection {
  const network = opts.network ?? false;
  const image = opts.dockerImage ?? DEFAULT_IMAGE;
  const choice: IsolationChoice = opts.isolation ?? "auto";
  const all = candidates(network, image);
  const probes = all.map((b) => ({ id: b.id, availability: b.availability() }));

  if (choice === "none") {
    return { backend: null, rationale: "显式指定 isolation=none，只保留策略层", probes };
  }

  if (choice !== "auto") {
    const picked = all.find((b) => b.id === choice) ?? null;
    if (!picked) {
      const reason = probes.map((p) => `${p.id}: ${p.availability.reason}`).join("；");
      return { backend: null, rationale: `指定的后端 ${choice} 在当前平台不可用（${reason}）`, probes };
    }
    const av = picked.availability();
    if (!av.available) return { backend: null, rationale: `指定的后端 ${choice} 不可用：${av.reason}`, probes };
    return { backend: picked, rationale: `显式指定 ${choice}`, probes };
  }

  if (opts.mode !== "strict") {
    return { backend: null, rationale: "policy 模式下不启用进程级隔离（如需隔离请显式指定 backend）", probes };
  }

  for (const b of all) {
    const av = b.availability();
    if (av.available) return { backend: b, rationale: `自动选择 ${b.id}：${av.reason}`, probes };
  }
  const reason = probes.map((p) => `${p.id}: ${p.availability.reason}`).join("；");
  return { backend: null, rationale: `strict 模式找不到可用的隔离后端（${reason}）`, probes };
}

export function probeIsolation(opts: { network?: boolean; dockerImage?: string } = {}): Probe[] {
  return candidates(opts.network ?? false, opts.dockerImage ?? DEFAULT_IMAGE).map((b) => ({
    id: b.id,
    availability: b.availability(),
  }));
}

export function createSandbox(opts: SandboxOptions): Sandbox {
  const selection = selectBackend(opts);
  const backend = selection.backend;
  const timeoutDefault = opts.defaultTimeoutMs ?? 120_000;
  const maxBytes = opts.maxOutputBytes ?? 256 * 1024;
  const env = filterEnv(process.env);
  const workspace = opts.policy.workspace;

  const exec: ExecFn = (command, cwd, options = {}) =>
    new Promise((resolve, reject) => {
      // 白名单先于一切：它管的是「这条命令该不该跑」，与隔离后端能不能跑是两件事
      const allow = checkCommandAllowed(command, opts.commandAllowlist ?? []);
      if (!allow.ok) {
        reject(new PolicyError("BLOCKED_COMMAND", allow.reason));
        return;
      }

      if (opts.mode === "strict" && !backend) {
        // 这里不是"降级运行"，是拒绝：strict 的意思是"没有隔离就不许执行"
        reject(new PolicyError("NO_ISOLATION_BACKEND", `strict 模式下命令执行被拒绝：${selection.rationale}`));
        return;
      }

      // files 模式：沙盒自己把输出写进工作区的临时文件，结束后读回来。
      // 放在工作区里是因为 AppContainer 只能写被授权的目录，宿主 %TEMP% 它看不见。
      const captureDir = path.join(workspace, ".feima-tmp");
      let paths: RunPaths | undefined;
      if (backend?.capture === "files") {
        fs.mkdirSync(captureDir, { recursive: true });
        const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
        paths = {
          out: path.join(captureDir, `${id}.out`),
          err: path.join(captureDir, `${id}.err`),
          aux: path.join(captureDir, `${id}.aux`),
        };
      }

      const planned = backend ? backend.plan(command, workspace, paths) : shellFor(command);
      const child = spawn(planned.file, planned.args, {
        cwd,
        // 隔离后端自带环境策略（bwrap 用 --setenv，容器用 -e），宿主环境不直接下传
        env: planned.env ? mergeEnv(env, planned.env) : env,
        // files 模式仍保留 stderr 管道：那是启动器自己的错误（例如注册表/ACL 失败），
        // 子进程的输出走文件，两者不会混
        stdio: paths ? ["ignore", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
        detached: !isWin,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let timedOut = false;

      const clip = (chunk: Buffer): string => {
        const text = chunk.toString("utf8");
        if (stdout.length + stderr.length + text.length > maxBytes) {
          truncated = true;
          return text.slice(0, Math.max(0, maxBytes - stdout.length - stderr.length));
        }
        return text;
      };

      child.stdout?.on("data", (b: Buffer) => {
        stdout += clip(b);
      });
      child.stderr?.on("data", (b: Buffer) => {
        stderr += clip(b);
      });

      const collectFiles = (): void => {
        if (!paths) return;
        for (const [key, file] of [["out", paths.out], ["err", paths.err], ["aux", paths.aux]] as const) {
          try {
            // aux 是启动器自用文件（chcp 之类），读了就丢，不进结果
            if (key === "aux") {
              fs.unlinkSync(file);
              continue;
            }
            const text = fs.readFileSync(file, "utf8");
            if (key === "out") stdout += clip(Buffer.from(text));
            else stderr += clip(Buffer.from(text));
          } catch {
            /* 命令没产出这个流是正常的 */
          }
          try {
            fs.unlinkSync(file);
          } catch {
            /* 忽略 */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, options.timeoutMs ?? timeoutDefault);

      const onAbort = (): void => {
        killTree(child.pid);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        collectFiles();
        const note = truncated ? "\n[输出过长已截断]" : "";
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdout + note,
          stderr,
          timedOut,
        });
      });
    });

  const sandbox: Sandbox = {
    mode: opts.mode,
    isolated: Boolean(backend?.real),
    backendId: backend?.id ?? "none",
    rationale: selection.rationale,
    exec,

    describe(): string {
      const gate = opts.commandAllowlist?.length ? `；白名单 ${opts.commandAllowlist.length} 条` : "";
      if (!backend) {
        if (opts.mode === "strict") return `strict（无可用隔离后端，命令执行会被拒绝）${gate}`;
        return `policy（路径与环境变量策略生效；进程级隔离未启用）${gate}`;
      }
      return `${backend.id}（${backend.label}；网络${opts.network ? "放行" : "关闭"}）${gate}`;
    },

    async init(): Promise<void> {
      if (backend) await backend.prepare(workspace);
    },

    async verify(): Promise<SelfTestReport> {
      if (!backend) {
        return {
          ok: false,
          readWorkspace: false,
          denyHostRead: false,
          writeWorkspace: false,
          // 没有后端时「列目录」也无从验证。少这一项会让这个返回值在类型上
          // 落后于真实报告结构——v0.4 之前没人发现，因为类型检查一直是空转的
          listWorkspace: false,
          denyHostWrite: false,
          detail: `没有隔离后端可验证：${selection.rationale}`,
        };
      }
      return backend.selfTest(workspace, exec);
    },

    async dispose(): Promise<void> {
      if (backend) {
        try {
          await backend.dispose(workspace);
        } catch {
          /* 清理失败不该阻止进程退出 */
        }
      }
    },
  };

  return sandbox;
}

/**
 * 启动验证。selfTest 结果决定能不能继续跑：
 * strict 模式下 ok=false 就抛错，绝不放行。
 */
export async function handshake(sandbox: Sandbox): Promise<SelfTestReport> {
  const report = await sandbox.verify();
  if (sandbox.mode === "strict" && !report.ok) {
    throw new PolicyError("SANDBOX_FAILED", `隔离未生效，拒绝启动：${report.detail}`);
  }
  return report;
}

/** 命令策略：默认拦掉几条明显不该由 Agent 执行的破坏性指令 */
export function guardCommand(command: string): void {
  const normalized = command.replace(/\s+/g, " ").trim();
  const blocked: Array<[RegExp, string]> = [
    [/\brm\s+-rf\s+\/(?!\w)/, "拒绝执行：递归删除根目录"],
    [/\bmkfs(\.|\s)/, "拒绝执行：格式化文件系统"],
    [/\bdd\s+[^|]*of=\/dev\//, "拒绝执行：直接写块设备"],
    [/:\(\)\s*\{.*\};\s*:/, "拒绝执行：疑似 fork 炸弹"],
    [/\bshutdown\b|\breboot\b/, "拒绝执行：关机/重启"],
    [/\bgit\s+push\s+.*--force(?!-with-lease)/, "拒绝执行：强推会覆盖远端历史，请显式使用 --force-with-lease"],
    [/\b(curl|wget)\b[^|]*\|\s*(ba)?sh/, "拒绝执行：下载即执行的管道"],
  ];
  for (const [re, msg] of blocked) {
    if (re.test(normalized)) throw new PolicyError("BLOCKED_COMMAND", msg);
  }
}

export function describePlatform(): string {
  return `${process.platform}/${process.arch} · ${os.release()} · node ${process.versions.node}`;
}
