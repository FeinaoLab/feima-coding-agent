#!/usr/bin/env node
/**
 * 端到端趋势：把 e2e/history.jsonl 读成一张表。
 *
 * 为什么要有它：`npm run e2e` 只回答「这次成不成」，而成不成之外真正关心的是
 * 「比上次好没有」——同一个修 bug 的任务，上次 12 次工具调用、这次 5 次，那不是
 * 运气。趋势表把每次跑的数字排在一起，改提示词、改闸门、换模型的效果才有处可比。
 *
 *   npm run e2e:trend            最近 10 次
 *   npm run e2e:trend -- --all   全部
 *   npm run e2e:trend -- --last 3
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateHistoryRecord } from "../src/metrics/report.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const historyFile = path.join(repo, "e2e", "history.jsonl");

const width = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, w, right = false) => {
  const body = String(s ?? "");
  const fill = " ".repeat(Math.max(0, w - width(body)));
  return right ? fill + body : body + fill;
};

const args = process.argv.slice(2);
const all = args.includes("--all");
const lastIdx = args.indexOf("--last");
const last = all ? Infinity : lastIdx >= 0 ? Number(args[lastIdx + 1]) || 10 : 10;

if (!fs.existsSync(historyFile)) {
  console.log(`还没有记录：${path.relative(repo, historyFile)}`);
  console.log("先跑一次 npm run e2e（加 --no-save 不会写记录）");
  process.exit(0);
}

const bad = [];
const rows = fs
  .readFileSync(historyFile, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l, i) => {
    let rec;
    try {
      rec = JSON.parse(l);
    } catch {
      console.log(`第 ${i + 1} 行不是合法 JSON，已跳过`);
      return null;
    }
    const problems = validateHistoryRecord(rec);
    if (problems.length) bad.push({ line: i + 1, problems });
    return rec;
  })
  .filter(Boolean);

// 口径不对就停：继续打表等于把「字段名改了」显示成「这版变便宜了」
if (bad.length) {
  console.log(`\n有 ${bad.length} 行记录的字段口径不对，趋势表会缺数据：`);
  for (const b of bad) {
    console.log(`  第 ${b.line} 行`);
    for (const p of b.problems) console.log(`    · ${p}`);
  }
  console.log("修法是让写入方（scripts/e2e.mjs）按同一个口径写，不要手改历史行骗过检查。");
  process.exit(1);
}

if (!rows.length) {
  console.log("记录文件是空的");
  process.exit(0);
}

const shown = rows.slice(-last);

const stamp = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16).replace("T", " ");
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const COL = [
  ["时间", 12],
  ["版本", 7],
  ["rev", 8],
  ["结果", 6],
  ["往返", 5],
  ["工具成功", 9],
  ["被拦", 5],
  ["重试", 5],
  ["token", 8],
  ["耗时", 7],
  ["模型", 14],
];

const table = shown.map((row) => {
  const idx = rows.indexOf(row);
  const t = row.totals ?? {};
  const rate = t.toolCalls ? `${Math.round((t.toolOk / t.toolCalls) * 100)}%` : "—";
  const prev = idx > 0 ? (rows[idx - 1].totals ?? {}) : null;
  // 增量跟着数字走：(−2) 读作「比上次少 2 次」，少就是省
  const delta = (cur, before) => {
    if (!before || cur === undefined || before === undefined) return "";
    const d = cur - before;
    return d === 0 ? "" : d > 0 ? `(+${d})` : `(${d})`;
  };
  return [
    stamp(row.at),
    String(row.version ?? ""),
    String(row.rev ?? ""),
    `${row.ok ? "通过" : "失败"}${row.partial ? "*" : ""}`,
    `${t.steps ?? t.rounds ?? 0}${delta(t.steps ?? t.rounds, prev?.steps ?? prev?.rounds)}`,
    `${t.toolOk ?? 0}/${t.toolCalls ?? 0} ${rate}`,
    `${t.blocked ?? 0}${delta(t.blocked, prev?.blocked)}`,
    `${t.retries ?? 0}${delta(t.retries, prev?.retries)}`,
    `${t.totalTokens || "-"}${prev?.totalTokens ? delta(t.totalTokens, prev.totalTokens) : ""}`,
    `${Math.round((row.scenarios ?? []).reduce((n, s) => n + (s.ms ?? 0), 0) / 1000)}s`,
    String(row.model ?? ""),
  ];
});

const widths = COL.map(([name, min], k) => Math.max(width(name), ...table.map((cells) => width(cells[k]))));
const rule = "─".repeat(widths.reduce((n, w) => n + w + 2, 0));

console.log("\n端到端趋势（同一任务下，轮次 / 工具 / token 越少越省；括号里是与上一次的差）");
console.log(rule);
console.log(COL.map(([name], k) => pad(name, widths[k])).join("  "));
for (const cells of table) console.log(cells.map((c, k) => pad(c, widths[k], k >= 3)).join("  "));
console.log(rule);
if (rows.some((r) => r.partial)) console.log("* 该次只跑了部分场景（--only），合计不可与整轮相比");

// 逐场景看最近一次：哪条变贵了、哪条被拦了
const latest = shown[shown.length - 1];
const scenarios = latest.scenarios ?? [];
if (scenarios.length) {
  console.log(`\n最近一次（${stamp(latest.at)} · ${latest.model}）逐场景`);
  for (const s of scenarios) {
    const m = s.metrics;
    if (!m) {
      console.log(`  ${s.ok ? "✓" : "✗"} ${s.name}（没有量化数据）`);
      continue;
    }
    const bits = [
      `${m.steps ?? m.rounds} 步`,
      `工具 ${m.toolOk}/${m.toolCalls}`,
      m.blocked ? `被拦 ${m.blocked}` : "",
      m.retries ? `重试 ${m.retries}` : "",
      m.totalTokens ? `${m.totalTokens} token` : "",
      `${Math.round(m.wallMs / 1000)}s`,
      s.ok ? "" : "← 失败",
    ].filter(Boolean);
    console.log(`  ${s.ok ? "✓" : "✗"} ${pad(s.name, 40)} ${bits.join(" · ")}`);
  }
}

const pass = rows.filter((r) => r.ok).length;
console.log(`\n共 ${rows.length} 次（通过 ${pass} / 失败 ${rows.length - pass}），显示最近 ${shown.length} 次`);
