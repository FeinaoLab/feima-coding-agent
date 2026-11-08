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
  ExecFn,
  Provider,
  Tool,
  ToolCall,
  ToolSchema,
  Usage,
} from "../types.ts";
import { PolicyError, redact } from "../safety/policy.ts";
import { ToolCallAssembler } from "../providers/openai.ts";
import { preview } from "../tools/builtin.ts";

const TRUNCATED_NOTE =
  "错误：上一次输出达到长度上限，工具参数可能被截断，本次调用未执行。请缩短参数（例如分次写入或减少改动量）后重新调用。";

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
}

export class AgentLoop {
  private opts: LoopOptions;
  private messages: ChatMessage[] = [];
  private state: AgentState = "idle";
  private busy = false;
  private steering: string[] = [];
  private followUps: string[] = [];
  private turns = 0;
  private controller: AbortController | null = null;
  private lastUsage: Usage | null = null;

  constructor(opts: LoopOptions) {
    this.opts = opts;
    this.messages.push({ role: "system", content: opts.systemPrompt });
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  /** 替换事件处理器（CLI / RPC / GUI 各自接自己的出口） */
  setEventHandler(fn: (event: AgentEvent) => void): void {
    this.opts.onEvent = fn;
  }

  private emitStatus(): void {
    this.emit({
      type: "status",
      state: this.state,
      pendingFeedback: this.steering.length,
      queued: this.followUps.length,
    });
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
    this.emitStatus();
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
    this.messages.push({ role: "user", content: input });

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
      this.messages.push({ role: "user", content: next });
      this.emitStatus();
    }
  }

  private drainSteering(): void {
    while (this.steering.length) {
      const text = this.steering.shift();
      if (text) this.messages.push({ role: "user", content: text });
    }
  }

  private async inner(): Promise<LoopOutcome> {
    const maxRounds = this.opts.maxTurns ?? 40;
    let rounds = 0;

    while (rounds < maxRounds) {
      rounds++;
      this.turns++;
      this.drainSteering();

      const res = await this.streamOnce();
      if (res.kind === "aborted") {
        this.emit({ type: "aborted" });
        return "aborted";
      }
      if (res.kind === "error") {
        this.emit({ type: "error", message: res.message, retryable: res.retryable });
        return "error";
      }

      this.messages.push(res.message);
      const calls = res.message.tool_calls ?? [];

      if (!calls.length) {
        // 没有工具调用：只有没有待处理插话时才算这一轮结束
        if (this.steering.length) continue;
        return "done";
      }

      if (res.finish === "length") {
        // 参数可能被截断，执行会得到半截命令，宁可让模型重发
        for (const call of calls) {
          this.messages.push({
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
        this.messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content });
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
