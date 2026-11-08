import test from "node:test";
import assert from "node:assert/strict";
import { RepeatGuard, callSignature, failureReason } from "../src/core/repeat.ts";
import { AgentLoop } from "../src/core/loop.ts";
import type { AgentEvent, ProviderEvent, StreamRequest, Tool } from "../src/types.ts";

test("失败原因只取首行，并把数字抹平——否则「同一堵墙」会被当成不同的墙", () => {
  const a = failureReason("错误：命令不在白名单内：node --version\n允许的前缀：node --test");
  const b = failureReason("错误：命令不在白名单内：node --version\n允许的前缀：npm test");
  assert.equal(a, b, "第二行不该参与比较");
  assert.match(a ?? "", /不在白名单/);

  // 报错里常带耗时、行号，每次都不一样；不归一化就永远数不到一起
  const c = failureReason("错误：命令超时 30000 ms");
  const d = failureReason("错误：命令超时 12000 ms");
  assert.equal(c, d);

  assert.equal(failureReason("执行成功"), null, "成功不该算失败原因");
  assert.equal(failureReason(""), null);
});

test("调用签名对参数键序不敏感，但参数不同就是不同签名", () => {
  assert.equal(
    callSignature("bash", '{"command":"ls","timeout_ms":1000}'),
    callSignature("bash", '{"timeout_ms":1000,"command":"ls"}'),
  );
  assert.notEqual(callSignature("bash", '{"command":"ls"}'), callSignature("bash", '{"command":"ls -a"}'));
  assert.notEqual(callSignature("bash", '{"command":"ls"}'), callSignature("read_file", '{"command":"ls"}'));
  // 参数不是合法 JSON 时不能抛：它本来就会被判成参数错误
  assert.doesNotThrow(() => callSignature("bash", "{半截参数"));
});

test("同一个失败原因重复到阈值：先提醒，再中止", () => {
  const guard = new RepeatGuard();
  const fail = "错误：命令不在白名单内：node --version";
  const seen: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const v = guard.observe(`tool${i}`, `sig${i}`, `${fail}（第 ${i} 次）`);
    if (v) seen.push(v.kind);
  }
  assert.deepEqual(seen, ["warn"], "第 3 次提醒一次，第 4 次还没到中止线");
  const stop = guard.observe("tool5", "sig5", `${fail}（第 5 次）`);
  assert.equal(stop?.kind, "stop");
});

test("同一个工具连续失败也算空转——换写法不等于换思路", () => {
  const guard = new RepeatGuard();
  const kinds: string[] = [];
  for (const [i, cmd] of ["node --version", "npm --version", "where node", "node -v"].entries()) {
    const v = guard.observe("bash", `bash|${cmd}`, `错误：命令不在白名单内：${cmd}`);
    if (v) kinds.push(v.kind);
    assert.ok(i < 5);
  }
  assert.deepEqual(kinds, ["warn"], "第 3 次连续失败该提醒");
});

test("成功一次就把「连续失败」清零，不会把正常的试错算成空转", () => {
  const guard = new RepeatGuard();
  // 每次失败的原因都不一样：这条用例只验「连续失败」这条规则，
  // 不能让「同一失败原因」那条掺和进来
  assert.equal(guard.observe("bash", "a", "错误：退出码 1"), null);
  assert.equal(guard.observe("bash", "b", "错误：找不到文件 a.txt"), null);
  assert.equal(guard.observe("bash", "c", "退出码 0 全绿"), null, "成功打断了连续失败");
  assert.equal(guard.observe("bash", "d", "错误：退出码 2"), null, "计数应从 1 重新开始");
  assert.equal(guard.observe("bash", "e", "错误：权限不足"), null);
});

test("完全相同的调用重复到阈值会提醒，且阈值比失败计数宽松", () => {
  const guard = new RepeatGuard();
  const kinds: string[] = [];
  for (let i = 0; i < 4; i++) {
    const v = guard.observe("read_file", "read_file|a.txt", "文件内容");
    if (v) kinds.push(v.kind);
  }
  assert.deepEqual(kinds, ["warn"], "读同一个文件四次只提醒，不中止");
});

test("窗口外的旧记录不参与计数：改了做法就不该被翻旧账", () => {
  const guard = new RepeatGuard({ window: 3 });
  guard.observe("bash", "a", "错误：同一个失败");
  guard.observe("bash", "b", "错误：同一个失败");
  guard.observe("bash", "c", "执行成功");
  guard.observe("bash", "d", "执行成功");
  // 前两条已经被窗口挤掉，即使失败原因相同也不该立刻触发
  const v = guard.observe("bash", "e", "错误：同一个失败");
  assert.equal(v, null);
});

test("reset 之后不再累计：新一轮任务重新读同一个文件是正当的", () => {
  const guard = new RepeatGuard();
  guard.observe("read_file", "s", "内容");
  guard.observe("read_file", "s", "内容");
  guard.reset();
  assert.equal(guard.observe("read_file", "s", "内容"), null);
});

// ===== 集成：这层挂进 loop 之后，模型真能收到提醒吗 =====

/** 每一轮都用同样的参数调同一个工具，永远失败 */
function loopingProvider(toolName: string, args: Record<string, unknown>) {
  const requests: StreamRequest[] = [];
  return {
    name: "fake",
    requests,
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
      requests.push(req);
      yield { toolCall: { index: 0, id: `c${requests.length}`, name: toolName, args: JSON.stringify(args) } };
      yield { finish: "tool_calls" };
    },
  };
}

function alwaysFailingTool(name: string): Tool {
  return {
    name,
    description: "总是失败",
    effects: ["exec"],
    parameters: { type: "object", properties: {} },
    async run() {
      return { ok: false, content: "命令不在白名单内：node --version" };
    },
  };
}

test("loop 里撞墙三次：工具结果带上提醒，用户也能看到 notice", async () => {
  const provider = loopingProvider("bash", { command: "node --version" });
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    provider,
    model: "t",
    tools: [alwaysFailingTool("bash")],
    workspace: process.cwd(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    systemPrompt: "测试",
  });
  loop.setEventHandler((e) => events.push(e));

  const outcome = await loop.submit("看下版本");
  assert.equal(outcome, "error", "连续撞同一堵墙应该被中止，而不是把轮次烧完");

  const notices = events.filter((e) => e.type === "notice");
  assert.ok(notices.length >= 1, "提醒必须同时发给用户，否则界面上只看到模型莫名收尾");

  const toolMessages = loop.getHistory().filter((m) => m.role === "tool");
  assert.ok(
    toolMessages.some((m) => /提醒：/.test(m.content ?? "")),
    "模型这一侧也要看到提醒，否则它不知道自己在空转",
  );
  // 提醒之后还继续撞才会中止：第三条提醒，第五条中止
  assert.ok(toolMessages.length >= 3 && toolMessages.length <= 6, `撞墙次数异常：${toolMessages.length}`);
});

test("repeatGuard: false 时完全不装这一层（调试提示词时用）", async () => {
  const provider = loopingProvider("bash", { command: "node --version" });
  const loop = new AgentLoop({
    provider,
    model: "t",
    tools: [alwaysFailingTool("bash")],
    workspace: process.cwd(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    systemPrompt: "测试",
    repeatGuard: false,
    maxTurns: 2,
  });
  const outcome = await loop.submit("看下版本");
  // 关掉之后不会再因为重复被中止，只会撞到轮次上限
  assert.equal(outcome, "error");
  const toolMessages = loop.getHistory().filter((m) => m.role === "tool");
  assert.ok(!toolMessages.some((m) => /提醒：/.test(m.content ?? "")), "关掉之后不该有提醒");
});
