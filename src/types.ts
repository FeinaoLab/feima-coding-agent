/**
 * 公共类型定义。
 *
 * 约定：只放 type / interface，不放运行时代码——Node 的类型擦除只删类型，
 * 一旦这里出现 enum 或带副作用的常量，运行时会直接炸。
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串，可能被上游截断，执行前必须校验 */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

/** 命令执行器：沙盒策略最终都收敛到这一层 */
export type ExecFn = (
  command: string,
  cwd: string,
  options?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

export interface ToolContext {
  workspace: string;
  exec: ExecFn;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export type AgentState = "idle" | "chatting";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; preview: string }
  | { type: "usage"; usage: Usage }
  | { type: "turn_end"; turn: number }
  | { type: "agent_settled" }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "aborted" }
  | { type: "status"; state: AgentState; pendingFeedback: number; queued: number };

export interface AgentSnapshot {
  state: AgentState;
  /** 唯一的权威状态位：UI 只该信它，不该信事件 */
  isStreaming: boolean;
  pendingFeedback: number;
  queued: number;
  turns: number;
  messages: number;
}

export interface ProviderEvent {
  text?: string;
  reasoning?: string;
  /** 流式拼装中的工具调用片段 */
  toolCall?: { index: number; id?: string; name?: string; args?: string };
  finish?: string;
  usage?: Usage;
}

export interface StreamRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void>;
}
