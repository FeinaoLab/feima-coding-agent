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
  /**
   * 外部动作的确认闸门。不传等于「没有人工在场」——必须按拒绝处理，
   * 不能默认放行：MCP 工具跑在飞码的策略层之外，凭据、网络、文件都可能是它自己管的。
   */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
}

export interface ConfirmRequest {
  /** 一句话说明要做什么，例如「执行 MCP 工具 github.create_issue」 */
  title: string;
  /** 细节：参数、影响范围、为什么需要确认 */
  detail: string;
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
  /** 上下文被折叠：before/after 是估算 token，folded 是被折叠的消息条数 */
  | { type: "compact"; before: number; after: number; folded: number }
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
  /** 上下文估算 token 与压缩次数，便于判断何时该开新会话 */
  contextTokens: number;
  compactions: number;
}

/** 消息流记录：会话落盘与 UI 订阅共用同一条通路，避免两边各写一遍导致不一致 */
export type LoopRecord =
  | { kind: "message"; message: ChatMessage }
  | { kind: "compact"; before: number; after: number; folded: number }
  | { kind: "reset" };

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
