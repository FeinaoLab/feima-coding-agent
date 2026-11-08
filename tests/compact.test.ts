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
  assert.match(res.reason ?? "", /不足|太少/);
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
