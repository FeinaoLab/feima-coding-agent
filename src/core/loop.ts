/**
 * Agent 双循环。
 *
 * 内层：推进「模型 → 工具 → 模型」，同时消化用户插话（steering）。
 * 外层：内层自然收敛后，检查追加任务队列（follow-up），有则再来一轮。
 *
 * 两条来自实战的铁律：
 * 1. 结束状态只看 isStreaming，不看事件。收到结束类事件之后仍可能发生重试或上下文压缩，
 *    见事件就熄灯，用户会看到“答完了”然后界面又跳起来。
 * 2. 并发标志位必须在第一个 await 之前置好，否则同一 tick 的第二次发送会读到旧值，
 *    被当成普通 prompt 而不是插话。
 */

import type {
  AgentEvent,
  AgentSnapshot,
  AgentState,
  ChatMessage,
  ConfirmRequest,
  ExecFn,
  LoopRecord,
  Provider,
  Tool,
  ToolCall,
  ToolSchema,
  Usage,
} from "../types.ts";
import { PolicyError, redact } from "../safety/policy.ts";
import { ToolCallAssembler } from "../providers/openai.ts";
import { preview } from "../tools/builtin.ts";
import {
  compactIfNeeded,
  estimateMessages,
  makeSummarizer,
  type CompactConfig,
} from "./compact.ts";

const TRUNCATED_NOTE =
  "错误：上一次输出达到长度上限，工具参数可能被截断，本次调用未执行。请缩短参数（例如分次写入或减少改动量）后重新调用。";

const TRUNCATED_EMPTY_NOTE =
  "错误：上一次输出达到长度上限，既没有正文也没有工具调用（推理型模型常把 token 全花在思考上）。" +
  "请直接开始执行，不要长篇推理；如果任务较大，先做第一步。";

export type LoopOutcome = "done" | "aborted" | "error";

export interface LoopOptions {
  provider: Provider;
  model: string;
  tools: Tool[];
  systemPrompt: string;
  workspace: string;
  exec: ExecFn;
  maxTurns?: number;
  maxTokens?: number;
  temperature?: number;
  onEvent?: (event: AgentEvent) => void;
  /** 上下文压缩策略；不传则永不压缩 */
  compaction?: CompactConfig;
  /** 外部动作的确认闸门。不传时 MCP 之类的外部工具会按「无人确认」拒绝执行 */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /** 消息流钩子：会话落盘、审计、GUI 历史同步都接这里 */
  onRecord?: (record: LoopRecord) => void;
}

export class AgentLoop {
  private opts: LoopOptions;
  private messages: ChatMessage[] = [];
  private state: AgentState = "idle";
  private busy = false;
  private steering: string[] = [];
  private followUps: string[] = [];
  private turns = 0;
  private compactions = 0;
  private controller: AbortController | null = null;
  private lastUsage: Usage | null = null;

  constructor(opts: LoopOptions) {
    this.opts = opts;
    this.messages.push({ role: "system", content: opts.systemPrompt });
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  private emitStatus(): void {
    this.emit({
      type: "status",
      state: this.state,
      pendingFeedback: this.steering.length,
      queued: this.followUps.length,
    });
  }

  /**
   * 所有消息写入的统一出口。
   * 直接 push 数组会漏掉落盘——历史里少一条，恢复出来的会话就是断的。
   */
  private push(message: ChatMessage): void {
    this.messages.push(message);
    this.opts.onRecord?.({ kind: "message", message });
  }

  /** 替换事件处理器（CLI / RPC / GUI 各自接自己的出口） */
  setEventHandler(fn: (event: AgentEvent) => void): void {
    this.opts.onEvent = fn;
  }

  /**
   * 装/卸确认闸门。
   * 交互模式在 readline 就绪之后才能问，而 loop 在 buildRuntime 里就建好了，
   * 所以留一个后置入口；不装 = 无人确认，MCP 工具会自行拒绝。
   */
  setConfirm(fn: ((req: ConfirmRequest) => Promise<boolean>) | undefined): void {
    this.opts.confirm = fn;
  }

  getSnapshot(): AgentSnapshot {
    return {
      // 权威状态位：UI 只信这个
      isStreaming: this.state === "chatting",
      state: this.state,
      pendingFeedback: this.steering.length,
      queued: this.followUps.length,
      turns: this.turns,
      messages: this.messages.length,
      contextTokens: estimateMessages(this.messages),
      compactions: this.compactions,
    };
  }

  getHistory(): ChatMessage[] {
    return this.messages.slice();
  }

  getUsage(): Usage | null {
    return this.lastUsage;
  }

  /** 追加一条插话：模型下一轮请求前会看到它 */
  steer(text: string): void {
    this.steering.push(text);
    this.emitStatus();
  }

  /** 排队一条后续任务：当前任务自然结束后继续 */
  queue(text: string): void {
    this.followUps.push(text);
    this.emitStatus();
  }

  abort(): void {
    this.controller?.abort();
  }

  reset(): void {
    this.messages = [{ role: "system", content: this.opts.systemPrompt }];
    this.steering = [];
    this.followUps = [];
    this.turns = 0;
    this.compactions = 0;
    this.opts.onRecord?.({ kind: "reset" });
    this.emitStatus();
  }

  /**
   * 从持久化历史恢复。
   * 系统提示用当前配置重新生成：恢复旧会话时系统提示可能已经改过（比如工作区变了），
   * 继续用旧的等于把过期约束带回来。
   */
  restore(messages: ChatMessage[]): number {
    const body = messages.filter((m, i) => !(i === 0 && m.role === "system"));
    this.messages = [{ role: "system", content: this.opts.systemPrompt }, ...body];
    this.emitStatus();
    return body.length;
  }

  async submit(input: string): Promise<LoopOutcome> {
    // 置位必须在第一个 await 之前完成
    const steer = this.state === "chatting" || this.busy;
    if (steer) {
      this.steer(input);
      return "done";
    }

    this.busy = true;
    this.state = "chatting";
    this.emitStatus();
    this.push({ role: "user", content: input });

    let outcome: LoopOutcome = "done";
    try {
      outcome = await this.run();
    } finally {
      this.busy = false;
      this.state = "idle";
      // 先落状态，再宣告结束：宣告时 isStreaming 必须已经是 false
      this.emit({ type: "agent_settled" });
      this.emitStatus();
    }
    return outcome;
  }

  private async run(): Promise<LoopOutcome> {
    while (true) {
      const outcome = await this.inner();
      this.emit({ type: "turn_end", turn: this.turns });
      if (outcome !== "done") return outcome;

      const next = this.followUps.shift();
      if (!next) return "done";
      this.push({ role: "user", content: next });
      this.emitStatus();
    }
  }

  private drainSteering(): void {
    while (this.steering.length) {
      const text = this.steering.shift();
      if (text) this.push({ role: "user", content: text });
    }
  }

  /**
   * 每轮请求前检查上下文。
   * 放在 drainSteering 之后：刚插进来的指令必须留在保留区里，
   * 否则会出现「用户刚说的事被摘要吃掉」这种最让人恼火的情况。
   */
  private async maybeCompact(force = false): Promise<void> {
    if (!this.opts.compaction) return;

    const base = this.opts.compaction;
    const result = await compactIfNeeded(this.messages, {
      // 手动 /compact 时把预算压到 0，让「有内容就折」成立
      ...base,
      budget: force ? 0 : base.budget,
      summarize: base.summarize ?? makeSummarizer(this.opts.provider, this.opts.model),
    });
    if (!result.compacted) return;

    this.messages = result.messages;
    this.compactions++;
    this.emit({
      type: "compact",
      before: result.before,
      after: result.after,
      folded: result.folded,
    });
    this.opts.onRecord?.({
      kind: "compact",
      before: result.before,
      after: result.after,
      folded: result.folded,
    });
  }

  /** 手动压缩：交互里 /compact 用 */
  async compactNow(): Promise<void> {
    await this.maybeCompact(true);
  }

  private async inner(): Promise<LoopOutcome> {
    const maxRounds = this.opts.maxTurns ?? 40;
    let rounds = 0;
    let emptyTruncations = 0;

    while (rounds < maxRounds) {
      rounds++;
      this.turns++;
      this.drainSteering();
      await this.maybeCompact();

      const res = await this.streamOnce();
      if (res.kind === "aborted") {
        this.emit({ type: "aborted" });
        return "aborted";
      }
      if (res.kind === "error") {
        this.emit({ type: "error", message: res.message, retryable: res.retryable });
        return "error";
      }

      this.push(res.message);
      const calls = res.message.tool_calls ?? [];

      if (!calls.length) {
        // 输出被长度上限截断且什么都没产出（推理型模型把额度全花在 reasoning 上）：
        // 直接当成"完成"会让 Agent 一句话不说就收工，用户以为它干完了，其实什么都没做。
        if (res.finish === "length") {
          emptyTruncations++;
          if (emptyTruncations > 2) {
            this.emit({
              type: "error",
              message: `连续 ${emptyTruncations} 次输出被长度上限截断且没有产生任何内容或工具调用，请调大 maxTokens（当前 ${this.opts.maxTokens ?? "默认"}）`,
              retryable: false,
            });
            return "error";
          }
          this.push({ role: "user", content: TRUNCATED_EMPTY_NOTE });
          continue;
        }
        // 没有工具调用：只有没有待处理插话时才算这一轮结束
        if (this.steering.length) continue;
        return "done";
      }

      if (res.finish === "length") {
        // 参数可能被截断，执行会得到半截命令，宁可让模型重发
        for (const call of calls) {
          this.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: TRUNCATED_NOTE,
          });
        }
        continue;
      }

      for (const call of calls) {
        const content = await this.runTool(call);
        this.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
      }

      if (this.steering.length) continue;
    }

    this.emit({ type: "error", message: `已达单轮上限 ${maxRounds} 次工具调用，提前收敛`, retryable: false });
    return "error";
  }

  private async streamOnce(): Promise<
    | { kind: "ok"; message: ChatMessage; finish?: string }
    | { kind: "aborted" }
    | { kind: "error"; message: string; retryable: boolean }
  > {
    const assembler = new ToolCallAssembler();
    let text = "";
    let finish: string | undefined;
    const controller = new AbortController();
    this.controller = controller;

    const schemas: ToolSchema[] = this.opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    try {
      for await (const evt of this.opts.provider.stream({
        // 传副本：上游实现若顺手 push 了消息，不该污染我们的历史
        messages: this.messages.slice(),
        tools: schemas,
        model: this.opts.model,
        temperature: this.opts.temperature,
        maxTokens: this.opts.maxTokens,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return { kind: "aborted" };
        if (evt.text) {
          text += evt.text;
          this.emit({ type: "text_delta", text: evt.text });
        }
        if (evt.reasoning) this.emit({ type: "reasoning_delta", text: evt.reasoning });
        if (evt.toolCall) assembler.feed(evt.toolCall);
        if (evt.finish) finish = evt.finish;
        if (evt.usage) {
          this.lastUsage = evt.usage;
          this.emit({ type: "usage", usage: evt.usage });
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return { kind: "aborted" };
      const retryable = Boolean((err as { retryable?: boolean })?.retryable ?? true);
      const message = redact(err instanceof Error ? err.message : String(err));
      return { kind: "error", message, retryable };
    } finally {
      this.controller = null;
    }

    const calls = assembler.list();
    const message: ChatMessage = {
      role: "assistant",
      content: text.length ? text : null,
      ...(calls.length ? { tool_calls: calls } : {}),
    };
    return { kind: "ok", message, finish };
  }

  private async runTool(call: ToolCall): Promise<string> {
    const tool = this.opts.tools.find((t) => t.name === call.name);
    if (!tool) {
      return `错误：不存在名为 ${call.name} 的工具，可用工具：${this.opts.tools.map((t) => t.name).join(", ")}`;
    }

    let args: Record<string, unknown>;
    try {
      const parsed = call.arguments ? JSON.parse(call.arguments) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("参数必须是对象");
      args = parsed as Record<string, unknown>;
    } catch {
      return `错误：工具参数不是合法 JSON，可能被截断。原始片段：${call.arguments.slice(0, 300)}`;
    }

    this.emit({ type: "tool_start", id: call.id, name: call.name, args: call.arguments });

    try {
      const result = await tool.run(args, {
        workspace: this.opts.workspace,
        exec: this.opts.exec,
        signal: this.controller?.signal,
        onProgress: (t) => this.emit({ type: "text_delta", text: t }),
        ...(this.opts.confirm ? { confirm: this.opts.confirm } : {}),
      });
      this.emit({
        type: "tool_end",
        id: call.id,
        name: call.name,
        ok: result.ok,
        preview: preview(result.content),
      });
      return result.ok ? result.content : `错误：${result.content}`;
    } catch (err) {
      const message =
        err instanceof PolicyError
          ? err.message
          : redact(err instanceof Error ? err.message : String(err));
      this.emit({ type: "tool_end", id: call.id, name: call.name, ok: false, preview: preview(message) });
      return `错误：${message}`;
    }
  }
}
