import test from "node:test";
import assert from "node:assert/strict";
import {
  compareRuns,
  emptyMetrics,
  formatRate,
  isBlockedFailure,
  successRate,
  summarizeRun,
} from "../src/metrics/report.ts";
import type { AgentEvent } from "../src/types.ts";

const ev = (e: Record<string, unknown>) => e as unknown as AgentEvent;

test("轮次按 turn_end 数，步数按 step 数，工具成功失败分开记", () => {
  const events = [
    ev({ type: "step", index: 1, toolCalls: 1 }),
    ev({ type: "turn_end", turn: 1 }),
    ev({ type: "tool_start", id: "1", name: "bash", args: "{}" }),
    ev({ type: "tool_end", id: "1", name: "bash", ok: true, preview: "退出码 0" }),
    ev({ type: "step", index: 2, toolCalls: 1 }),
    ev({ type: "turn_end", turn: 2 }),
    ev({ type: "tool_start", id: "2", name: "bash", args: "{}" }),
    ev({ type: "tool_end", id: "2", name: "bash", ok: false, preview: "错误：退出码 1\nSTDOUT:" }),
  ];
  const m = summarizeRun(events, 1234);
  assert.equal(m.rounds, 2);
  assert.equal(m.steps, 2, "步数独立于轮次：多步落在同一轮里是常态");
  assert.equal(m.toolCalls, 2);
  assert.equal(m.toolOk, 1);
  assert.equal(m.toolFail, 1);
  assert.equal(m.blocked, 0, "退出码 1 是命令自己失败，不是被闸门拦下");
  assert.equal(m.failedOther, 1);
  assert.equal(m.wallMs, 1234);
});

test("策略性失败算「被拦」，普通失败不算——两者的意义完全不同", () => {
  const blocked = [
    "错误：命令不在白名单内：node --version\n允许的命令前缀：node --test",
    "「write」确认模式拦下了这次操作：这条通道没有可交互的确认入口，按拒绝处理。",
    "用户拒绝执行：bash",
    "当前是「write」确认模式，但这条通道没有可交互的确认入口，按拒绝处理",
  ];
  for (const p of blocked) assert.equal(isBlockedFailure(p), true, p);

  const normal = ["错误：退出码 1\nSTDOUT: 测试失败", "错误：文件不存在：a.txt", "执行成功"];
  for (const p of normal) assert.equal(isBlockedFailure(p), false, p);

  const m = summarizeRun(
    [
      ev({ type: "tool_start", id: "1", name: "bash", args: "{}" }),
      ev({ type: "tool_end", id: "1", name: "bash", ok: false, preview: blocked[1] }),
      ev({ type: "tool_start", id: "2", name: "bash", args: "{}" }),
      ev({ type: "tool_end", id: "2", name: "bash", ok: false, preview: normal[0] }),
    ],
    0,
  );
  assert.equal(m.blocked, 1);
  assert.equal(m.failedOther, 1);
});

test("token 按事件累加：provider 报几次就加几次，不取最后一次", () => {
  const m = summarizeRun(
    [
      ev({ type: "usage", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      ev({ type: "usage", usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 } }),
    ],
    0,
  );
  assert.equal(m.promptTokens, 250);
  assert.equal(m.completionTokens, 50);
  assert.equal(m.totalTokens, 300);
});

test("重试、提醒、压缩各记各的", () => {
  const m = summarizeRun(
    [
      ev({ type: "retry", attempt: 2, delayMs: 500, message: "连接重置" }),
      ev({ type: "retry", attempt: 3, delayMs: 1000, message: "连接重置" }),
      ev({ type: "notice", message: "--yes 已放行写操作" }),
      ev({ type: "compact", before: 9000, after: 3000, folded: 12 }),
    ],
    0,
  );
  assert.equal(m.retries, 2);
  assert.equal(m.notices, 1);
  assert.equal(m.compactions, 1);
});

test("结束方式是 error 就不算 settled——报错之后又 settle 不能把错误抹掉", () => {
  const error = summarizeRun(
    [ev({ type: "error", message: "空转中止", retryable: false }), ev({ type: "agent_settled" })],
    0,
  );
  assert.equal(error.ended, "error");
  assert.equal(summarizeRun([ev({ type: "agent_settled" })], 0).ended, "settled");
  assert.equal(summarizeRun([ev({ type: "aborted" }), ev({ type: "agent_settled" })], 0).ended, "aborted");
  assert.equal(summarizeRun([], 0).ended, "unknown");
});

test("一次工具都没调时成功率是「—」，不是 0%", () => {
  const m = emptyMetrics();
  assert.equal(successRate(m), null);
  assert.equal(formatRate(m), "—");
  const one = summarizeRun(
    [
      ev({ type: "tool_start", id: "1", name: "bash", args: "{}" }),
      ev({ type: "tool_end", id: "1", name: "bash", ok: true, preview: "退出码 0" }),
    ],
    0,
  );
  assert.equal(successRate(one), 1);
  assert.equal(formatRate(one), "100%");
});

test("两次运行对比只挑「变小是好事」的字段", () => {
  const before = summarizeRun(
    [
      ev({ type: "step", index: 1, toolCalls: 0 }),
      ev({ type: "turn_end", turn: 1 }),
      ev({ type: "turn_end", turn: 2 }),
      ev({ type: "tool_start", id: "1", name: "bash", args: "{}" }),
      ev({ type: "tool_end", id: "1", name: "bash", ok: true, preview: "退出码 0" }),
    ],
    5000,
  );
  const after = summarizeRun([ev({ type: "turn_end", turn: 1 })], 3000);
  const rows = compareRuns(before, after);
  const steps = rows.find((r) => r.label === "往返");
  assert.equal(steps?.before, 1);
  assert.equal(steps?.after, 0);
  const round = rows.find((r) => r.label === "轮次");
  assert.equal(round?.before, 2);
  assert.equal(round?.after, 1);
  assert.equal(round?.higherIsBetter, false);
  // token 缺省时给 null：没报用量和「用量为 0」不是一回事
  assert.equal(rows.find((r) => r.label === "token")?.after, null);
});
