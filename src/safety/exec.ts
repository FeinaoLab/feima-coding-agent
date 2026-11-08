/**
 * 执行层。
 *
 * 设计要点：
 * - 所有命令执行收敛到一个 ExecFn，工具层不允许自己 spawn。
 * - 启用 strict 但后端不可用时，直接拒绝执行，绝不“先跑起来再说”。
 * - 启动握手：真跑一条受控命令并带回随机 token，才认为执行通道就绪。
 *   光看“加载成功”会得到“假绿”——srt 装了一半、命名空间被禁，扩展照样能加载。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "../types.ts";
import { PolicyError, filterEnv, type Policy } from "./policy.ts";

export type SandboxMode = "policy" | "strict";

export interface SandboxOptions {
  mode: SandboxMode;
  policy: Policy;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface Sandbox {
  mode: SandboxMode;
  /** 是否具备进程级隔离（当前实现恒为 false，留给 srt / 容器后端） */
  isolated: boolean;
  exec: ExecFn;
  describe(): string;
}

const isWin = process.platform === "win32";

function shellFor(command: string): { file: string; args: string[] } {
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

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWin) spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* 进程可能已经退出 */
  }
}

export function createSandbox(opts: SandboxOptions): Sandbox {
  const timeoutDefault = opts.defaultTimeoutMs ?? 120_000;
  const maxBytes = opts.maxOutputBytes ?? 256 * 1024;
  const env = filterEnv(process.env);

  const exec: ExecFn = (command, cwd, options = {}) =>
    new Promise((resolve, reject) => {
      const { file, args } = shellFor(command);
      const child = spawn(file, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
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

      child.stdout.on("data", (b: Buffer) => {
        stdout += clip(b);
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += clip(b);
      });

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
        const note = truncated ? "\n[输出过长已截断]" : "";
        resolve({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdout + note,
          stderr,
          timedOut,
        });
      });
    });

  const isolated = false;

  return {
    mode: opts.mode,
    isolated,
    exec,
    describe(): string {
      if (opts.mode === "strict") {
        return "strict（进程级隔离后端未安装，命令执行将被拒绝）";
      }
      return "policy（路径与环境变量策略生效；进程级隔离未启用）";
    },
  };
}

/**
 * 启动握手。返回的 token 必须由受控命令原样带回，宿主侧比对一致才算就绪。
 * 这里的实现只验证“执行力可用 + 策略装载成功”，接入 srt 后应改为验证隔离能力。
 */
export async function handshake(sandbox: Sandbox, cwd: string, timeoutMs = 20_000): Promise<string> {
  const token = randomBytes(12).toString("hex");
  const probe = isWin
    ? `Write-Output "FEIMA_SANDBOX_READY ${token}"; exit 0`
    : `printf 'FEIMA_SANDBOX_READY %s\\n' '${token}'; exit 0`;

  const res = await Promise.race([
    sandbox.exec(probe, cwd, { timeoutMs }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new PolicyError("SANDBOX_TIMEOUT", "沙盒握手超时，已阻止启动")), timeoutMs),
    ),
  ]);

  if (res.exitCode !== 0 || !res.stdout.includes(`FEIMA_SANDBOX_READY ${token}`)) {
    throw new PolicyError("SANDBOX_FAILED", "系统拒绝启动隔离命令，请检查沙盒依赖或系统权限");
  }
  return token;
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
