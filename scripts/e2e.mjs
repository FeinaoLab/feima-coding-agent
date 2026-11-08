#!/usr/bin/env node
/**
 * 端到端：真模型跑一遍，约 2~5 分钟。
 *
 * 分工（三道检查各自守什么，别混）：
 *   npm test       确定性逻辑——闸门、白名单、重试的判定都在这里，快、无外部依赖
 *   npm run smoke  装配链路——假 provider 驱动真工具，守「组件都对但没接上」
 *   npm run e2e    真模型能不能干活，以及我们的提示词/拒绝理由对人话模型是否可读
 *
 * 为什么 e2e 不进 npm test：它要一台跑着模型的机器，耗时以分钟计，而且模型换版本
 * 行为就会漂。它是个「验收脚本」，不是回归脚本——每次动到提示词、工具描述、拒绝
 * 文案时手动跑一次。
 *
 * 默认打本机 Ollama；要换线路用环境变量：
 *   FEIMA_E2E_BASE_URL / FEIMA_E2E_API_KEY / FEIMA_E2E_MODEL / FEIMA_E2E_TIMEOUT(ms)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const cli = path.join(repo, "bin", "feima.mjs");

const baseUrl = process.env.FEIMA_E2E_BASE_URL ?? "http://127.0.0.1:11434/v1";
const apiKey = process.env.FEIMA_E2E_API_KEY ?? "ollama";
const model = process.env.FEIMA_E2E_MODEL ?? "qwen3:8b-65k";
const perRunTimeout = Number(process.env.FEIMA_E2E_TIMEOUT ?? 300_000);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "feima-e2e-"));
const results = [];
let failures = 0;

function width(s) {
  return [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
}
const pad = (s, w) => s + " ".repeat(Math.max(1, w - width(s)));
const short = (s, n) => (width(s) <= n ? s : [...s].slice(0, n).join("") + "…");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 场景调用的筛选：`node scripts/e2e.mjs --only 白名单` 只跑命中的那条，省时间 */
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : null;
})();

/** 一个场景 = 一个临时工作区 + 一次 run，断言全部落在「事件流 + 磁盘」上 */
async function scenario(name, fn) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`\x1b[32m✓\x1b[0m ${name} ${Date.now() - started} ms`);
  } catch (err) {
    failures++;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, ms: Date.now() - started, error: message });
    console.log(`\x1b[31m✗\x1b[0m ${name} ${Date.now() - started} ms\n    ${message}`);
  }
}

function writeFixture(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
}

/** 跑一条真实的 `feima run --json`，把 JSONL 事件收回成好断言的形状 */
async function runFeima(workspace, task, extra = [], extraEnv = {}) {
  const args = [cli, "run", task, "--workspace", workspace, "--json", "--no-save", ...extra];
  const env = {
    ...process.env,
    FEIMA_BASE_URL: baseUrl,
    FEIMA_API_KEY: apiKey,
    FEIMA_MODEL: model,
    ...extraEnv,
  };
  delete env.FEIMA_CMD_ALLOW;
  delete env.FEIMA_CONFIRM;
  delete env.FEIMA_YES;
  delete env.FEIMA_SYSTEM_EXTRA;

  const child = spawn(process.execPath, args, { cwd: repo, env });
  const events = [];
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, perRunTimeout);

  await new Promise((resolve) => {
    child.stdout.on("data", (b) => {
      const text = b.toString("utf8");
      stdout += text;
      for (const line of text.split("\n")) {
        if (!line.trim().startsWith("{")) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* 半行：等下一块数据补齐，这里丢弃不会影响结论 */
        }
      }
    });
    child.stderr.on("data", (b) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);

  const starts = events.filter((e) => e.type === "tool_start");
  const ends = events.filter((e) => e.type === "tool_end");
  const text = events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  const reasoning = events.filter((e) => e.type === "reasoning_delta").length;
  return { events, starts, ends, text, reasoning, stdout, stderr, timedOut };
}

/** 某类工具的成功/失败次数，用来写断言 */
const count = (ends, name, ok) =>
  ends.filter((e) => e.name === name && (ok === undefined || e.ok === ok)).length;

const summarize = (r) =>
  [
    `工具 ${r.starts.length} 次（成功 ${r.ends.filter((e) => e.ok).length}）`,
    `思考块 ${r.reasoning}`,
    `text ${r.text.length} 字`,
  ].join(" · ");

function printCalls(r) {
  for (const e of r.ends) {
    const brief = short(String(e.preview ?? "").replace(/\s+/g, " "), 96);
    console.log(`    ${e.ok ? "✓" : "✗"} ${e.name}  ${brief}`);
  }
}

function nodeTest(workspace) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test"], { cwd: workspace });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (out += b.toString("utf8")));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** 带 bug 的夹具：add 写成了减法，测试必然是红的 */
const BUGGY = {
  "calc.mjs": "export function add(a, b) {\n  return a - b;\n}\n",
  "test.mjs":
    'import test from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    'import { add } from "./calc.mjs";\n\n' +
    'test("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
};

/** 同一个夹具修好之后的样子：白名单场景只需要「命令能跑通」，不需要模型改代码 */
const GREEN = {
  ...BUGGY,
  "calc.mjs": "export function add(a, b) {\n  return a + b;\n}\n",
};

// —— 场景一：真模型能不能跑通「跑测试 → 看代码 → 改 → 再跑测试」 ——
await scenario("闭环：真模型读代码、修 bug、再跑测试到全绿", async () => {
  const ws = path.join(root, "fix");
  writeFixture(ws, BUGGY);

  const before = await nodeTest(ws);
  assert(before.code !== 0, "夹具本身应该是红的，否则这条断言证明不了任何事");

  const r = await runFeima(
    ws,
    "先运行 node --test 看看结果。如果有测试失败，请修好 calc.mjs 让测试通过，然后重新跑一次 node --test 确认全部通过。",
    ["--confirm", "exec", "--yes", "--retries", "1"],
  );
  if (r.timedOut) throw new Error(`超时（${perRunTimeout} ms）`);
  printCalls(r);

  const after = await nodeTest(ws);
  assert(after.code === 0, `测试仍然是红的，模型没修对。模型的话：${short(r.text, 160)}`);
  assert(count(r.ends, "bash", true) >= 1, "没成功跑过命令，闭环不成立");
  assert(count(r.ends, "edit_file", true) + count(r.ends, "write_file", true) >= 1, "没改过文件");

  const notices = r.events.filter((e) => e.type === "notice");
  assert(notices.length >= 1, "--yes 放行前必须先留一条 notice");

  console.log(`    ${summarize(r)}`);
});

// —— 场景二：白名单放进真模型手里，会不会漏放、拒绝理由说不说得清楚 ——
// 这里守的是**安全底线**，不是「模型听不听话」：
//   1. 被放行的命令必须真的在规则内（漏放是安全问题，必红）
//   2. 被拦下的命令必须说清是白名单拦的（说不清，模型就只能瞎猜）
// 模型具体选哪条命令是它自己的事——实测它会选 `node test.mjs` 这种等价写法，
// 那是被拦得对，不是误伤。
await scenario("白名单：只放行规则内的命令，拒绝理由说清是什么拦的", async () => {
  const ws = path.join(root, "allow");
  writeFixture(ws, GREEN); // 夹具是绿的，node --test 会以 0 退出

  const r = await runFeima(
    ws,
    "运行 node --test 跑一下测试；如果这条命令不行，换成 node test.mjs 再试。",
    ["--confirm", "exec", "--yes", "--cmd-allow", "node --test", "--retries", "1"],
    // 8B 有个固定毛病：拿到「跑命令」的任务先去 list_dir 摸地形，摸到越界就收工。
    // 这条场景要验的是白名单，不是它的探索习惯，所以直接要求它先执行。
    { FEIMA_SYSTEM_EXTRA: "任务明确要求执行命令时，直接用 bash 执行；不要先列目录探索。" },
  );
  if (r.timedOut) throw new Error(`超时（${perRunTimeout} ms）`);
  printCalls(r);

  const bashStarts = r.starts.filter((e) => e.name === "bash");
  assert(bashStarts.length >= 1, "模型一条命令都没跑，这条场景什么都没验到");

  const commandById = new Map(bashStarts.map((e) => [e.id, String(JSON.parse(e.args).command ?? "")]));
  for (const end of r.ends.filter((e) => e.name === "bash")) {
    const command = commandById.get(end.id) ?? "";
    if (end.ok) {
      assert(
        command === "node --test" || command.startsWith("node --test "),
        `放行了白名单外的命令：${command}`,
      );
    } else {
      const reason = String(end.preview ?? "");
      const policyDenial = /白名单/.test(reason);
      const normalFailure = /退出码/.test(reason);
      assert(policyDenial || normalFailure, `拒绝理由没说清是什么拦的：${short(reason, 120)}`);
    }
  }
  console.log(`    ${summarize(r)} · 跑过的命令：${[...new Set([...commandById.values()])].join(" / ")}`);
});

// 反方向：规则外的命令必须被拦，而且理由要说清是白名单拦的
await scenario("白名单：规则外的命令被拒，理由列出允许的前缀", async () => {
  const ws = path.join(root, "allow-deny");
  writeFixture(ws, GREEN);

  const r = await runFeima(
    ws,
    "运行 node --version 看看 Node 版本。",
    ["--confirm", "exec", "--yes", "--cmd-allow", "node --test", "--retries", "1"],
    { FEIMA_SYSTEM_EXTRA: "任务明确要求执行命令时，直接用 bash 执行；不要先列目录探索。" },
  );
  if (r.timedOut) throw new Error(`超时（${perRunTimeout} ms）`);
  printCalls(r);

  const denied = r.ends.filter((e) => e.name === "bash" && !e.ok);
  assert(denied.length >= 1, "规则外的命令没被拦下（或模型根本没跑命令）");
  assert(
    denied.some((e) => /不在白名单/.test(String(e.preview ?? "")) && /允许的命令前缀/.test(String(e.preview ?? ""))),
    "拒绝理由里既要有「不在白名单」，也要给出允许的前缀，否则用户不知道怎么补规则",
  );
  console.log(`    ${summarize(r)}`);
});

// —— 场景三：没有确认入口时必须拒绝，而且拒绝理由要说得像策略不像权限 ——
await scenario("确认闸门：非交互无 --yes 时写不进去，且理由不被读成「权限不足」", async () => {
  const ws = path.join(root, "gate");
  fs.mkdirSync(ws, { recursive: true });

  const r = await runFeima(
    ws,
    "在工作区创建 note.txt，内容写三行：第一行 hello，第二行 你好，第三行 done。",
    ["--confirm", "write", "--retries", "1"],
  );
  if (r.timedOut) throw new Error(`超时（${perRunTimeout} ms）`);
  printCalls(r);

  assert(!fs.existsSync(path.join(ws, "note.txt")), "文件落地了：闸门没拦住");
  const denied = r.ends.filter((e) => !e.ok);
  assert(denied.length >= 1, "一次尝试都没有，这条场景没有验证到闸门");
  assert(
    denied.some((e) => /确认模式拦下了/.test(String(e.preview ?? ""))),
    "拒绝理由不明确，模型会猜成别的原因",
  );

  // v0.5 真机验证时模型在这里连撞六次（换着写法重试同一堵墙），
  // 现在的两道防线：拒绝理由明说「重试无用」，加上空转检测在第五次中止
  const attempts = denied.length;
  assert(attempts <= 6, `被拒后重试了 ${attempts} 次，空转检测没生效`);
  console.log(`    ${summarize(r)} · 被拒后重试 ${attempts} 次`);
});

// —— 汇总 ——
console.log("\n飞码端到端（真模型）");
console.log("─".repeat(56));
console.log(`模型 ${model}  ·  ${baseUrl}`);
for (const r of results) {
  console.log(`${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${pad(r.name, 46)}${String(r.ms).padStart(6)} ms`);
  if (!r.ok) console.log(`    ${r.error}`);
}
console.log("─".repeat(56));
console.log(failures ? `\x1b[31m${failures} 项失败\x1b[0m` : "\x1b[32m全部通过\x1b[0m");

if (failures) {
  console.log(`现场保留在 ${root}`);
} else {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔有句柄没释放，删不掉不影响结论 */
  }
}

process.exit(failures ? 1 : 0);
