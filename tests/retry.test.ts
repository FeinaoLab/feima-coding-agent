import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RETRY, NO_RETRY, backoffDelay, sleep, withRetry } from "../src/core/retry.ts";

/** 固定随机数，让抖动可断言 */
const fixed = (v: number) => () => v;

test("退避是指数增长并封顶", () => {
  const policy = { attempts: 5, baseMs: 100, maxMs: 1000, jitter: 0 };
  assert.equal(backoffDelay(1, policy), 100);
  assert.equal(backoffDelay(2, policy), 200);
  assert.equal(backoffDelay(3, policy), 400);
  assert.equal(backoffDelay(4, policy), 800);
  // 第 5 次理论值 1600，必须封在 1000
  assert.equal(backoffDelay(5, policy), 1000);
  assert.equal(backoffDelay(9, policy), 1000);
});

test("抖动只在区间内浮动，不会把等待压到负数", () => {
  const policy = { attempts: 3, baseMs: 1000, maxMs: 1000, jitter: 0.5 };
  assert.equal(backoffDelay(1, policy, fixed(0)), 500);
  assert.equal(backoffDelay(1, policy, fixed(0.5)), 1000);
  assert.equal(backoffDelay(1, policy, fixed(1)), 1500);
});

test("不重试时等待恒为 0", () => {
  assert.equal(backoffDelay(1, NO_RETRY), 0);
  assert.equal(backoffDelay(3, { ...DEFAULT_RETRY, attempts: 1 }), 0);
});

test("可重试的错误会重试，并把尝试次数传进去", async () => {
  const attempts: number[] = [];
  const result = await withRetry(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw Object.assign(new Error("429"), { retryable: true });
      return "ok";
    },
    {
      policy: { attempts: 3, baseMs: 1, maxMs: 2, jitter: 0 },
      isRetryable: (err) => Boolean((err as { retryable?: boolean }).retryable),
      hasSideEffect: () => false,
      sleep: async () => {},
    },
  );
  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("不可重试的错误一次就抛，不带等待", async () => {
  let calls = 0;
  let waited = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("400 参数错误"), { retryable: false });
        },
        {
          policy: { attempts: 3, baseMs: 10, maxMs: 10, jitter: 0 },
          isRetryable: (err) => Boolean((err as { retryable?: boolean }).retryable),
          hasSideEffect: () => false,
          sleep: async () => {
            waited++;
          },
        },
      ),
    /参数错误/,
  );
  assert.equal(calls, 1);
  assert.equal(waited, 0);
});

test("已经产生副作用时立刻放弃重试——这条比多试几次更重要", async () => {
  // 模拟：流里已经吐出一段文本，然后连接断了。
  // 此时重试会把同一段话发第二遍，用户看到重复输出；
  // 如果吐的是工具参数，更糟——同一个命令会被执行两次。
  let produced = false;
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          produced = true;
          throw Object.assign(new Error("连接中断"), { retryable: true });
        },
        {
          policy: { attempts: 5, baseMs: 1, maxMs: 1, jitter: 0 },
          isRetryable: () => true,
          hasSideEffect: () => produced,
          sleep: async () => {},
        },
      ),
    /连接中断/,
  );
  assert.equal(calls, 1, "有副作用就只能试一次");
});

test("次数用尽抛原始错误，不包装成「重试失败」", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw Object.assign(new Error("503 上游不可用"), { retryable: true });
        },
        {
          policy: { attempts: 3, baseMs: 1, maxMs: 1, jitter: 0 },
          isRetryable: () => true,
          hasSideEffect: () => false,
          sleep: async () => {},
        },
      ),
    (err: unknown) => {
      assert.match((err as Error).message, /503 上游不可用/);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("中止信号会让重试立刻停手", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = withRetry(
    async () => {
      calls++;
      controller.abort();
      throw Object.assign(new Error("连接失败"), { retryable: true });
    },
    {
      policy: { attempts: 5, baseMs: 1, maxMs: 1, jitter: 0 },
      isRetryable: () => true,
      hasSideEffect: () => false,
      signal: controller.signal,
      sleep,
    },
  );
  await assert.rejects(pending, /连接失败/);
  assert.equal(calls, 1, "已中止就不再重试");
});

test("onRetry 会把等待时间报出来，界面才能显示「正在重试」", async () => {
  const seen: number[] = [];
  await withRetry(
    async (attempt) => {
      if (attempt < 2) throw Object.assign(new Error("429"), { retryable: true });
      return 1;
    },
    {
      policy: { attempts: 2, baseMs: 100, maxMs: 100, jitter: 0 },
      isRetryable: () => true,
      hasSideEffect: () => false,
      onRetry: (info) => seen.push(info.delayMs),
      sleep: async () => {},
    },
  );
  assert.deepEqual(seen, [100]);
});

test("wait 为 0 时不排定时器，直接返回", async () => {
  const started = Date.now();
  await sleep(0);
  assert.ok(Date.now() - started < 50);
});

test("已经中止的信号上等待直接返回，不会卡住退出", async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await sleep(5000, controller.signal);
  assert.ok(Date.now() - started < 50);
});

// 下面两条是集成用例：纯函数测的是策略，这里测的是「loop 有没有真的按策略行事」。
// 只测纯函数会漏掉最关键的一环——produced 标志到底有没有被置起来。

test("loop：建连阶段失败会重试，第二次成功则正常收敛", async () => {
  const { AgentLoop } = await import("../src/core/loop.ts");
  const requests: unknown[] = [];
  const provider = {
    name: "fake",
    async *stream() {
      requests.push(1);
      if (requests.length === 1) throw Object.assign(new Error("连接模型服务失败"), { retryable: true });
      yield { text: "好了" };
      yield { finish: "stop" };
    },
  };
  const events: Array<{ type: string }> = [];
  const loop = new AgentLoop({
    provider,
    model: "t",
    tools: [],
    workspace: process.cwd(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    systemPrompt: "测试",
    retry: { attempts: 3, baseMs: 0, maxMs: 0, jitter: 0 },
  });
  loop.setEventHandler((e) => events.push(e));

  const outcome = await loop.submit("试一下");
  assert.equal(outcome, "done");
  assert.equal(requests.length, 2, "第一次失败后应当重试一次");
  assert.ok(events.some((e) => e.type === "retry"), "重试要有事件，否则用户只看到卡住");
});

test("loop：已经吐出正文后断流，绝不重试（否则用户会看到同一段话两遍）", async () => {
  const { AgentLoop } = await import("../src/core/loop.ts");
  let calls = 0;
  const provider = {
    name: "fake",
    async *stream() {
      calls++;
      yield { text: "第一段已经发出去了" };
      throw Object.assign(new Error("流中断"), { retryable: true });
    },
  };
  const events: Array<{ type: string }> = [];
  const loop = new AgentLoop({
    provider,
    model: "t",
    tools: [],
    workspace: process.cwd(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    systemPrompt: "测试",
    retry: { attempts: 5, baseMs: 0, maxMs: 0, jitter: 0 },
  });
  loop.setEventHandler((e) => events.push(e));

  const outcome = await loop.submit("试一下");
  assert.equal(outcome, "error");
  assert.equal(calls, 1, "吐过内容就不允许重试");
  const texts = events.filter((e) => e.type === "text_delta").length;
  assert.equal(texts, 1, "只应出现一次正文");
});
