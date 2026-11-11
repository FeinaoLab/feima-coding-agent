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

/**
 * 工具的能力标签。
 *
 * 用「副作用」而不是「危险等级」来描述：等级要靠人判，副作用是事实。
 * `external` 是唯一一个特殊项——它是唯一一项无论确认模式怎么设都必须问的。
 */
export type Effect = "read" | "write" | "exec" | "external";

/** 权限档：累进。read 只读，write 加写文件，exec 加执行命令 */
export type Perms = "read" | "write" | "exec";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 不写视为只读：漏标只会更松，所以所有带副作用的工具都必须显式标出来 */
  effects?: Effect[];
  /**
   * 工具自己负责确认（而不是交给 loop 统一问）。
   *
   * 只有 MCP 这类需要解释「为什么这次调用特殊」的工具才用：
   * 确认文案要说明「它跑在策略层之外」，这句话只有工具自己知道。
   * 漏标不会导致少问一次，只会多问一次——所以默认是交给 loop。
   */
  selfConfirmed?: boolean;
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
  /** 模型往返一次（请求→回复）。toolCalls 是这一步要求调用的工具数，0 表示它在收尾 */
  | { type: "step"; index: number; toolCalls: number }
  /** 请求失败正在重试：只会在「本次尝试没产出任何东西」时出现 */
  | { type: "retry"; attempt: number; delayMs: number; message: string }
  /** 需要提醒用户但不算错误（例如无人工确认下放行了写操作） */
  | { type: "notice"; message: string }
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
