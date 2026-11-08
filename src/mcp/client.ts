/**
 * 最小 MCP 客户端（stdio 传输）。
 *
 * 只实现三件事：initialize、tools/list、tools/call。MCP 协议里其余部分
 * （resources、prompts、sampling、通知流）飞码用不到，实现了也只是多一堆
 * 没人测的分支。
 *
 * 传输选择：stdio + 换行分隔的 JSON-RPC。规范要求服务端 stdout 只写协议，
 * 但现实里有服务端会把启动横幅打到 stdout，所以解析层遇到非 JSON 行时
 * 只记一笔，不当成致命错误——否则一个 `console.log` 就能让整个工具集不可用。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { filterEnv } from "../safety/policy.ts";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_CLIENT_INFO = { name: "feima", version: "0.4.0" };

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Windows 上 `npx` 这类 .cmd 需要经 shell 启动；不给则按平台猜 */
  shell?: boolean;
  /** 单次请求超时，默认 20000 */
  timeoutMs?: number;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  ok: boolean;
  text: string;
  isError: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class McpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

export interface ResolvedCommand {
  file: string;
  args: string[];
  shell: boolean;
  note?: string;
}

function quoteForCmd(s: string): string {
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 决定「用什么 spawn」。
 *
 * 这里踩过一个坑：Windows 上为了跑 `npx` 而粗暴地 `shell: true`，结果参数里
 * 一有空格就被 cmd 拆开——`node "D:/My Project/server.mjs"` 变成三个参数，
 * 服务端起不来，报错还是一句难懂的语法错误。所以规则收紧成：
 *   - 绝对路径 / 带分隔符：直接 spawn，不过 shell；
 *   - 裸名字：自己按 PATH + PATHEXT 找，找到 .exe/.com 就直接 spawn；
 *   - 只有 .cmd/.bat 才不得不经 cmd.exe，并且参数逐个加引号。
 */
export function buildSpawn(
  command: string,
  args: string[],
  opts: {
    shell?: boolean;
    platform?: NodeJS.Platform;
    envPath?: string;
    pathExt?: string;
    exists?: (p: string) => boolean;
  } = {},
): ResolvedCommand {
  const platform = opts.platform ?? process.platform;
  if (opts.shell === true) return { file: command, args, shell: true, note: "按配置经 shell 启动" };
  if (platform !== "win32") return { file: command, args, shell: false };
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return { file: command, args, shell: false };
  }

  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const dirs = (opts.envPath ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = (opts.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const ext of ["", ...exts.map((e) => e.toLowerCase()), ...exts]) {
      candidates.push(path.join(dir, command + ext));
    }
  }
  const found = candidates.find((c) => exists(c));
  if (!found) return { file: command, args, shell: false };

  const lower = found.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const line = [quoteForCmd(found), ...args.map(quoteForCmd)].join(" ");
    return {
      file: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `"${line}"`],
      shell: false,
      note: `${path.basename(found)} 是批处理，经 cmd.exe 启动`,
    };
  }
  return { file: found, args, shell: false };
}

/** 从 tools/call 的返回里拼出纯文本：MCP 允许 content 是 [{type:"text"},{type:"image"}] */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { text?: string } };
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource" && typeof block.resource?.text === "string") parts.push(block.resource.text);
    // 图片/音频不回灌：模型读不了二进制，硬塞只会浪费 token
    else if (block.type === "image" || block.type === "audio") parts.push(`（${block.type} 内容已省略，${block.mimeType ?? "未知类型"}）`);
  }
  return parts.join("\n").trim();
}

export class McpClient {
  readonly server: string;
  private cfg: McpServerConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private noise = 0;
  private stderrTail = "";
  private closed = false;
  private tools: McpToolInfo[] | null = null;
  /** 启动方式的补充说明（例如"经 cmd.exe 启动"），doctor 里要如实打出来 */
  startNote = "";

  constructor(server: string, cfg: McpServerConfig) {
    this.server = server;
    this.cfg = cfg;
  }

  get label(): string {
    return this.server;
  }

  /** 服务端 stderr 最近若干行：连不上时这是唯一能说清原因的线索 */
  get diagnostics(): string {
    return this.stderrTail.trim();
  }

  /** 被丢弃的非协议行数（服务端往 stdout 打了日志） */
  get noiseLines(): number {
    return this.noise;
  }

  private get timeoutMs(): number {
    return this.cfg.timeoutMs ?? 20_000;
  }

  async start(): Promise<void> {
    if (this.child) return;
    const plan = buildSpawn(this.cfg.command, this.cfg.args ?? [], {
      ...(typeof this.cfg.shell === "boolean" ? { shell: this.cfg.shell } : {}),
    });
    if (plan.note) this.startNote = plan.note;
    const child = spawn(plan.file, plan.args, {
      cwd: this.cfg.cwd,
      env: { ...filterEnv(process.env), ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: plan.shell,
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("error", (err) => {
      this.failAll(new McpError("MCP_SPAWN", `MCP 服务 ${this.server} 启动失败：${err.message}`));
    });
    child.on("exit", (code, signal) => {
      this.closed = true;
      const tail = this.stderrTail.trim().split("\n").slice(-3).join(" / ");
      this.failAll(
        new McpError("MCP_EXIT", `MCP 服务 ${this.server} 已退出（code=${code}${signal ? `, signal=${signal}` : ""}）${tail ? "：" + tail : ""}`),
      );
    });

    this.child = child;
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    });
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        this.noise++;
        continue;
      }
      if (msg.id === undefined || msg.id === null) continue; // 通知，忽略
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new McpError("MCP_RPC", `MCP ${this.server}.${pending.method} 失败：${msg.error.message ?? "未知错误"}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private write(payload: unknown): void {
    if (!this.child || this.closed) throw new McpError("MCP_CLOSED", `MCP 服务 ${this.server} 已关闭`);
    this.child.stdin.write(JSON.stringify(payload) + "\n");
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError("MCP_TIMEOUT", `MCP ${this.server}.${method} 超时（${this.timeoutMs} ms）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (this.tools) return this.tools;
    const result = (await this.request("tools/list", {})) as { tools?: unknown };
    const raw = Array.isArray(result?.tools) ? (result.tools as Record<string, unknown>[]) : [];
    this.tools = raw
      .filter((t) => typeof t?.name === "string" && t.name)
      .map((t) => ({
        name: String(t.name),
        description: typeof t.description === "string" ? t.description : "",
        inputSchema:
          t.inputSchema && typeof t.inputSchema === "object"
            ? (t.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} },
      }));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: unknown;
      isError?: boolean;
    };
    const text = flattenContent(result?.content);
    return { ok: result?.isError !== true, isError: result?.isError === true, text };
  }

  async close(): Promise<void> {
    const child = this.child;
    this.closed = true;
    this.failAll(new McpError("MCP_CLOSED", `MCP 服务 ${this.server} 已关闭`));
    if (!child) return;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      /* 已经关了就算了 */
    }
    // 给服务端 300ms 自己退；不退就 kill，避免留下孤儿进程占着端口
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 300);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** 读取 ~/.feima/mcp.json 的结构；只做形状校验，不替用户猜默认值 */
export function parseMcpConfig(raw: unknown): { config: McpConfig; problems: string[] } {
  const problems: string[] = [];
  const servers: Record<string, McpServerConfig> = {};
  const src = (raw ?? {}) as { servers?: unknown };
  const entries = src.servers && typeof src.servers === "object" ? Object.entries(src.servers as Record<string, unknown>) : [];
  if (!entries.length) problems.push("mcp.json 里没有 servers 配置");
  for (const [name, value] of entries) {
    if (!value || typeof value !== "object") {
      problems.push(`servers.${name} 不是对象，已跳过`);
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.command !== "string" || !v.command.trim()) {
      problems.push(`servers.${name} 缺少 command，已跳过`);
      continue;
    }
    servers[name] = {
      command: v.command,
      ...(Array.isArray(v.args) ? { args: v.args.map(String) } : {}),
      ...(v.env && typeof v.env === "object" ? { env: Object.fromEntries(Object.entries(v.env as Record<string, unknown>).map(([k, x]) => [k, String(x)])) } : {}),
      ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
      ...(typeof v.shell === "boolean" ? { shell: v.shell } : {}),
      ...(typeof v.timeoutMs === "number" ? { timeoutMs: v.timeoutMs } : {}),
    };
  }
  return { config: { servers }, problems };
}
