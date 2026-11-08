/**
 * 把 MCP 工具包装成飞码的 Tool。
 *
 * 核心约束只有一条：**MCP 工具默认不可用，用了也要逐次确认。**
 *
 * 理由不是"多疑"，而是能力边界不同：内置工具跑在策略层 + 沙盒里，读写都被
 * 约束在工作区；MCP 工具是外部进程，它自己拿什么凭据、能访问什么、会不会
 * 把数据发到外网，飞码一概不知道。默认打开等于把安全边界剪出一个洞。
 */

import { McpClient, type McpConfig, type McpServerConfig, type McpToolInfo } from "./client.ts";
import { redact } from "../safety/policy.ts";
import type { Tool, ToolContext, ToolResult } from "../types.ts";

/** OpenAI 的函数名约束：^[a-zA-Z0-9_-]{1,64}$ */
const NAME_MAX = 64;

export function mcpToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const head = `mcp__${clean(server)}__`;
  return head + clean(tool).slice(0, Math.max(1, NAME_MAX - head.length));
}

/** 允许列表：支持精确名 `mcp__srv__tool`、`srv.tool`、`srv` 整台服务器、`*` */
export function isMcpAllowed(name: string, allow: string[] | undefined): boolean {
  if (!allow || !allow.length) return false;
  const low = name.toLowerCase();
  for (const raw of allow) {
    const item = raw.trim().toLowerCase();
    if (!item) continue;
    if (item === "*") return true;
    const dotted = item.replace(/\./g, "__").replace(/^mcp__/, "");
    if (low === item || low === `mcp__${dotted}`) return true;
    // 只写服务器名：放行这台服务器上的全部工具
    if (low.startsWith(`mcp__${dotted}__`)) return true;
  }
  return false;
}

export interface McpToolLoadOptions {
  config: McpConfig;
  /** 非交互模式下允许的工具；空则全部拒绝 */
  allow?: string[];
  /** 注入用：便于用例替换 spawn 出来的客户端 */
  makeClient?: (server: string, cfg: McpServerConfig) => McpClient;
}

export interface McpLoadResult {
  tools: Tool[];
  notes: string[];
  clients: McpClient[];
}

function argsPreview(args: Record<string, unknown>, limit = 300): string {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = "（参数无法序列化）";
  }
  text = redact(text);
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

export function wrapMcpTool(client: McpClient, server: string, info: McpToolInfo, allow: string[] | undefined): Tool {
  const name = mcpToolName(server, info.name);
  return {
    name,
    // external 是「无论确认模式怎么设都必须问」的那一档；
    // selfConfirmed 表示文案由这里给——只有它知道要说明「跑在策略层之外」
    effects: ["external"],
    selfConfirmed: true,
    description: `[MCP ${server}] ${info.description || info.name}（外部工具，每次调用都需要确认）`,
    parameters: info.inputSchema,
    async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const preApproved = isMcpAllowed(name, allow);
      if (!preApproved) {
        if (!ctx.confirm) {
          return {
            ok: false,
            content:
              `未执行：MCP 工具 ${name} 需要人工确认，但当前是非交互模式（没有可用的确认入口）。` +
              `如确需使用，请用 --mcp-allow ${name} 显式放行。不要重试本次调用。`,
          };
        }
        let approved = false;
        try {
          approved = await ctx.confirm({
            title: `执行 MCP 工具 ${server}.${info.name}`,
            detail: `参数：${argsPreview(args)}\n这台工具由外部进程 ${server} 提供，不在飞码的沙盒与策略层内。`,
          });
        } catch {
          approved = false;
        }
        if (!approved) {
          return { ok: false, content: `用户拒绝了 MCP 工具 ${name} 的本次调用。不要重试，换个方案或询问用户。` };
        }
      }

      try {
        const result = await client.callTool(info.name, args);
        const text = result.text || "（工具没有返回文本内容）";
        return { ok: result.ok, content: redact(text) };
      } catch (err) {
        return { ok: false, content: redact(err instanceof Error ? err.message : String(err)) };
      }
    },
  };
}

export async function loadMcpTools(opts: McpToolLoadOptions): Promise<McpLoadResult> {
  const tools: Tool[] = [];
  const notes: string[] = [];
  const clients: McpClient[] = [];
  const make = opts.makeClient ?? ((server: string, cfg: McpServerConfig) => new McpClient(server, cfg));

  for (const [server, cfg] of Object.entries(opts.config.servers)) {
    const client = make(server, cfg);
    try {
      await client.start();
      const list = await client.listTools();
      for (const info of list) tools.push(wrapMcpTool(client, server, info, opts.allow));
      clients.push(client);
      notes.push(`${server}：${list.length} 个工具${client.noiseLines ? `（服务端向 stdout 打了 ${client.noiseLines} 行非协议内容，已忽略）` : ""}`);
    } catch (err) {
      // 一台服务器起不来不能拖死整个进程：其余工具照常可用，doctor 会报这台的原因
      const msg = redact(err instanceof Error ? err.message : String(err));
      notes.push(`${server}：不可用 —— ${msg}`);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }
  return { tools, notes, clients };
}
