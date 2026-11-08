/**
 * 确认闸门。
 *
 * 三层防线各管一段，混在一起就说不清「为什么被拒」：
 * 1. 策略层（policy）：管**越界**。路径出工作区、命令在黑名单里。直接拒，不问人。
 * 2. 确认闸门（本文件）：管**副作用**。写文件、执行命令、调外部工具——不越界，
 *    但用户可能不想让它现在发生。
 * 3. 沙盒层（safety/exec）：管**边界**。真隔离下命令根本出不去工作区。
 *
 * 一条硬规则：`external`（MCP 之类跑在策略层之外的工具）无论确认模式怎么设都必须问。
 * 用户关掉确认是「我知道这些工具能干什么」，不是「我允许一个我管不了的东西随便跑」。
 */

import type { Effect } from "../types.ts";
import { redact } from "./policy.ts";

export type ConfirmMode = "off" | "write" | "exec" | "external" | "all";

const MODES: ConfirmMode[] = ["off", "write", "exec", "external", "all"];

/** 解析命令行/环境变量给的模式；非法值返回 null 由调用方报错，不静默回落 */
export function parseConfirmMode(raw: string): ConfirmMode | null {
  const v = raw.trim().toLowerCase();
  return (MODES as string[]).includes(v) ? (v as ConfirmMode) : null;
}

/**
 * 这次工具调用要不要问人。
 *
 * write 与 exec 的关系是**包含**而不是并列：能执行命令就能写文件，
 * 所以 `--confirm exec` 把写文件也一起管住。反过来只开 write 挡不住 `bash` 写文件——
 * 这一点在文档里明说，不放宽成「看起来更全」的假象。
 */
export function needsConfirm(effects: Effect[] | undefined, mode: ConfirmMode): boolean {
  const list = effects ?? (["read"] as Effect[]);
  // 不在策略层内的东西，不能靠「用户关了确认」免除
  if (list.includes("external")) return true;
  switch (mode) {
    case "off":
      return false;
    case "external":
      // external 已在上面的硬规则里处理掉了，走到这里说明这次调用没有 external
      return false;
    case "write":
      return list.includes("write");
    case "exec":
      return list.includes("write") || list.includes("exec");
    case "all":
      // 与 exec 当前等价；留着是为了将来出现新副作用（比如 network）时能一次盖住
      return list.some((e) => e !== "read");
    default:
      return false;
  }
}

/** 参数摘要里的单值上限：确认框是给人看的，不是给日志看的 */
const FIELD_LIMIT = 160;

function oneLine(text: string, limit = FIELD_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 把工具参数压成能一眼看懂的一行摘要。
 *
 * 不直接 JSON.stringify：`write_file` 的 content 可能是几万字符，
 * 整段糊上去既看不清关键信息，也会把终端刷掉。
 * 也不直接透传：参数里可能带着 token，必须过 redact。
 */
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const pick = (...keys: string[]): string[] =>
    keys
      .filter((k) => args[k] !== undefined && args[k] !== null && asText(args[k]) !== "")
      .map((k) => `${k}: ${oneLine(asText(args[k]))}`);

  let parts: string[];
  switch (toolName) {
    case "write_file": {
      const content = asText(args.content);
      const lines = content ? content.split("\n").length : 0;
      parts = pick("path");
      parts.push(`content: ${content.length} 字符 / ${lines} 行`);
      break;
    }
    case "edit_file": {
      parts = pick("path");
      parts.push(`替换: ${oneLine(asText(args.old_string), 60)} → ${oneLine(asText(args.new_string), 60)}`);
      if (args.replace_all === true) parts.push("replace_all");
      break;
    }
    case "bash":
      parts = pick("command", "timeout_ms");
      break;
    default:
      parts = Object.keys(args)
        .filter((k) => args[k] !== undefined)
        .map((k) => `${k}: ${oneLine(asText(args[k]))}`);
  }

  const body = parts.length ? parts.join("；") : "（无参数）";
  return redact(body);
}

/** 确认框的标题：动词 + 目标，尽量让人不看参数就知道要发生什么 */
export function confirmTitle(toolName: string, effects: Effect[] | undefined): string {
  if (effects?.includes("external")) return `调用外部工具 ${toolName}`;
  switch (toolName) {
    case "bash":
      return "执行命令";
    case "write_file":
      return "写文件";
    case "edit_file":
      return "改文件";
    default:
      return `执行工具 ${toolName}`;
  }
}
