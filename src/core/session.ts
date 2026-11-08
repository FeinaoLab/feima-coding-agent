/**
 * 会话持久化。
 *
 * 格式选择 JSONL append-only，理由有三：
 * 1. 崩溃安全：每行独立成条，进程被 kill 掉最多丢最后半行，前面的历史还能读。
 * 2. 可观测：`tail -f` 就能看 Agent 在干什么，不需要专门的查看器。
 * 3. 可演进：新记录类型（压缩、工具审计）直接加行，旧版本读到不认识的类型跳过即可。
 *
 * 存放位置是 ~/.feima/sessions/，不放工作区——会话里可能有敏感路径和业务信息，
 * 写进仓库容易被误提交；跨工作区检索时也能按 meta.workspace 过滤。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, Usage } from "../types.ts";
import { estimateMessages } from "./compact.ts";

export const SESSION_VERSION = 1;

export interface SessionMeta {
  v: number;
  id: string;
  title: string;
  workspace: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary extends SessionMeta {
  messages: number;
  turns: number;
  bytes: number;
}

type Record_ =
  | { t: "meta"; meta: SessionMeta }
  | { t: "msg"; m: ChatMessage }
  | { t: "compact"; before: number; after: number; folded: number }
  | { t: "usage"; u: Usage }
  | { t: "note"; text: string };

export interface LoadedSession {
  meta: SessionMeta;
  messages: ChatMessage[];
  /** 坏行数量：崩溃或并发写入留下的残行，读取时跳过并计数 */
  broken: number;
  compacts: number;
  usage: Usage | null;
}

export function defaultSessionDir(): string {
  const home = process.env.FEIMA_HOME?.trim();
  return path.join(home || path.join(os.homedir(), ".feima"), "sessions");
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function rand4(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

function firstLine(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
  } finally {
    fs.closeSync(fd);
  }
}

function parseMeta(file: string): SessionMeta | null {
  try {
    const rec = JSON.parse(firstLine(file)) as Record_;
    if (rec.t !== "meta") return null;
    const m = rec.meta;
    return m && typeof m.id === "string" ? m : null;
  } catch {
    return null;
  }
}

export class SessionStore {
  readonly meta: SessionMeta;
  private file: string;

  private constructor(file: string, meta: SessionMeta) {
    this.file = file;
    this.meta = meta;
  }

  get path(): string {
    return this.file;
  }

  get id(): string {
    return this.meta.id;
  }

  /** 新建会话：立即落 meta 行，保证后续 append 不会写到没有头部的孤儿文件 */
  static create(
    init: { workspace: string; model: string; title?: string },
    dir = defaultSessionDir(),
  ): SessionStore {
    fs.mkdirSync(dir, { recursive: true });
    let id = `${stamp()}-${rand4()}`;
    let file = path.join(dir, `${id}.jsonl`);
    let guard = 0;
    while (fs.existsSync(file) && guard++ < 20) {
      id = `${stamp()}-${rand4()}`;
      file = path.join(dir, `${id}.jsonl`);
    }

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      v: SESSION_VERSION,
      id,
      title: (init.title ?? "").trim() || "未命名会话",
      workspace: init.workspace,
      model: init.model,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(file, JSON.stringify({ t: "meta", meta } satisfies Record_) + "\n", "utf8");
    return new SessionStore(file, meta);
  }

  /** 打开已有会话；传 "last" 取最近更新的一条 */
  static open(idOrLast: string, dir = defaultSessionDir()): SessionStore {
    let file: string;
    if (idOrLast === "last" || idOrLast === "") {
      const list = SessionStore.list(dir);
      if (!list.length) throw new Error("没有可恢复的会话");
      file = path.join(dir, `${list[0].id}.jsonl`);
    } else {
      const clean = idOrLast.replace(/[^0-9A-Za-z-]/g, "");
      file = path.join(dir, `${clean}.jsonl`);
    }
    if (!fs.existsSync(file)) throw new Error(`会话不存在：${idOrLast}`);
    const meta = parseMeta(file);
    if (!meta) throw new Error(`会话文件损坏（缺 meta 行）：${path.basename(file)}`);
    if (meta.v > SESSION_VERSION) {
      throw new Error(`会话版本 ${meta.v} 高于当前支持的 ${SESSION_VERSION}，请升级飞码`);
    }
    return new SessionStore(file, meta);
  }

  /** 按更新时间倒序列出；坏文件直接跳过，不让一个残文件拖垮整个列表 */
  static list(dir = defaultSessionDir()): SessionSummary[] {
    if (!fs.existsSync(dir)) return [];
    const out: SessionSummary[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const meta = parseMeta(file);
      if (!meta) continue;
      let messages = 0;
      let turns = 0;
      let bytes = 0;
      try {
        bytes = fs.statSync(file).size;
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const rec = JSON.parse(line) as Record_;
            if (rec.t === "msg") messages++;
            if (rec.t === "msg" && rec.m.role === "user") turns++;
          } catch {
            /* 坏行计入 broken 但不影响列表 */
          }
        }
      } catch {
        continue;
      }
      out.push({ ...meta, messages, turns, bytes });
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  static remove(id: string, dir = defaultSessionDir()): boolean {
    const file = path.join(dir, `${id.replace(/[^0-9A-Za-z-]/g, "")}.jsonl`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  private append(rec: Record_): void {
    // 上次进程被 kill 时可能留下没有结尾换行的残行。
    // 直接 append 会把新记录粘到残行后面，等于把两条都变成坏行。
    this.ensureTrailingNewline();
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    this.meta.updatedAt = new Date().toISOString();
  }

  private ensureTrailingNewline(): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size === 0) return;
    const fd = fs.openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      if (buf[0] !== 0x0a) fs.appendFileSync(this.file, "\n", "utf8");
    } finally {
      fs.closeSync(fd);
    }
  }

  appendMessage(m: ChatMessage): void {
    this.append({ t: "msg", m });
    if (m.role === "user" && m.content) this.maybeTitle(m.content);
  }

  appendCompact(before: number, after: number, folded: number): void {
    this.append({ t: "compact", before, after, folded });
  }

  appendUsage(u: Usage): void {
    this.append({ t: "usage", u });
  }

  appendNote(text: string): void {
    this.append({ t: "note", text });
  }

  /** 首条像样的用户消息自动成为标题，避免列表里一排「未命名会话」 */
  private maybeTitle(text: string): void {
    if (this.meta.title !== "未命名会话") return;
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length < 2) return;
    this.meta.title = clean.length > 40 ? clean.slice(0, 40) + "…" : clean;
    this.rewriteMeta();
  }

  /**
   * 把 meta 行原地更新。
   * 列表是读首行拿标题的，只改内存等于列表里永远显示「未命名会话」。
   */
  private rewriteMeta(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n");
    lines[0] = JSON.stringify({ t: "meta", meta: this.meta } satisfies Record_);
    fs.writeFileSync(this.file, lines.join("\n"), "utf8");
  }

  load(): LoadedSession {
    const raw = fs.readFileSync(this.file, "utf8");
    const messages: ChatMessage[] = [];
    let broken = 0;
    let compacts = 0;
    let usage: Usage | null = null;
    let meta = this.meta;

    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: Record_;
      try {
        rec = JSON.parse(t) as Record_;
      } catch {
        broken++;
        continue;
      }
      switch (rec.t) {
        case "meta":
          meta = rec.meta;
          break;
        case "msg":
          messages.push(rec.m);
          break;
        case "compact":
          compacts++;
          break;
        case "usage":
          usage = rec.u;
          break;
        default:
          break;
      }
    }
    return { meta, messages, broken, compacts, usage };
  }

  /** 体积与估算 token，给 /state 与 sessions 列表用 */
  stats(): { messages: number; bytes: number; tokens: number } {
    const loaded = this.load();
    return {
      messages: loaded.messages.length,
      bytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
      tokens: estimateMessages(loaded.messages),
    };
  }
}
