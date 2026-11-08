import test from "node:test";
import assert from "node:assert/strict";
import {
  compactIfNeeded,
  estimateMessages,
  estimateTokens,
  fallbackSummary,
  SUMMARY_MARK,
} from "../src/core/compact.ts";
import type { ChatMessage } from "../src/types.ts";

function m(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}

function longText(chars: number): string {
  return "这是一段用于填充上下文的中文内容，重复以模拟长对话。".repeat(Math.ceil(chars / 24)).slice(0, chars);
}

function sampleHistory(): ChatMessage[] {
  // 每条都塞满内容，模拟真实长会话：否则压缩后省不下多少，
  // 会走到「压缩后未变小」的保护分支上，测的就不是折叠逻辑了。
  const pad = (s: string): string => `${s}\n${longText(400)}`;
  return [
    m("system", "你是飞码"),
    m("user", pad("第一问：读一下 package.json")),
    m("assistant", pad("读到了，版本是 0.1.0。")),
    m("user", pad("第二问：把版本改成 0.2.0")),
    m("assistant", null, { tool_calls: [{ id: "call_a", name: "edit_file", arguments: '{"path":"package.json"}' }] }),
    m("tool", pad("已写入 package.json"), { tool_call_id: "call_a", name: "edit_file" }),
    m("assistant", pad("改好了。")),
    m("user", pad("第三问：跑测试")),
    m("assistant", null, { tool_calls: [{ id: "call_b", name: "bash", arguments: '{"command":"npm test"}' }] }),
    m("tool", pad("18 passed"), { tool_call_id: "call_b", name: "bash" }),
    m("assistant", pad("全绿。")),
    m("user", pad("第四问：补一个 README 小节")),
    m("assistant", pad("已经补上。")),
  ];
}

test("token 估算：中文一字约一 token，英文按 3.6 字符估", () => {
  const cn = estimateTokens("上".repeat(100));
  const en = estimateTokens("a".repeat(100));
  assert.ok(cn > en * 2, `中文应显著高于英文，${cn} vs ${en}`);
  assert.ok(cn >= 100 && cn <= 110, `100 个汉字约 105 tokens，实际 ${cn}`);
  assert.equal(estimateTokens(""), 0);
});

test("未超预算时不压缩", async () => {
  const msgs = sampleHistory();
  const res = await compactIfNeeded(msgs, { budget: 100000, keepRecentTurns: 2 });
  assert.equal(res.compacted, false);
  assert.equal(res.messages, msgs);
  assert.equal(res.reason, "未超预算");
});

test("超预算时保留 system 与最近 N 轮，中段折叠为摘要", async () => {
  const msgs = sampleHistory();
  const total = estimateMessages(msgs);
  assert.ok(total > 0);

  const res = await compactIfNeeded(
    msgs,
    { budget: 1, keepRecentTurns: 2 }, // 强制触发；无 summarize 走规则摘要
  );

  assert.equal(res.compacted, true);
  assert.ok(res.after < res.before, "压缩后必须变小");
  assert.equal(res.messages[0].role, "system", "系统提示必须保留");
  assert.ok(res.messages[1].content?.startsWith(SUMMARY_MARK), "第二条应是摘要");
  assert.ok(res.messages[1].content?.includes("自动摘要"), "无摘要器时走降级摘要");
  // 最近两轮原样保留
  const tail = res.messages.slice(2);
  assert.ok(tail[tail.length - 1].content?.startsWith("已经补上。"));
  assert.ok(tail.some((x) => x.content?.includes("第三问")), "最近两轮应包含第三问");
});

test("切分点只落在 user，不会把 tool_calls 与 tool 结果拆开", async () => {
  const msgs = sampleHistory();
  const res = await compactIfNeeded(msgs, { budget: 1, keepRecentTurns: 1 });
  assert.equal(res.compacted, true);

  const out = res.messages;
  for (let i = 0; i < out.length; i++) {
    if (out[i].role === "tool") {
      const prev = out[i - 1];
      assert.ok(
        prev && prev.role === "assistant" && prev.tool_calls?.some((c) => c.id === out[i].tool_call_id),
        `第 ${i} 条 tool 消息前面没有对应的 assistant 调用`,
      );
    }
    if (out[i].tool_calls) {
      // 只要还留着调用，就必须有配对的 tool 结果在紧随其后
      assert.ok(out[i + 1] && out[i + 1].role === "tool", "assistant 的工具调用缺少配对结果");
    }
  }
});

test("摘要器抛错时降级而不是让整轮失败", async () => {
  const msgs = sampleHistory();
  const res = await compactIfNeeded(msgs, {
    budget: 1,
    keepRecentTurns: 1,
    summarize: async () => {
      throw new Error("上游 500");
    },
  });
  assert.equal(res.compacted, true);
  assert.ok(res.messages[1].content?.includes("降级结果"));
});

test("摘要器可用时采用模型摘要，并带上旧摘要做合并", async () => {
  const msgs = sampleHistory();
  let sawPrevious: string | null = null;
  const res = await compactIfNeeded(msgs, {
    budget: 1,
    keepRecentTurns: 1,
    summarize: async (_folded, previous) => {
      sawPrevious = previous;
      return "已把版本改为 0.2.0；测试 18 项通过；README 小节已补。";
    },
  });
  assert.equal(res.compacted, true);
  assert.equal(sawPrevious, null, "首次压缩没有旧摘要");
  assert.ok(res.messages[1].content?.includes("测试 18 项通过"));
});

test("轮次不足或内容太少时明确拒绝，不产出半成品", async () => {
  const msgs: ChatMessage[] = [m("system", "sys"), m("user", "只问了一句"), m("assistant", "答")];
  const res = await compactIfNeeded(msgs, { budget: 0, keepRecentTurns: 3 });
  assert.equal(res.compacted, false);
  // 只有 3 条时无论按轮次还是按 token 都切不出安全边界
  assert.match(res.reason ?? "", /切分点|不足|过少|太少/);
});

test("降级摘要保留关键动作，不编造结论", () => {
  const folded: ChatMessage[] = [
    m("user", "帮我跑一次测试"),
    m("assistant", null, { tool_calls: [{ id: "c1", name: "bash", arguments: "{}" }] }),
    m("tool", "ok", { tool_call_id: "c1", name: "bash" }),
    m("assistant", "测试通过"),
  ];
  const text = fallbackSummary(folded);
  assert.ok(text.includes("帮我跑一次测试"));
  assert.ok(text.includes("bash"));
  assert.ok(text.includes("需要时重新读取"));
});

/** 单轮长工具链：只有一条 user，构造 30 组 assistant(tool_calls)+tool */
function singleTurnChain(rounds: number): ChatMessage[] {
  const out: ChatMessage[] = [m("system", "你是飞码"), m("user", "把 src 下所有文件读一遍")];
  for (let i = 1; i <= rounds; i++) {
    out.push(m("assistant", null, { tool_calls: [{ id: `call_${i}`, name: "read", arguments: `{"path":"src/f${i}.ts"}` }] }));
    out.push(m("tool", longText(500), { tool_call_id: `call_${i}`, name: "read" }));
  }
  return out;
}

test("单轮长工具链：按用户轮次找不到切点，改按 token 保留尾部", async () => {
  const msgs = singleTurnChain(30);
  assert.equal(msgs.filter((x) => x.role === "user").length, 1, "前提：这轮只有一条用户消息");

  const res = await compactIfNeeded(msgs, { budget: 2000, keepRecentTurns: 3, keepTokens: 1000 });
  assert.equal(res.compacted, true, "只有一条 user 时也必须能压，否则长工具链会一路涨到上游报超长");
  assert.ok(res.after < res.before);
  assert.ok(res.folded >= 20, `应折掉大部分历史，实际 ${res.folded}`);
  assert.equal(res.messages[0].role, "system");
  assert.ok(res.messages[1].content?.startsWith(SUMMARY_MARK));
  assert.equal(res.messages.filter((x) => x.role === "user" && x.content?.startsWith(SUMMARY_MARK)).length, 1);
});

test("单轮长工具链的切点不落在 tool 结果上：折叠后配对完整", async () => {
  const msgs = singleTurnChain(30);
  const res = await compactIfNeeded(msgs, { budget: 2000, keepRecentTurns: 3, keepTokens: 1000 });
  assert.equal(res.compacted, true);

  const pending = new Set<string>();
  for (const msg of res.messages.slice(1)) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      assert.equal(pending.size, 0);
      for (const c of msg.tool_calls) pending.add(c.id);
    } else if (msg.role === "tool") {
      assert.ok(pending.has(msg.tool_call_id ?? ""), `孤立 tool：${msg.tool_call_id}`);
      pending.delete(msg.tool_call_id ?? "");
    } else if (pending.size) {
      assert.fail(`${msg.role} 插在 tool_calls 与结果之间`);
    }
  }
  assert.equal(pending.size, 0, "尾部不能留下没有结果的调用");
});

test("连续多次压缩只保留一条摘要，旧摘要并入新摘要", async () => {
  let round = 0;
  const seenPrevious: (string | null)[] = [];
  let msgs = singleTurnChain(20);

  // 压三次，每次再追加一段新历史，模拟长会话持续推进
  for (let k = 0; k < 3; k++) {
    const res = await compactIfNeeded(msgs, {
      budget: 2000,
      keepRecentTurns: 2,
      keepTokens: 800,
      summarize: async (_folded, previous) => {
        seenPrevious.push(previous);
        return `第 ${++round} 次摘要，包含旧摘要 ${previous ? "是" : "否"}`;
      },
    });
    msgs = res.messages;
    for (let i = 1; i <= 6; i++) {
      const id = `extra_${k}_${i}`;
      msgs = [
        ...msgs,
        m("assistant", null, { tool_calls: [{ id, name: "read", arguments: "{}" }] }),
        m("tool", longText(500), { tool_call_id: id, name: "read" }),
      ];
    }
  }

  const summaries = msgs.filter((x) => x.role === "user" && x.content?.startsWith(SUMMARY_MARK));
  assert.equal(summaries.length, 1, `摘要必须始终只有一条，实际 ${summaries.length}`);
  assert.ok(msgs[0].content === "你是飞码");
  assert.equal(seenPrevious[0], null, "第一次没有旧摘要");
  assert.ok(seenPrevious.slice(1).every((p) => p !== null), "后续压缩必须把旧摘要带进去合并");
});

test("一次请求甩出多个工具调用时，折叠区条数很少但体积够，也要能压", async () => {
  // 真机跑出来的形态：模型一口气发 7 个 write_file，历史只有
  // user → assistant(7 calls) → 7×tool。切点只能落在 assistant 上，
  // 折叠区只有一条 user，按"条数<3"的老门槛会被判为内容不足，永远不压。
  const calls = Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`,
    name: "write_file",
    arguments: JSON.stringify({ path: `works/note-0${i}.md`, content: longText(300) }),
  }));
  const msgs: ChatMessage[] = [
    m("system", "你是飞码"),
    m("user", longText(500)),
    m("assistant", null, { tool_calls: calls }),
    ...calls.map((c) => m("tool", "已写入", { tool_call_id: c.id, name: "write_file" })),
  ];

  const before = estimateMessages(msgs);
  const res = await compactIfNeeded(msgs, { budget: 900, keepRecentTurns: 1, keepTokens: 300, summarize: async () => "已建 7 个文件" });
  assert.equal(res.compacted, true, `应能压缩，before=${before}`);
  assert.ok(res.folded >= 1, "至少折掉那条很长的任务描述");
  assert.ok(res.after < res.before);

  // 尾部必须自洽：每个 tool 结果都要能找到对应的 token_calls 请求
  const pending = new Set<string>();
  for (const msg of res.messages.slice(1)) {
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      assert.equal(pending.size, 0);
      for (const c of msg.tool_calls) pending.add(c.id);
    } else if (msg.role === "tool") {
      assert.ok(pending.has(msg.tool_call_id ?? ""), `孤立 tool：${msg.tool_call_id}`);
      pending.delete(msg.tool_call_id ?? "");
    } else if (pending.size) {
      assert.fail(`${msg.role} 插在 tool_calls 与结果之间`);
    }
  }
  assert.equal(pending.size, 0);
});

test("折叠区体积太小时拒绝压缩，避免为几百 token 花一次摘要调用", async () => {
  const msgs: ChatMessage[] = [
    m("system", "sys"),
    m("user", "短问题"),
    m("assistant", "短回答"),
    m("user", "再来一句"),
    m("assistant", "好的"),
  ];
  let called = false;
  const res = await compactIfNeeded(msgs, {
    budget: 1,
    keepRecentTurns: 1,
    summarize: async () => {
      called = true;
      return "摘要";
    },
  });
  assert.equal(res.compacted, false);
  assert.equal(called, false, "内容太少时不该调用摘要模型");
  assert.match(res.reason ?? "", /过少|切分点/);
});
