import assert from "node:assert/strict";
import test from "node:test";
import { validateHistoryRecord } from "../src/metrics/report.ts";

/**
 * e2e/history.jsonl 是唯一一份「历史数字」，写入方是 scripts/e2e.mjs，读的一方是
 * scripts/e2e-trend.mjs 和人。字段名一旦漂移，后果是趋势表安静地打一排空格子——
 * 不报错，只是从此看不出变好变坏。这组用例守的就是「漂移必须响」。
 */

const good = () => ({
  at: "2026-11-08T22:54:14.959Z",
  version: "0.7.0",
  rev: "4f2513e",
  model: "qwen3:8b-65k",
  baseUrl: "http://127.0.0.1:11434/v1",
  ok: true,
  partial: false,
  totals: { steps: 15, rounds: 4, toolCalls: 11, toolOk: 7, toolFail: 4, blocked: 3, retries: 0, totalTokens: 24241 },
  scenarios: [{ name: "闭环", ok: true, ms: 69587, metrics: { steps: 7 } }],
});

test("正常记录没有任何问题", () => {
  assert.deepEqual(validateHistoryRecord(good()), []);
});

test("字段名漂成 total / commit 时必须报出来，并说清期望哪个", () => {
  const r = good() as Record<string, unknown>;
  r.total = r.totals;
  r.commit = r.rev;
  delete r.totals;
  delete r.rev;
  const problems = validateHistoryRecord(r);
  assert.equal(problems.length >= 2, true, `应当至少报两处，实际：${JSON.stringify(problems)}`);
  assert.match(problems.join(" "), /totals/);
  assert.match(problems.join(" "), /rev/);
});

test("缺 totals 会导致趋势表全空，必须报错", () => {
  const r = good() as Record<string, unknown>;
  delete r.totals;
  assert.match(validateHistoryRecord(r).join(" "), /totals/);
});

test("totals 里的数字被写成字符串时不算合格", () => {
  const r = good();
  (r.totals as Record<string, unknown>).steps = "15";
  assert.match(validateHistoryRecord(r).join(" "), /steps/);
});

test("at 不是可解析的时间时不算合格", () => {
  const r = good();
  r.at = "昨天下午";
  assert.match(validateHistoryRecord(r).join(" "), /at/);
});

test("scenarios 不是数组时不算合格", () => {
  const r = good() as Record<string, unknown>;
  r.scenarios = { 0: "闭环" };
  assert.match(validateHistoryRecord(r).join(" "), /scenarios/);
});

test("不是对象（比如 JSON 里混进一个字符串）时不崩，只报错", () => {
  assert.equal(validateHistoryRecord("oops").length > 0, true);
  assert.equal(validateHistoryRecord(null).length > 0, true);
});
