#!/usr/bin/env node
/**
 * 离线冒烟：固定仓库形态 + 固定任务，跑一整条链路，约 10 秒。
 *
 * 为什么不用真模型：冒烟脚本要在每次提交前跑，不能依赖网络、不能花钱、
 * 也不能因为上游偶发波动而红。这里用脚本化的假 provider 驱动**真实的**工具、
 * 沙盒、压缩、会话落盘——模型换成谁不影响这些链路。
 *
 * 它守的是「组装起来还能不能用」：单元用例各自绿，装配错了照样白搭
 * （v0.4 的确认闸门没接上就是这样：组件级全绿，真机调不动）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const { AgentLoop } = await import("../src/core/loop.ts");
const { createSandbox } = await import("../src/safety/exec.ts");
const { defaultPolicy } = await import("../src/safety/policy.ts");
const { builtinTools, filterByPerms } = await import("../src/tools/builtin.ts");
const { checkCommandAllowed, parseAllowlist } = await import("../src/safety/allowlist.ts");
const { estimateMessages } = await import("../src/core/compact.ts");
const { SessionStore } = await import("../src/core/session.ts");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "feima-smoke-"));
const workspace = path.join(root, "proj");
fs.mkdirSync(workspace, { recursive: true });

let failures = 0;
const results = [];

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (err) {
    failures++;
    results.push({ name, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** 脚本化 provider：每一轮吐什么由数组给定；元素可以是函数（用于制造失败） */
function scripted(rounds) {
  let i = 0;
  const requests = [];
  return {
    name: "smoke",
    requests,
    async *stream(req) {
      requests.push(req);
      const round = rounds[Math.min(i, rounds.length - 1)];
      i++;
      yield* round(req);
    },
  };
}

function callTool(name, args) {
  return async function* () {
    yield { toolCall: { index: 0, id: `c_${name}`, name, args: JSON.stringify(args) } };
    yield { finish: "tool_calls" };
  };
}

function say(text) {
  return async function* () {
    yield { text };
    yield { finish: "stop" };
  };
}

/**
 * 取最后一次请求里的工具回灌结果。
 * 必须用最后一次：一条任务跑完所有工具之后，历史才是完整的；
 * 取第二次只会看到第一个工具的结果（第一版就是这么漏掉 bash 的）。
 */
function toolResults(provider) {
  const last = provider.requests[provider.requests.length - 1];
  return (last?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content ?? "");
}

const baseSandbox = (extra = {}) =>
  createSandbox({ mode: "policy", policy: defaultPolicy({ workspace }), ...extra });

// —— 场景一：写文件 + 执行命令，都是真跑 ——
await step("工具链：write_file 落盘 + bash 真执行", async () => {
  const sandbox = baseSandbox();
  const provider = scripted([
    callTool("write_file", { path: "notes/a.txt", content: "飞码冒烟" }),
    callTool("bash", { command: "echo feima-smoke" }),
    say("完成"),
  ]);
  const loop = new AgentLoop({
    provider,
    model: "smoke",
    tools: filterByPerms(builtinTools({ policy: defaultPolicy({ workspace }) }), "exec"),
    workspace,
    exec: sandbox.exec,
    systemPrompt: "冒烟测试",
    maxTurns: 8,
  });

  const outcome = await loop.submit("写个文件，再跑一条命令");
  assert(outcome === "done", `应当正常收敛，实际 ${outcome}`);
  const written = path.join(workspace, "notes", "a.txt");
  assert(fs.existsSync(written), "文件没写出来");
  assert(fs.readFileSync(written, "utf8") === "飞码冒烟", "文件内容不对");

  // 按「退出码」找：写入结果里也可能出现 feima-smoke（临时目录名），不能靠关键字
  const bashResult = toolResults(provider).find((t) => t.startsWith("退出码"));
  assert(bashResult, `命令没有真执行，拿到的工具结果：${toolResults(provider).join(" | ").slice(0, 200)}`);
  assert(/退出码 0/.test(bashResult), `命令退出码不为 0：${bashResult.slice(0, 120)}`);
  await sandbox.dispose();
});

// —— 场景二：确认闸门挡住写文件 ——
await step("确认闸门：用户拒绝时不落盘", async () => {
  const sandbox = baseSandbox();
  const provider = scripted([callTool("write_file", { path: "notes/b.txt", content: "不该写" }), say("好的")]);
  const loop = new AgentLoop({
    provider,
    model: "smoke",
    tools: builtinTools({ policy: defaultPolicy({ workspace }) }),
    workspace,
    exec: sandbox.exec,
    systemPrompt: "冒烟测试",
    confirmMode: "write",
  });
  loop.setConfirm(async () => false);
  await loop.submit("写个文件");
  assert(!fs.existsSync(path.join(workspace, "notes", "b.txt")), "拒绝了还是把文件写了");
  assert(toolResults(provider).some((t) => t.includes("用户拒绝")), "模型没收到拒绝原因");
  await sandbox.dispose();
});

// —— 场景三：白名单挡住白名单外的命令 ——
await step("命令白名单：白名单外一律拒绝", async () => {
  const rules = parseAllowlist(["echo"]).rules;
  assert(checkCommandAllowed("echo hi", rules).ok, "白名单内的命令被误杀");
  assert(!checkCommandAllowed("node --version", rules).ok, "白名单外的命令被放行");

  const sandbox = baseSandbox({ commandAllowlist: rules });
  let rejected = "";
  try {
    await sandbox.exec("node --version", workspace, { timeoutMs: 5000 });
  } catch (err) {
    rejected = err instanceof Error ? err.message : String(err);
  }
  assert(/白名单/.test(rejected), `exec 层没有拦住：${rejected || "（没有报错）"}`);
  // 白名单内的仍然要能跑：只拦不放过是另一种坏
  const okRes = await sandbox.exec("echo hi", workspace, { timeoutMs: 5000 });
  assert(okRes.exitCode === 0, `白名单内命令退出码 ${okRes.exitCode}`);
  await sandbox.dispose();
});

// —— 场景四：上下文超预算会自动折叠 ——
await step("上下文压缩：超预算自动折叠且总量下降", async () => {
  const sandbox = baseSandbox();
  const pad = "这是一段用来撑大上下文的中文内容。".repeat(120);
  let round = 0;
  const provider = {
    name: "smoke",
    async *stream() {
      round++;
      if (round === 1) {
        yield { text: pad };
        yield { finish: "stop" };
        return;
      }
      yield { text: "短回答" };
      yield { finish: "stop" };
    },
  };
  const loop = new AgentLoop({
    provider,
    model: "smoke",
    tools: [],
    workspace,
    exec: sandbox.exec,
    systemPrompt: "冒烟测试",
    compaction: { budget: 600, keepRecentTurns: 1 },
  });
  const events = [];
  loop.setEventHandler((e) => events.push(e));

  for (let i = 0; i < 6; i++) await loop.submit(`第 ${i} 问 ${pad.slice(0, 200)}`);
  const compacted = events.filter((e) => e.type === "compact");
  assert(compacted.length > 0, "上下文涨到预算以上却没有折叠");
  assert(
    compacted.every((e) => e.after <= e.before),
    "折叠后反而变大了",
  );
  assert(estimateMessages(loop.getHistory()) < 6000, "折叠后总量仍然失控");
  await sandbox.dispose();
});

// —— 场景五：一次失败后重试成功 ——
await step("重试：建连失败后自动重试并收敛", async () => {
  const sandbox = baseSandbox();
  const provider = scripted([
    async function* () {
      throw Object.assign(new Error("连接模型服务失败：模拟"), { retryable: true });
    },
    say("重试后成功"),
  ]);
  const loop = new AgentLoop({
    provider,
    model: "smoke",
    tools: [],
    workspace,
    exec: sandbox.exec,
    systemPrompt: "冒烟测试",
    retry: { attempts: 3, baseMs: 1, maxMs: 2, jitter: 0 },
  });
  const events = [];
  loop.setEventHandler((e) => events.push(e));
  const outcome = await loop.submit("问一句");
  assert(outcome === "done", `重试后应当收敛，实际 ${outcome}`);
  assert(provider.requests.length === 2, `请求次数不对：${provider.requests.length}`);
  assert(events.some((e) => e.type === "retry"), "没有 retry 事件");
  assert(events.some((e) => e.type === "text_delta" && e.text.includes("重试后成功")), "重试后的正文没出来");
  await sandbox.dispose();
});

// —— 场景六：会话落盘后能重新读出来 ——
await step("会话持久化：落盘 → 重载 → 消息条数一致", async () => {
  const dir = path.join(root, "sessions");
  const store = SessionStore.create({ workspace, model: "smoke" }, dir);
  const sandbox = baseSandbox();
  const provider = scripted([say("第一轮回答"), say("第二轮回答")]);
  const loop = new AgentLoop({
    provider,
    model: "smoke",
    tools: [],
    workspace,
    exec: sandbox.exec,
    systemPrompt: "冒烟测试",
    onRecord: (rec) => {
      if (rec.kind === "message") store.appendMessage(rec.message);
    },
  });
  await loop.submit("第一问");
  await loop.submit("第二问");

  const reopened = SessionStore.open(store.id, dir);
  const loaded = reopened.load();
  assert(loaded.broken === 0, `有 ${loaded.broken} 行损坏`);
  const users = loaded.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert(users.length === 2, `用户消息应为 2 条，实际 ${users.length}`);
  assert(users[1] === "第二问", "重载后顺序不对");
  await sandbox.dispose();
});

// —— 汇总 ——
const width = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0);
const pad = (s, w) => s + " ".repeat(Math.max(1, w - width(s)));
console.log("\n飞码离线冒烟");
console.log("─".repeat(52));
for (const r of results) {
  console.log(`${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${pad(r.name, 44)}${String(r.ms).padStart(5)} ms`);
  if (!r.ok) console.log(`    ${r.error}`);
}
console.log("─".repeat(52));
console.log(failures ? `\x1b[31m${failures} 项失败\x1b[0m` : "\x1b[32m全部通过\x1b[0m");

// 临时工作区删掉；失败时留着日志会更有用，所以只在全绿时清理
if (!failures) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔有句柄没释放，删不掉不影响结论 */
  }
} else {
  console.log(`现场保留在 ${root}`);
}

process.exit(failures ? 1 : 0);
