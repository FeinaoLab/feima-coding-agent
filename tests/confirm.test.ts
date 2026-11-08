import test from "node:test";
import assert from "node:assert/strict";
import { confirmTitle, needsConfirm, parseConfirmMode, summarizeArgs } from "../src/safety/confirm.ts";

test("确认模式解析：只认五个值，其余返回 null 让调用方报错", () => {
  for (const mode of ["off", "write", "exec", "external", "all"] as const) {
    assert.equal(parseConfirmMode(mode), mode);
  }
  assert.equal(parseConfirmMode("  WRITE "), "write");
  assert.equal(parseConfirmMode("yes"), null);
  assert.equal(parseConfirmMode(""), null);
});

test("各模式下的确认范围", () => {
  // 只读工具永远不问
  for (const mode of ["off", "write", "exec", "external", "all"] as const) {
    assert.equal(needsConfirm(["read"], mode), false, `read 在 ${mode} 下不该问`);
  }

  assert.equal(needsConfirm(["write"], "off"), false);
  assert.equal(needsConfirm(["write"], "write"), true);
  assert.equal(needsConfirm(["write"], "exec"), true, "能执行就能写，exec 档要把写文件一起管住");
  assert.equal(needsConfirm(["write"], "all"), true);

  assert.equal(needsConfirm(["exec"], "off"), false);
  assert.equal(needsConfirm(["exec"], "write"), false, "write 档只写文件，不含执行");
  assert.equal(needsConfirm(["exec"], "exec"), true);
  assert.equal(needsConfirm(["exec"], "all"), true);
});

test("external 无论什么模式都必须问——用户关掉确认不等于允许一个管不了的东西", () => {
  for (const mode of ["off", "write", "exec", "external", "all"] as const) {
    assert.equal(needsConfirm(["external"], mode), true, `${mode} 下 external 仍要确认`);
  }
});

test("没写 effects 视为只读，不会因为漏标被当成有副作用", () => {
  assert.equal(needsConfirm(undefined, "all"), false);
});

test("参数摘要不糊整段 content，只报大小", () => {
  const content = "a".repeat(5000);
  const text = summarizeArgs("write_file", { path: "src/a.ts", content });
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /5000 字符/);
  assert.ok(text.length < 200, `摘要不该把 5000 字符塞进去：${text.length}`);
});

test("参数摘要会把疑似密钥抹掉", () => {
  const text = summarizeArgs("mcp__github__create_issue", { token: "ghp_abcdefghijklmnopqrstuvwxyz012345" });
  assert.ok(!text.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"), `应已脱敏：${text}`);
  assert.match(text, /ghp_/);
});

test("命令类工具的摘要带完整命令，改文件带替换前后", () => {
  assert.match(summarizeArgs("bash", { command: "npm test", timeout_ms: 5000 }), /npm test/);
  const edit = summarizeArgs("edit_file", { path: "a.ts", old_string: "旧", new_string: "新" });
  assert.match(edit, /替换: 旧 → 新/);
});

test("标题说人话：让人不看参数就知道要发生什么", () => {
  assert.equal(confirmTitle("bash", ["exec", "write"]), "执行命令");
  assert.equal(confirmTitle("write_file", ["write"]), "写文件");
  assert.equal(confirmTitle("mcp__x__y", ["external"]), "调用外部工具 mcp__x__y");
});

// ===== 以下是集成用例：确认闸门在 loop 里是否真的拦在执行之前 =====

import { AgentLoop } from "../src/core/loop.ts";
import type { AgentEvent, Effect, ProviderEvent, StreamRequest, Tool } from "../src/types.ts";

/** 第一轮要求调用某个工具，第二轮说「好了」 */
function scriptedProvider(toolName: string, args: Record<string, unknown>) {
  let round = 0;
  const requests: StreamRequest[] = [];
  return {
    name: "fake",
    requests,
    async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent, void, void> {
      requests.push(req);
      round++;
      if (round === 1) {
        yield { toolCall: { index: 0, id: "c1", name: toolName, args: JSON.stringify(args) } };
        yield { finish: "tool_calls" };
        return;
      }
      yield { text: "好了" };
      yield { finish: "stop" };
    },
  };
}

function countingTool(name: string, effects: Effect[]): Tool & { calls: number } {
  const tool = {
    calls: 0,
    name,
    description: "测试工具",
    effects,
    parameters: { type: "object", properties: {} },
    async run() {
      tool.calls++;
      return { ok: true, content: "执行了" };
    },
  };
  return tool;
}

function run(
  provider: ReturnType<typeof scriptedProvider>,
  tool: Tool,
  opts: {
    confirmMode?: "off" | "write" | "exec" | "external" | "all";
    confirm?: (req: { title: string; detail: string }) => Promise<boolean>;
    assumeYes?: boolean;
  },
) {
  const events: AgentEvent[] = [];
  const loop = new AgentLoop({
    provider,
    model: "t",
    tools: [tool],
    workspace: process.cwd(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    systemPrompt: "测试",
    ...(opts.confirmMode ? { confirmMode: opts.confirmMode } : {}),
    ...(opts.assumeYes ? { assumeYes: true } : {}),
  });
  if (opts.confirm) loop.setConfirm(opts.confirm);
  loop.setEventHandler((e) => events.push(e));
  return { loop, events };
}

function toolMessage(provider: ReturnType<typeof scriptedProvider>): string {
  const second = provider.requests[1]?.messages ?? [];
  return second.find((m) => m.role === "tool")?.content ?? "";
}

test("off 模式下写文件不问，直接执行", async () => {
  const provider = scriptedProvider("write_file", { path: "a.txt", content: "x" });
  const tool = countingTool("write_file", ["write"]);
  const { loop } = run(provider, tool, { confirmMode: "off" });
  assert.equal(await loop.submit("写个文件"), "done");
  assert.equal(tool.calls, 1);
});

test("write 模式下先问再执行，确认框里能看见参数", async () => {
  const provider = scriptedProvider("write_file", { path: "a.txt", content: "hello" });
  const tool = countingTool("write_file", ["write"]);
  const asked: Array<{ title: string; detail: string }> = [];
  const { loop } = run(provider, tool, {
    confirmMode: "write",
    confirm: async (req) => {
      asked.push(req);
      return true;
    },
  });
  assert.equal(await loop.submit("写个文件"), "done");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "写文件");
  assert.match(asked[0].detail, /a\.txt/, "确认框必须让人看到改的是哪个文件");
  assert.equal(tool.calls, 1);
});

test("用户拒绝后工具根本不执行，模型收到的是拒绝原因", async () => {
  const provider = scriptedProvider("bash", { command: "rm -rf build" });
  const tool = countingTool("bash", ["exec", "write"]);
  const { loop } = run(provider, tool, { confirmMode: "exec", confirm: async () => false });
  assert.equal(await loop.submit("清理一下"), "done");
  assert.equal(tool.calls, 0, "拒绝就是一次都不能跑");
  assert.match(toolMessage(provider), /用户拒绝/);
  assert.match(toolMessage(provider), /不要换别的方式重试/, "拒绝之后要堵住「换个写法再来一次」");
});

test("要求确认但没人可问时按拒绝处理，不放行", async () => {
  // 这就是 `feima run` 的真实处境：没有 stdin 能回答问题
  const provider = scriptedProvider("bash", { command: "echo hi" });
  const tool = countingTool("bash", ["exec"]);
  const { loop } = run(provider, tool, { confirmMode: "exec" });
  assert.equal(await loop.submit("跑一条命令"), "done");
  assert.equal(tool.calls, 0);
  assert.match(toolMessage(provider), /没有可交互的确认入口/);
  assert.match(toolMessage(provider), /--yes/);
  // 真机验证踩到的坑：模型把「确认策略拦了」读成「文件系统只读」，
  // 于是一路换写法重试，最后建议用户「用管理员身份运行」。
  // 拒绝理由必须显式否认权限问题，并明说重试无用。
  assert.match(toolMessage(provider), /不是文件系统权限问题/);
  assert.match(toolMessage(provider), /重试都会被同样拒绝/);
});

test("显式 --yes 才放行，并且提示一次", async () => {
  const provider = scriptedProvider("bash", { command: "echo hi" });
  const tool = countingTool("bash", ["exec"]);
  const { loop, events } = run(provider, tool, { confirmMode: "exec", assumeYes: true });
  assert.equal(await loop.submit("跑一条命令"), "done");
  assert.equal(tool.calls, 1);
  assert.equal(events.filter((e) => e.type === "notice").length, 1);
});

test("external 工具即使 off 模式也要问——用户关确认不等于允许管不了的东西", async () => {
  const provider = scriptedProvider("echo_tool", { text: "hi" });
  // selfConfirmed 的工具自己管确认；这里用一个不 selfConfirmed 的 external 工具，
  // 验证 loop 这一层不会因为 mode=off 就把它漏过去
  const tool = countingTool("echo_tool", ["external"]);
  let asked = 0;
  const { loop } = run(provider, tool, {
    confirmMode: "off",
    confirm: async () => {
      asked++;
      return false;
    },
  });
  assert.equal(await loop.submit("调外部工具"), "done");
  assert.equal(asked, 1, "external 必须问");
  assert.equal(tool.calls, 0);
});
