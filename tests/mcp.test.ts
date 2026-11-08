/**
 * MCP 客户端与工具包装。
 *
 * 用 tests/fixtures/mcp-server.mjs 这个真进程跑，不打桩——这里要验的正是
 * 「进程起得来、JSON-RPC 对得上、超时退得出」，全 mock 掉就什么都验不到了。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, flattenContent, parseMcpConfig } from "../src/mcp/client.ts";
import { isMcpAllowed, loadMcpTools, mcpToolName, wrapMcpTool } from "../src/mcp/tools.ts";
import { AgentLoop } from "../src/core/loop.ts";
import type { ToolContext } from "../src/types.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-server.mjs");

function serverConfig(extra: Record<string, unknown> = {}) {
  return { command: process.execPath, args: [FIXTURE], ...extra };
}

function newClient(extra: Record<string, unknown> = {}): McpClient {
  return new McpClient("fixture", serverConfig(extra));
}

const ctx = { workspace: process.cwd() } as ToolContext;

test("起服务 → initialize → tools/list", async () => {
  const client = newClient();
  await client.start();
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ["echo", "fail-me", "slow", "with.image"]);
  assert.equal(tools[0].inputSchema.required[0], "text");
  // 服务端往 stdout 打的那行横幅应被当成噪音丢掉，而不是解析失败
  assert.equal(client.noiseLines, 1);
  await client.close();
});

test("调工具能拿到文本，isError 会被识别", async () => {
  const client = newClient();
  await client.start();
  const ok = await client.callTool("echo", { text: "你好" });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "你好");

  const bad = await client.callTool("fail-me", {});
  assert.equal(bad.ok, false);
  assert.equal(bad.text, "故意失败");
  await client.close();
});

test("超时会报超时，不会把整轮卡死", async () => {
  const client = newClient({ timeoutMs: 300 });
  await client.start();
  await assert.rejects(() => client.callTool("slow", {}), /超时/);
  await client.close();
});

test("服务端起不来时给出可读原因，不抛到顶层", async () => {
  const { tools, notes } = await loadMcpTools({
    config: { servers: { broken: serverConfig({ env: { FIXTURE_CRASH: "1" } }) } },
  });
  assert.equal(tools.length, 0);
  assert.match(notes.join("\n"), /broken：不可用/);
});

test("一台坏一台好：坏的不拖死好的", async () => {
  const { tools, notes, clients } = await loadMcpTools({
    config: {
      servers: {
        broken: serverConfig({ env: { FIXTURE_CRASH: "1" } }),
        good: serverConfig(),
      },
    },
  });
  assert.equal(tools.length, 4);
  assert.match(notes.join("\n"), /broken：不可用/);
  assert.match(notes.join("\n"), /good：4 个工具/);
  // 不留子进程：否则测试进程会被挂住，跑完不退出
  assert.equal(clients.length, 1);
  for (const c of clients) await c.close();
});

test("工具名带服务器前缀，且符合函数名约束", () => {
  assert.equal(mcpToolName("github", "create_issue"), "mcp__github__create_issue");
  assert.equal(mcpToolName("my server", "a.b/c"), "mcp__my_server__a_b_c");
  const long = mcpToolName("s".repeat(40), "t".repeat(60));
  assert.ok(long.length <= 64, `长度 ${long.length} 超过 64`);
});

test("没有确认入口时一律拒绝，并指明 --mcp-allow", async () => {
  const client = newClient();
  await client.start();
  const list = await client.listTools();
  const tool = wrapMcpTool(client, "fixture", list[0], undefined);
  const res = await tool.run({ text: "hi" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.content, /需要人工确认/);
  assert.match(res.content, /--mcp-allow/);
  assert.match(res.content, /不要重试/);
  await client.close();
});

test("确认被拒绝时不执行；确认通过才执行", async () => {
  const client = newClient();
  await client.start();
  const list = await client.listTools();
  const tool = wrapMcpTool(client, "fixture", list[0], undefined);

  let asked = "";
  const denied = await tool.run(
    { text: "hi" },
    { ...ctx, confirm: async (req) => { asked = req.title + req.detail; return false; } } as ToolContext,
  );
  assert.equal(denied.ok, false);
  assert.match(denied.content, /用户拒绝/);
  assert.match(asked, /fixture\.echo/);
  assert.match(asked, /外部进程/);

  const allowed = await tool.run({ text: "hi" }, { ...ctx, confirm: async () => true } as ToolContext);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.content, "hi");
  await client.close();
});

test("确认信息里的参数会被脱敏", async () => {
  const client = newClient();
  await client.start();
  const list = await client.listTools();
  const tool = wrapMcpTool(client, "fixture", list[0], undefined);
  let detail = "";
  await tool.run(
    { text: "x", token: "sk-abcdefghijk12345" },
    { ...ctx, confirm: async (req) => { detail = req.detail; return false; } } as ToolContext,
  );
  assert.ok(!detail.includes("sk-abcdefghijk12345"));
  await client.close();
});

test("--mcp-allow 放行后不再逐次询问", async () => {
  const client = newClient();
  await client.start();
  const list = await client.listTools();
  const tool = wrapMcpTool(client, "fixture", list[0], ["mcp__fixture__echo"]);
  let called = false;
  const res = await tool.run(
    { text: "go" },
    { ...ctx, confirm: async () => { called = true; return false; } } as ToolContext,
  );
  assert.equal(res.ok, true);
  assert.equal(res.content, "go");
  assert.equal(called, false, "已放行就不该再问");
  await client.close();
});

test("允许列表的四种写法", () => {
  assert.equal(isMcpAllowed("mcp__gh__a", ["*"]), true);
  assert.equal(isMcpAllowed("mcp__gh__a", ["mcp__gh__a"]), true);
  assert.equal(isMcpAllowed("mcp__gh__a", ["gh.a"]), true);
  assert.equal(isMcpAllowed("mcp__gh__a", ["gh"]), true, "只写服务器名应放行整台");
  assert.equal(isMcpAllowed("mcp__gh__a", ["other"]), false);
  assert.equal(isMcpAllowed("mcp__gh__a", []), false);
  assert.equal(isMcpAllowed("mcp__gh__a", undefined), false);
});

test("image 块不回灌正文，只留一句说明", () => {
  const text = flattenContent([
    { type: "text", text: "图在下面" },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.match(text, /图在下面/);
  assert.match(text, /image 内容已省略/);
  assert.ok(!text.includes("AAAA"));
});

test("parseMcpConfig 跳过缺 command 的条目并说明原因", () => {
  const { config, problems } = parseMcpConfig({
    servers: { ok: { command: "node", args: ["x.js"] }, bad: { args: [] } },
  });
  assert.deepEqual(Object.keys(config.servers), ["ok"]);
  assert.match(problems.join("\n"), /servers\.bad 缺少 command/);
});

test("loop 装上确认闸门后，MCP 工具的确认请求真的会问到人", async () => {
  // 这条守的是 loop.ts 里那一行 `...(this.opts.confirm ? { confirm } : {})`。
  // 少了它，CLI 里的确认弹窗永远不会出现，MCP 工具会被静默判成「无人确认」而拒绝，
  // 表现成「配了也调不动」，而所有单元用例都是绿的。
  const client = newClient();
  await client.start();
  const tool = wrapMcpTool(client, "fixture", (await client.listTools())[0], undefined);

  const provider = {
    name: "fake",
    requests: [] as unknown[],
    async *stream(req: unknown) {
      (this as { requests: unknown[] }).requests.push(req);
      if ((this as { requests: unknown[] }).requests.length === 1) {
        yield { toolCall: { index: 0, id: "c1", name: "mcp__fixture__echo", args: '{"text":"hi"}' } };
        yield { finish: "tool_calls" };
        return;
      }
      yield { text: "好了" };
      yield { finish: "stop" };
    },
  };

  const loop = new AgentLoop({
    provider: provider as never,
    model: "test",
    tools: [tool],
    workspace: process.cwd(),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    systemPrompt: "测试",
  });

  const asked: string[] = [];
  loop.setConfirm(async (req) => {
    asked.push(req.title);
    return true;
  });

  const outcome = await loop.submit("试一下");
  assert.equal(outcome, "done");
  assert.equal(asked.length, 1, "确认闸门应当被问一次");
  assert.match(asked[0], /fixture\.echo/);

  const second = (provider.requests[1] as { messages: Array<{ role: string; content?: string }> }).messages;
  const toolMsg = second.find((m) => m.role === "tool");
  assert.equal(toolMsg?.content, "hi", "确认通过后 MCP 的真实返回要回灌给模型");
  await client.close();
});
