/**
 * 模型接入层：任何 OpenAI 兼容端点都能用。
 *
 * 几个刻意的选择：
 * - SSE 自己切 `\n`，不用 readline。流里可能夹着超长行，readline 的缓冲语义会让
 *   工具调用参数错位（Pi 的 rpc-host 里就写着同样一句警告）。
 * - 只做流式。非流式接口看着简单，但拿不到首字延迟，也没法做插话。
 * - 报错统一脱敏后再抛出，上游 SDK 的报错经常带原始请求头。
 */

import type { ChatMessage, Provider, ProviderEvent, StreamRequest, ToolCall, Usage } from "../types.ts";
import { redact } from "../safety/policy.ts";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  label?: string;
  headers?: Record<string, string>;
}

export class ProviderError extends Error {
  retryable: boolean;
  status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(redact(message));
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
  }
}

function toWire(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    const base: Record<string, unknown> = { role: m.role };
    if (m.role === "tool") {
      base.content = m.content ?? "";
      base.tool_call_id = m.tool_call_id;
      return base;
    }
    base.content = m.content ?? "";
    if (m.tool_calls?.length) {
      base.tool_calls = m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      }));
    }
    return base;
  });
}

export function createOpenAIProvider(cfg: ProviderConfig): Provider {
  const endpoint = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  return {
    name: cfg.label ?? "openai-compatible",
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
      const body: Record<string, unknown> = {
        model: req.model,
        messages: toWire(req.messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.tools.length) {
        body.tools = req.tools;
        body.tool_choice = "auto";
      }
      if (typeof req.temperature === "number") body.temperature = req.temperature;
      if (typeof req.maxTokens === "number") body.max_tokens = req.maxTokens;

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey}`,
            ...(cfg.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: req.signal,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new ProviderError(`连接模型服务失败：${msg}`, true);
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderError(`模型服务返回 ${res.status}：${text.slice(0, 500)}`, retryable, res.status);
      }
      if (!res.body) throw new ProviderError("模型服务没有返回流式响应体", false);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // 只在 \n 上切；\r 交给 trim 处理
          let idx = buffer.indexOf("\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.startsWith("data:")) {
              const payload = line.slice(5).trim();
              if (payload && payload !== "[DONE]") {
                const evt = parseChunk(payload);
                if (evt) yield evt;
              }
            }
            idx = buffer.indexOf("\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function parseChunk(payload: string): ProviderEvent | null {
  let json: any;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  if (json.error) {
    throw new ProviderError(`模型服务错误：${json.error.message ?? JSON.stringify(json.error)}`, true);
  }
  const choice = json.choices?.[0];
  const evt: ProviderEvent = {};
  const delta = choice?.delta ?? {};
  if (typeof delta.content === "string" && delta.content.length) evt.text = delta.content;
  const reasoning = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoning === "string" && reasoning.length) evt.reasoning = reasoning;

  const calls = delta.tool_calls;
  if (Array.isArray(calls)) {
    for (const c of calls) {
      evt.toolCall = {
        index: typeof c.index === "number" ? c.index : 0,
        id: c.id,
        name: c.function?.name,
        args: c.function?.arguments,
      };
    }
  }
  if (typeof choice?.finish_reason === "string") evt.finish = choice.finish_reason;
  if (json.usage) {
    const u = json.usage as Usage;
    evt.usage = {
      prompt_tokens: u.prompt_tokens ?? 0,
      completion_tokens: u.completion_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
    };
  }
  return Object.keys(evt).length ? evt : null;
}

/** 把流式片段拼成一条 assistant 消息；截断的参数照样交给上层判定 */
export class ToolCallAssembler {
  private map = new Map<number, ToolCall>();

  feed(delta: { index: number; id?: string; name?: string; args?: string }): void {
    const cur = this.map.get(delta.index) ?? { id: "", name: "", arguments: "" };
    if (delta.id) cur.id = delta.id;
    if (delta.name) cur.name = cur.name ? cur.name : delta.name;
    if (delta.args) cur.arguments += delta.args;
    this.map.set(delta.index, cur);
  }

  list(): ToolCall[] {
    return [...this.map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, c]) => ({
        id: c.id || `call_${idx}`,
        name: c.name,
        arguments: c.arguments,
      }));
  }
}
