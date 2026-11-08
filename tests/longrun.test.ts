/**
 * 长任务连续性验证（v0.2 验收清单最后一项）。
 *
 * 单元测试验证的是「某一步对不对」，这里验证「连着跑 25 步还对不对」。
 * 长任务真正的失效方式不是抛错，而是历史被压缩得七零八落之后：
 * - assistant(tool_calls) 和 tool 结果对不上，上游 400；
 * - 摘要越叠越多，每压一次多一条，最后上下文比原文还长；
 * - 系统提示被卷进折叠区，Agent 悄悄换了行为准则。
 * 三条都不会抛异常，只会让模型开始胡言乱语，所以必须用结构断言兜住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentLoop } from "../src/core/loop.ts";
import { SessionStore } from "../src/core/session.ts";
import { SUMMARY_MARK, estimateMessages } from "../src/core/compact.ts";
import type { ChatMessage, ExecFn, Provider, ProviderEvent, StreamRequest, Tool } from "../src/types.ts";

const noExec: ExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

/** 结构不变量：任何时刻都要成立 */
function assertInvariants(messages: ChatMessage[], where: string): void {
  const systems = messages.filter((m) => m.role === "system");
  assert.equal(systems.length, 1, `${where}：系统提示必须恰好一条`);
  assert.equal(messages[0].role, "system", `${where}：系统提示必须在首位`);

  const summaries = messages.filter(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MARK),
  );
  assert.ok(summaries.length <= 1, `${where}：摘要消息最多一条，实际 ${summaries.length}`);

  // tool_call_id 配对：assistant 的每个调用都必须被紧随的 tool 消息应答，
  // 中间不允许插进别的角色——切分点切错就断在这里
  const pending = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      assert.equal(pending.size, 0, `${where}：上一条 tool_calls 还没应答完就来了新的 assistant`);
      for (const c of m.tool_calls) pending.add(c.id);
    } else if (m.role === "tool") {
      assert.ok(m.tool_call_id && pending.has(m.tool_call_id), `${where}：孤立 tool 消息 ${m.tool_call_id}`);
      pending.delete(m.tool_call_id);
    } else if (pending.size) {
      // 只剩「全部应答完」一种合法情况
      assert.fail(`${where}：${m.role} 消息插在 tool_calls 与 tool 结果之间`);
    }
  }
  assert.equal(pending.size, 0, `${where}：存在没有结果的 tool_calls`);
}

/** 25 轮工具调用的剧本：每次正式请求发一个 read，第 25 轮之后收敛 */
class LongProvider implements Provider {
  name = "fake";
  rounds = 0;
  summaryCalls = 0;
  snapshots: ChatMessage[][] = [];
  /** 摘要请求与正式请求各自的 token 估算，用来验证压缩真的生效 */
  tokens: number[] = [];

  total: number;

  // 类型擦除模式不支持 constructor 参数属性，只能显式赋值
  constructor(total: number) {
    this.total = total;
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    // 摘要请求不带工具 schema，据此区分，不依赖调用顺序
    if (!req.tools.length) {
      this.summaryCalls++;
      this.tokens.push(estimateMessages(req.messages));
      yield { text: `[摘要 ${this.summaryCalls}] 已完成第 ${this.rounds} 步，产物在 src/ 下，下一步继续读下一个文件。` };
      yield { finish: "stop" };
      return;
    }

    this.snapshots.push(req.messages.map((m) => ({ ...m })));
    this.tokens.push(estimateMessages(req.messages));
    this.rounds++;

    if (this.rounds <= this.total) {
      yield { toolCall: { index: 0, id: `call_${this.rounds}`, name: "read", args: JSON.stringify({ path: `src/f${this.rounds}.ts` }) } };
      yield { finish: "tool_calls" };
    } else {
      yield { text: "25 个文件都读完了，结论是版本号需要统一。" };
      yield { finish: "stop" };
    }
  }
}

function readTool(): Tool {
  return {
    name: "read",
    description: "读文件",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async run(args) {
      const body = `// ${String(args.path)}\n` + "export const value = 1; // 填充内容，用来把上下文顶到预算之上\n".repeat(12);
      return { ok: true, content: body };
    },
  };
}

test("长任务 25 轮工具调用跨多次压缩：配对不破、摘要不累积、系统提示不动", async () => {
  const provider = new LongProvider(25);
  const events: string[] = [];
  const loop = new AgentLoop({
    provider,
    model: "test-model",
    tools: [readTool()],
    workspace: process.cwd(),
    exec: noExec,
    systemPrompt: "你是飞码，行为准则：不写工作区之外的路径。",
    maxTurns: 40,
    compaction: { budget: 1500, keepRecentTurns: 2 },
  });
  loop.setEventHandler((e) => events.push(e.type));

  const outcome = await loop.submit("把 src 下 25 个文件都读一遍，最后告诉我结论");

  assert.equal(outcome, "done", "长任务必须自然收敛，不能撞上单轮上限");
  assert.equal(provider.rounds, 26, "25 次工具调用 + 1 次收尾");

  const snap = loop.getSnapshot();
  assert.ok(snap.compactions >= 3, `长任务期间应多次触发压缩，实际 ${snap.compactions}`);
  assert.equal(snap.turns, 26);

  // 每次请求前都检查一遍，越靠后越容易出问题
  provider.snapshots.forEach((msgs, i) => assertInvariants(msgs, `第 ${i + 1} 次请求`));
  assertInvariants(loop.getHistory(), "终态");

  const history = loop.getHistory();
  assert.ok(history.length < 60, `折叠后消息数应受控，实际 ${history.length}`);
  assert.ok(
    (history[0].content ?? "").includes("不写工作区之外的路径"),
    "系统提示必须原样保留，不能被摘要替换",
  );

  // 压缩不是只发生一次就退化：第一次和最后一次正式请求的上下文都要在预算附近，
  // 如果压缩失效，最后一次请求的 token 会一路涨到 25 轮的累积值
  const late = provider.tokens.slice(-2)[0];
  assert.ok(late < 4000, `末段请求上下文应受控，实际 ${late} tokens`);

  assert.ok(events.includes("compact"), "应发出 compact 事件");
  assert.ok(events.includes("agent_settled"));
});

test("长任务落盘后重新加载：历史不丢，能接着跑下一轮", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feima-long-"));
  try {
    const provider = new LongProvider(20);
    const store = SessionStore.create({ workspace: process.cwd(), model: "test-model" }, dir);
    const loop = new AgentLoop({
      provider,
      model: "test-model",
      tools: [readTool()],
      workspace: process.cwd(),
      exec: noExec,
      systemPrompt: "你是飞码。",
      maxTurns: 40,
      onRecord: (r) => {
        if (r.kind === "message") store.appendMessage(r.message);
        if (r.kind === "compact") store.appendCompact(r.before, r.after, r.folded);
      },
    });

    await loop.submit("读 20 个文件");
    assert.equal(provider.rounds, 21);

    const live = loop.getHistory();
    const loaded = store.load();
    assert.equal(loaded.broken, 0, "正常退出不该留下坏行");
    assert.equal(
      loaded.messages.length,
      live.length - 1,
      "落盘条数应与内存一致（system 不落盘，恢复时重建）",
    );
    assertInvariants(
      [{ role: "system", content: "你是飞码。" }, ...loaded.messages],
      "落盘历史",
    );

    // 模拟重启：新进程、新 loop，从磁盘恢复
    const reopened = SessionStore.open(store.id, dir);
    const again = new LongProvider(0);
    const resumed = new AgentLoop({
      provider: again,
      model: "test-model",
      tools: [readTool()],
      workspace: process.cwd(),
      exec: noExec,
      systemPrompt: "你是飞码。",
      maxTurns: 40,
    });
    const restored = resumed.restore(reopened.load().messages);
    assert.equal(restored, loaded.messages.length);

    const outcome = await resumed.submit("接着上一轮继续");
    assert.equal(outcome, "done");

    const sent = again.snapshots[0];
    assertInvariants(sent, "恢复后的首次请求");
    assert.ok(
      sent.filter((m) => m.role === "tool").length >= 1,
      "恢复后应带着上一轮的工具结果，否则模型会重头再读一遍",
    );
    assert.equal(sent.filter((m) => m.role === "system").length, 1);
    assert.equal(sent.at(-1)?.content, "接着上一轮继续");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("单轮工具调用超过 maxTurns 时报错收敛，而不是静默卡死", async () => {
  const provider = new LongProvider(99);
  const loop = new AgentLoop({
    provider,
    model: "test-model",
    tools: [readTool()],
    workspace: process.cwd(),
    exec: noExec,
    systemPrompt: "你是飞码。",
    maxTurns: 8,
  });
  const errors: string[] = [];
  loop.setEventHandler((e) => {
    if (e.type === "error") errors.push(e.message);
  });

  const outcome = await loop.submit("无限读文件");
  assert.equal(outcome, "error");
  assert.equal(provider.rounds, 8, "到上限就停，不多跑");
  assert.match(errors.join(), /单轮上限/);
  assert.equal(loop.getSnapshot().isStreaming, false, "报错后状态位必须复位");
});
