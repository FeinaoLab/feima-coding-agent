import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/core/loop.ts";
import type { AgentEvent, ExecFn, Provider, ProviderEvent, StreamRequest, Tool } from "../src/types.ts";

type Script = (req: StreamRequest) => AsyncGenerator<ProviderEvent, void, void>;

class FakeProvider implements Provider {
  name = "fake";
  requests: StreamRequest[] = [];
  private scripts: Script[];

  constructor(scripts: Script[]) {
    this.scripts = scripts;
  }

  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const script = this.scripts.shift();
    if (!script) throw new Error("没有更多剧本");
    yield* script(req);
  }
}

const noExec: ExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

function makeTool(name: string, run: (args: Record<string, unknown>) => Promise<string>): Tool & { calls: number } {
  const tool = {
    calls: 0,
    name,
    description: "测试工具",
    parameters: { type: "object", properties: {} },
    async run(args: Record<string, unknown>) {
      tool.calls++;
      return { ok: true, content: await run(args) };
    },
  };
  return tool;
}

function build(scripts: Script[], tools: Tool[]) {
  const provider = new FakeProvider(scripts);
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    provider,
    model: "test-model",
    tools,
    workspace: process.cwd(),
    exec: noExec,
    systemPrompt: "你是测试用 Agent",
    maxTurns: 10,
  });
  loop.setEventHandler((e) => events.push(e));
  return { provider, loop, events };
}

test("工具调用链：模型要工具 → 执行 → 再请求 → 收敛", async () => {
  const tool = makeTool("echo", async (args) => `已收到 ${String(args.x)}`);

  const scripts: Script[] = [
    async function* () {
      yield { text: "我先调用工具。" };
      yield { toolCall: { index: 0, id: "call_1", name: "echo", args: '{"x":' } };
      yield { toolCall: { index: 0, args: '1}' } };
      yield { finish: "tool_calls" };
    },
    async function* () {
      yield { text: "搞定了。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop, events } = build(scripts, [tool]);
  const outcome = await loop.submit("测试一下");

  assert.equal(outcome, "done");
  assert.equal(tool.calls, 1);
  assert.equal(provider.requests.length, 2);

  const second = provider.requests[1].messages;
  const toolMsg = second.find((m) => m.role === "tool");
  assert.ok(toolMsg, "第二轮请求里应带工具结果");
  assert.equal(toolMsg?.content, "已收到 1");

  const names = events.map((e) => e.type);
  assert.ok(names.includes("tool_start"));
  assert.ok(names.includes("tool_end"));
  assert.equal(loop.getSnapshot().isStreaming, false);
});

test("输出被长度截断时不执行工具，回灌错误让模型重发", async () => {
  const tool = makeTool("echo", async () => "不该被执行");

  const scripts: Script[] = [
    async function* () {
      yield { toolCall: { index: 0, id: "call_1", name: "echo", args: '{"x":"半截' } };
      yield { finish: "length" };
    },
    async function* () {
      yield { text: "我重新发一次。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop } = build(scripts, [tool]);
  await loop.submit("测试截断");

  assert.equal(tool.calls, 0, "截断的参数不能执行");
  const toolMsg = provider.requests[1].messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /长度上限/);
});

test("流式期间的插话进入下一轮上下文", async () => {
  let loopRef: AgentLoop | null = null;

  const scripts: Script[] = [
    async function* () {
      yield { text: "我正在写。" };
      loopRef?.steer("顺便把注释也补上");
      yield { finish: "stop" };
    },
    async function* () {
      yield { text: "注释补好了。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop } = build(scripts, []);
  loopRef = loop;
  await loop.submit("写个函数");

  assert.equal(provider.requests.length, 2, "有插话时应再请求一次");
  const users = provider.requests[1].messages.filter((m) => m.role === "user");
  assert.ok(users.some((m) => String(m.content).includes("注释")));
});

test("追加任务在自然结束后继续执行", async () => {
  let loopRef: AgentLoop | null = null;

  const scripts: Script[] = [
    async function* () {
      yield { text: "第一步完成。" };
      loopRef?.queue("再跑一下测试");
      yield { finish: "stop" };
    },
    async function* () {
      yield { text: "测试通过了。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop } = build(scripts, []);
  loopRef = loop;
  const outcome = await loop.submit("做第一步");

  assert.equal(outcome, "done");
  assert.equal(provider.requests.length, 2);
  const last = provider.requests[1].messages.at(-1);
  assert.equal(last?.content, "再跑一下测试");
});

test("并发提交：第二次自动变成插话，不另起一轮", async () => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });

  const scripts: Script[] = [
    async function* () {
      yield { text: "开始。" };
      await gate;
      yield { finish: "stop" };
    },
    async function* () {
      yield { text: "收到补充。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop } = build(scripts, []);
  const first = loop.submit("第一条");
  await new Promise((r) => setTimeout(r, 10));

  const snap = loop.getSnapshot();
  assert.equal(snap.isStreaming, true, "运行中状态位必须已置起");

  const second = await loop.submit("第二条");
  assert.equal(second, "done", "第二次提交应立即返回，作为插话排队");
  assert.equal(loop.getSnapshot().pendingFeedback, 1);

  release?.();
  await first;

  assert.equal(provider.requests.length, 2);
  const users = provider.requests[1].messages.filter((m) => m.role === "user");
  assert.ok(users.some((m) => m.content === "第二条"));
});

test("未知工具返回可读错误而不是崩溃", async () => {
  const scripts: Script[] = [
    async function* () {
      yield { toolCall: { index: 0, id: "c1", name: "rm_rf", args: "{}" } };
      yield { finish: "tool_calls" };
    },
    async function* () {
      yield { text: "好的，换个方式。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop } = build(scripts, []);
  await loop.submit("试试不存在的工具");
  const toolMsg = provider.requests[1].messages.find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /不存在名为 rm_rf 的工具/);
});

test("结束事件顺序：agent_settled 时 isStreaming 必须已为 false", async () => {
  const scripts: Script[] = [
    async function* () {
      yield { text: "收工。" };
      yield { finish: "stop" };
    },
  ];

  const { loop } = build(scripts, []);
  let streamingAtSettled: boolean | null = null;
  let settledCount = 0;

  const inner = loop;
  inner.setEventHandler((e) => {
    if (e.type === "agent_settled") {
      settledCount++;
      streamingAtSettled = inner.getSnapshot().isStreaming;
    }
  });

  await loop.submit("结束测试");
  assert.equal(settledCount, 1);
  assert.equal(streamingAtSettled, false);
});

test("超预算时自动折叠：先摘要再回答，事件与落盘记录同步", async () => {
  const scripts: Script[] = [
    // 第一次请求来自压缩器，要求返回摘要正文
    async function* () {
      yield { text: "摘要：已读完配置并改过版本号。" };
      yield { finish: "stop" };
    },
    // 第二次才是真正的回答
    async function* () {
      yield { text: "继续。" };
      yield { finish: "stop" };
    },
  ];

  const provider = new FakeProvider(scripts);
  const events: AgentEvent[] = [];
  const records: string[] = [];
  const loop = new AgentLoop({
    provider,
    model: "test-model",
    tools: [],
    workspace: process.cwd(),
    exec: noExec,
    systemPrompt: "你是测试用 Agent",
    maxTurns: 5,
    compaction: { budget: 1, keepRecentTurns: 1 },
    onRecord: (r) => records.push(r.kind),
  });
  loop.setEventHandler((e) => events.push(e));

  const filler = "这是一段很长的历史内容，用来把估算 token 顶到预算之上。".repeat(20);
  loop.restore([
    { role: "user", content: filler },
    { role: "assistant", content: filler },
    { role: "user", content: filler },
    { role: "assistant", content: filler },
  ]);

  const before = loop.getSnapshot().contextTokens;
  await loop.submit("继续下一步");

  const compactEvent = events.find((e) => e.type === "compact");
  assert.ok(compactEvent, "应发出 compact 事件");
  assert.ok(records.includes("compact"), "落盘记录里应有 compact");
  assert.ok(loop.getSnapshot().compactions >= 1);

  const history = loop.getHistory();
  assert.equal(history[0].role, "system");
  assert.ok(history[1].content?.includes("上下文摘要"), "折叠后第二条是摘要");
  assert.ok(loop.getSnapshot().contextTokens < before, "折叠后应更小");

  // 摘要请求不该带工具 schema，避免模型在摘要时又去调工具
  assert.equal(provider.requests[0].tools.length, 0);
});

test("reset 后上下文回到仅系统提示，并记录 reset", async () => {
  const scripts: Script[] = [
    async function* () {
      yield { text: "好。" };
      yield { finish: "stop" };
    },
  ];
  const provider = new FakeProvider(scripts);
  const records: string[] = [];
  const loop = new AgentLoop({
    provider,
    model: "m",
    tools: [],
    workspace: process.cwd(),
    exec: noExec,
    systemPrompt: "sys",
    onRecord: (r) => records.push(r.kind),
  });
  await loop.submit("你好");
  loop.reset();
  assert.equal(loop.getHistory().length, 1);
  assert.ok(records.includes("reset"));
});

test("restore 后继续提问：历史被带上，且系统提示用当前配置覆盖", async () => {
  const scripts: Script[] = [
    async function* () {
      yield { text: "接着答。" };
      yield { finish: "stop" };
    },
  ];
  const provider = new FakeProvider(scripts);
  const loop = new AgentLoop({
    provider,
    model: "m",
    tools: [],
    workspace: process.cwd(),
    exec: noExec,
    systemPrompt: "当前系统提示",
  });

  const restored = loop.restore([
    { role: "system", content: "旧系统提示" },
    { role: "user", content: "上一轮的问题" },
    { role: "assistant", content: "上一轮的回答" },
  ]);
  assert.equal(restored, 2, "恢复时丢弃旧 system，只留对话体");

  await loop.submit("新一轮");

  const sent = provider.requests[0].messages;
  assert.equal(sent[0].content, "当前系统提示", "系统提示必须是当前的，不能沿用旧会话里的");
  assert.ok(sent.some((m) => m.content === "上一轮的问题"), "恢复的历史要带上");
  assert.ok(sent.some((m) => m.content === "上一轮的回答"));
  assert.equal(sent[sent.length - 1].content, "新一轮");
  assert.equal(loop.getHistory().filter((m) => m.role === "system").length, 1);
});

test("空输出被长度截断时不当成完成，回灌提示让模型重来", async () => {
  // 推理型模型把 max_tokens 全花在 reasoning 上会走到这里：
  // 没有正文、没有工具调用，旧实现直接 return "done"，用户以为干完了
  const scripts: Script[] = [
    async function* () {
      yield { finish: "length" };
    },
    async function* () {
      yield { text: "这次直接干。" };
      yield { finish: "stop" };
    },
  ];

  const { provider, loop, events } = build(scripts, []);
  const outcome = await loop.submit("写个函数");

  assert.equal(outcome, "done");
  assert.equal(provider.requests.length, 2, "截断后必须再请求一次");
  const nudge = provider.requests[1].messages.at(-1);
  assert.equal(nudge?.role, "user");
  assert.match(String(nudge?.content), /长度上限/);
  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("连续空输出截断三次后报错，不无限重试", async () => {
  const empty: Script = async function* () {
    yield { finish: "length" };
  };
  const { provider, loop, events } = build([empty, empty, empty, empty, empty], []);
  const outcome = await loop.submit("一直想不说话");

  assert.equal(outcome, "error");
  assert.equal(provider.requests.length, 3, "重试两次后第三次报错");
  const err = events.find((e) => e.type === "error");
  assert.match(String(err && "message" in err ? err.message : ""), /maxTokens|截断/);
  assert.equal(loop.getSnapshot().isStreaming, false);
});
