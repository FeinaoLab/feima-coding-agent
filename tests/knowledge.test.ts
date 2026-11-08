/**
 * 飞链 RAG 检索工具。
 *
 * 全部用注入的 fetch 跑，不联网：这里要验的是「接口契约与输出纪律」，
 * 不是「服务器今天开没开」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  createKnowledgeTool,
  formatHits,
  knowledgeConfigured,
  parseHits,
  type KnowledgeHit,
} from "../src/tools/knowledge.ts";
import type { ToolContext } from "../src/types.ts";

const ctx = { workspace: process.cwd() } as ToolContext;

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init ?? {});
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const HITS = {
  code: 200,
  message: "操作成功",
  data: [
    { snippet: "标题：飞码立项书 摘要：隔离后端 M3 已完成", score: 18.8, documentId: 782, title: "飞码立项书", chunkIndex: 0, chunkId: 34578 },
    { snippet: "线程池隔离 vs 信号量隔离", score: 12.2, documentId: 661, title: "隔离模式", chunkIndex: 3, chunkId: 25018 },
  ],
};

test("未配置 url 时不启用，doctor 靠这个判断「跳过」", () => {
  assert.equal(knowledgeConfigured({ url: "" }), false);
  assert.equal(knowledgeConfigured(null), false);
  assert.equal(knowledgeConfigured({ url: "  " }), false);
  assert.equal(knowledgeConfigured({ url: "http://kb.local" }), true);
});

test("命中时输出带编号的片段，并提示引用方式", async () => {
  const tool = createKnowledgeTool({
    url: "http://kb.local/",
    token: "t",
    fetchImpl: fakeFetch(() => ({ body: HITS })),
  });
  const res = await tool.run({ query: "隔离后端" }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.content, /检索到 2 条/);
  assert.match(res.content, /\[1\] 飞码立项书 · doc 782 · score 18\.8/);
  assert.match(res.content, /\[2\] 隔离模式 · doc 661/);
  assert.match(res.content, /引用时写成 \[1\]/);
  // 结尾多一个斜杠不能拼出 //api
  assert.match(res.content, /知识库片段，不是工作区文件/);
});

test("空结果给出可执行的下一步，而不是一句「无结果」", async () => {
  const tool = createKnowledgeTool({
    url: "http://kb.local",
    token: "t",
    fetchImpl: fakeFetch(() => ({ body: { code: 200, data: [] } })),
  });
  const res = await tool.run({ query: "不存在的词" }, ctx);
  assert.equal(res.ok, true);
  assert.match(res.content, /没有检索到/);
  assert.match(res.content, /换一种说法|grep/);
});

test("只给账号密码时先登录取 token，且 token 只取一次", async () => {
  const calls: string[] = [];
  const tool = createKnowledgeTool({
    url: "http://kb.local",
    username: "admin",
    password: "pw",
    fetchImpl: fakeFetch((url) => {
      calls.push(url);
      if (url.endsWith("/api/auth/login")) return { body: { code: 200, data: { token: "jwt-1" } } };
      return { body: HITS };
    }),
  });
  await tool.run({ query: "a" }, ctx);
  await tool.run({ query: "b" }, ctx);
  assert.equal(calls.filter((u) => u.endsWith("/api/auth/login")).length, 1, "token 应缓存");
  assert.equal(calls.filter((u) => u.endsWith("/api/ai/search")).length, 2);
});

test("登录失败要说清是登录问题，不能伪装成检索失败", async () => {
  const tool = createKnowledgeTool({
    url: "http://kb.local",
    username: "admin",
    password: "bad",
    fetchImpl: fakeFetch(() => ({ status: 401, body: { code: 401, message: "密码错误" } })),
  });
  const res = await tool.run({ query: "a" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.content, /登录失败/);
  assert.match(res.content, /密码错误/);
});

test("接口 code 非 200 时把 message 带出来", async () => {
  const tool = createKnowledgeTool({
    url: "http://kb.local",
    token: "t",
    fetchImpl: fakeFetch(() => ({ body: { code: 500, message: "索引重建中" } })),
  });
  const res = await tool.run({ query: "a" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.content, /code=500/);
  assert.match(res.content, /索引重建中/);
});

test("返回结构不认识时报错，不静默当成空结果", async () => {
  const tool = createKnowledgeTool({
    url: "http://kb.local",
    token: "t",
    fetchImpl: fakeFetch(() => ({ body: { hello: "world" } })),
  });
  const res = await tool.run({ query: "a" }, ctx);
  assert.equal(res.ok, false);
  assert.match(res.content, /结构不认识/);
});

test("凭据不会出现在错误信息里", async () => {
  const tool = createKnowledgeTool({
    url: "http://kb.local",
    token: "sk-supersecretvalue123",
    fetchImpl: fakeFetch(() => ({ status: 500, body: "boom sk-supersecretvalue123" })),
  });
  const res = await tool.run({ query: "a" }, ctx);
  assert.equal(res.ok, false);
  assert.ok(!res.content.includes("sk-supersecretvalue123"));
});

test("单条片段截断到 400 字以内，避免一条吃掉半个上下文", () => {
  const long: KnowledgeHit[] = [
    { snippet: "字".repeat(2000), score: 1, documentId: 1, title: "长文", chunkIndex: 0, chunkId: 1 },
  ];
  const out = formatHits(long, "长");
  assert.ok(out.includes("…"));
  // 400 字片段 + 标题行 + 提示语，总量应远小于 2000
  assert.ok(out.length < 700);
});

test("高亮标签被剥掉，避免把 <em> 当成 Markdown 灌进上下文", () => {
  const out = formatHits([{ snippet: "<em>隔离</em>后端", score: 1, documentId: 1, title: "t", chunkIndex: 0, chunkId: 1 }], "q");
  assert.ok(!out.includes("<em>"));
  assert.match(out, /隔离后端/);
});

test("parseHits 兼容顶层就是数组的返回", () => {
  const hits = parseHits([{ snippet: "x", score: 2, documentId: 9, title: "t", chunkIndex: 0, chunkId: 1 }]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].documentId, 9);
});
