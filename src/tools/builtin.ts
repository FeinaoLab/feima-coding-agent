/**
 * 内置工具集。
 *
 * 共同约束：所有路径先过 policy（resolveRead / resolveWrite），
 * 所有命令走 ctx.exec（沙盒层），工具自己不碰 fs 之外的执行能力。
 */

import fs from "node:fs";
import path from "node:path";
import type { Perms, Tool, ToolContext, ToolResult } from "../types.ts";
import { PolicyError, resolveRead, resolveWrite, realpathLoose, isInside, redact, type Policy } from "../safety/policy.ts";
import { guardCommand } from "../safety/exec.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".feima", ".venv", "dist", "build", "__pycache__"]);

export interface BuiltinOptions {
  policy: Policy;
  /**
   * 权限档，累进：read 只注册只读工具，write 加写文件，exec 加命令。
   * 不注册而不是「注册了再拒绝」：一个必然失败的写工具留在 schema 里，
   * 模型会反复试，几轮就把上下文烧光（v0.4 的知识库工具踩过同样的坑）。
   */
  perms?: Perms;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v !== "string" || (required && !v.trim())) {
    throw new PolicyError("BAD_ARGS", `参数 ${key} 必须是非空字符串`);
  }
  return v;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function* walk(root: string, maxDepth: number, depth = 0): Generator<string> {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") {
      if (e.isDirectory()) continue;
    }
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const full = path.join(root, e.name);
    yield full;
    if (e.isDirectory()) yield* walk(full, maxDepth, depth + 1);
  }
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        out += "[^/\\\\]*";
      }
    } else if (ch === "?") {
      out += "[^/\\\\]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

function preview(text: string, limit = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) + "…" : oneLine;
}

export function builtinTools(opts: BuiltinOptions): Tool[] {
  const { policy } = opts;

  const readFile: Tool = {
    name: "read_file",
    effects: ["read"],
    description: "读取工作区内的文本文件，返回带行号的正文。大文件请用 offset/limit 分段读。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区的路径" },
        offset: { type: "number", description: "起始行，从 1 开始" },
        limit: { type: "number", description: "最多读多少行，默认 800" },
      },
      required: ["path"],
    },
    async run(args, ctx): Promise<ToolResult> {
      const abs = resolveRead(policy, str(args, "path"));
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        return { ok: false, content: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），请用 offset/limit 分段读取` };
      }
      const raw = fs.readFileSync(abs, "utf8");
      if (raw.includes("\u0000")) return { ok: false, content: "这是二进制文件，已跳过" };
      const lines = raw.split(/\r?\n/);
      const offset = Math.max(1, num(args, "offset", 1));
      const limit = Math.min(4000, num(args, "limit", 800));
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const width = String(offset + slice.length - 1).length;
      const body = slice.map((l, i) => `${String(offset + i).padStart(width, " ")}| ${l}`).join("\n");
      const tail = offset - 1 + slice.length < lines.length ? `\n…共 ${lines.length} 行，已读到第 ${offset - 1 + slice.length} 行` : "";
      return { ok: true, content: `${body}${tail}` };
    },
  };

  const writeFile: Tool = {
    name: "write_file",
    effects: ["write"],
    description: "写入（覆盖）工作区内的文件，自动创建父目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    async run(args): Promise<ToolResult> {
      const abs = resolveWrite(policy, str(args, "path"));
      const content = typeof args.content === "string" ? args.content : str(args, "content");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      // 基准必须也用 realpath：Windows 上 TMP 常是 8.3 短名（ADMINI~1），
      // 而 realpathLoose 返回长名，直接 path.relative 会算出一串 ../..，
      // 模型看到的是「已写入 ..\..\..\Administrator\...」这种没有意义的东西
      return { ok: true, content: `已写入 ${path.relative(realpathLoose(policy.workspace), abs)}（${content.length} 字符）` };
    },
  };

  const editFile: Tool = {
    name: "edit_file",
    effects: ["write"],
    description: "精确替换文件中的一段文本。old_string 必须在文件中唯一，否则请加长上下文或使用 replace_all。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
    async run(args): Promise<ToolResult> {
      const abs = resolveWrite(policy, str(args, "path"));
      const oldStr = str(args, "old_string");
      const newStr = typeof args.new_string === "string" ? args.new_string : str(args, "new_string");
      const all = args.replace_all === true;
      const raw = fs.readFileSync(abs, "utf8");
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return { ok: false, content: "未找到要替换的内容，请先 read_file 确认原文" };
      if (count > 1 && !all) {
        return { ok: false, content: `匹配到 ${count} 处，请加长 old_string 使其唯一，或设置 replace_all` };
      }
      const next = all ? raw.split(oldStr).join(newStr) : raw.replace(oldStr, newStr);
      fs.writeFileSync(abs, next, "utf8");
      return { ok: true, content: `已替换 ${all ? count : 1} 处` };
    },
  };

  const listDir: Tool = {
    name: "list_dir",
    effects: ["read"],
    description: "列出目录内容，目录名带斜杠后缀。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "默认工作区根目录" },
        depth: { type: "number", description: "递归深度，默认 1" },
      },
    },
    async run(args): Promise<ToolResult> {
      const rel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
      const abs = resolveRead(policy, rel);
      const depth = Math.min(4, Math.max(1, num(args, "depth", 1)));
      const root = realpathLoose(policy.workspace);
      // 「目录不存在」不能报成「空目录」：walk 会把 ENOENT 吞掉，
      // 于是路径写错 / 工作区选错的模型得到的是「这里什么都没有」，
      // 它会据此判断任务没得做，然后收工。真机端到端就是这么挂的。
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        return { ok: false, content: `目录不存在：${rel}（工作区根目录用 "." 或留空）` };
      }
      if (!stat.isDirectory()) {
        return { ok: false, content: `不是目录：${rel}（读文件用 read_file）` };
      }
      const out: string[] = [];
      for (const full of walk(abs, depth - 1)) {
        if (!isInside(root, realpathLoose(full))) continue;
        const show = path.relative(abs, full).split(path.sep).join("/");
        const isDir = fs.statSync(full).isDirectory();
        out.push(show + (isDir ? "/" : ""));
        if (out.length >= 400) {
          out.push("…（条目过多，已截断）");
          break;
        }
      }
      return { ok: true, content: out.length ? out.join("\n") : "（空目录）" };
    },
  };

  const glob: Tool = {
    name: "glob",
    effects: ["read"],
    description: "按通配符查找文件，支持 * 和 **，例如 **/*.test.ts。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        limit: { type: "number" },
      },
      required: ["pattern"],
    },
    async run(args, ctx): Promise<ToolResult> {
      const pattern = str(args, "pattern");
      const re = globToRegExp(pattern);
      const limit = Math.min(500, num(args, "limit", 100));
      const root = realpathLoose(ctx.workspace);
      const hits: string[] = [];
      for (const full of walk(root, 12)) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        let isDir = false;
        try {
          isDir = fs.statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) continue;
        if (re.test(rel) || re.test(path.basename(rel))) hits.push(rel);
        if (hits.length >= limit) break;
      }
      return { ok: true, content: hits.length ? hits.join("\n") : "没有匹配的文件" };
    },
  };

  const grep: Tool = {
    name: "grep",
    effects: ["read"],
    description: "在工作区内按正则搜索文本，返回文件:行号:内容。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string", description: "搜索目录，默认工作区" },
        glob: { type: "string", description: "只搜匹配的文件，例如 **/*.ts" },
        limit: { type: "number" },
      },
      required: ["pattern"],
    },
    async run(args, ctx): Promise<ToolResult> {
      const src = str(args, "pattern");
      let re: RegExp;
      try {
        re = new RegExp(src, "i");
      } catch {
        return { ok: false, content: "正则表达式非法" };
      }
      const filter = typeof args.glob === "string" && args.glob ? globToRegExp(args.glob) : null;
      const start = resolveRead(policy, typeof args.path === "string" && args.path ? args.path : ".");
      const limit = Math.min(300, num(args, "limit", 60));
      const root = realpathLoose(ctx.workspace);
      const out: string[] = [];

      for (const full of walk(start, 12)) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size > 512 * 1024) continue;
        if (filter && !filter.test(rel) && !filter.test(path.basename(rel))) continue;
        let text: string;
        try {
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        if (text.includes("\u0000")) continue;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
            if (out.length >= limit) return { ok: true, content: out.join("\n") + "\n…已达上限" };
          }
        }
      }
      return { ok: true, content: out.length ? out.join("\n") : "没有匹配" };
    },
  };

  const bash: Tool = {
    name: "bash",
    effects: ["exec", "write"],
    description: "执行 shell 命令（Windows 上走 PowerShell）。输出超过上限会截断，长任务请自己加超时。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number", description: "默认 120000，最大 600000" },
      },
      required: ["command"],
    },
    async run(args, ctx): Promise<ToolResult> {
      const command = str(args, "command");
      guardCommand(command);
      const timeoutMs = Math.min(600_000, Math.max(1000, num(args, "timeout_ms", 120_000)));
      const res = await ctx.exec(command, ctx.workspace, { timeoutMs, signal: ctx.signal });
      const merged = [res.stdout.trim(), res.stderr.trim()].filter(Boolean).join("\n");
      const head = `退出码 ${res.exitCode}${res.timedOut ? "（超时）" : ""}`;
      return { ok: res.exitCode === 0, content: `${head}\n${redact(merged) || "（无输出）"}` };
    },
  };

  return [readFile, writeFile, editFile, listDir, glob, grep, bash];
}

/** 权限档对应的工具集合；顺序与累进语义一致，写错方向会变成「多给权限」 */
export function filterByPerms(tools: Tool[], perms: Perms): Tool[] {
  const writable = new Set(["write_file", "edit_file"]);
  const execable = new Set(["bash"]);
  if (perms === "read") return tools.filter((t) => !writable.has(t.name) && !execable.has(t.name));
  if (perms === "write") return tools.filter((t) => !execable.has(t.name));
  return tools;
}

export { preview };
