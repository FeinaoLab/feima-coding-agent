import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session.ts";
import type { ChatMessage } from "../src/types.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "feima-sess-"));
}

function m(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content };
}

test("新建会话 → 追加消息 → 重新打开内容一致", () => {
  const dir = tmpDir();
  const store = SessionStore.create({ workspace: "D:/proj", model: "qwen3:8b" }, dir);
  store.appendMessage(m("user", "读一下 README"));
  store.appendMessage(m("assistant", "读完了，共 40 行"));

  const reopened = SessionStore.open(store.id, dir);
  const loaded = reopened.load();
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].content, "读一下 README");
  assert.equal(loaded.broken, 0);
  assert.equal(loaded.meta.workspace, "D:/proj");
  assert.equal(loaded.meta.model, "qwen3:8b");
});

test("标题自动取首条用户消息，且不会覆盖已有标题", () => {
  const dir = tmpDir();
  const a = SessionStore.create({ workspace: "D:/p", model: "m" }, dir);
  a.appendMessage(m("user", "帮我把飞码的压缩做完，然后跑测试"));
  assert.ok(a.meta.title.startsWith("帮我把飞码的压缩做完"));

  const b = SessionStore.create({ workspace: "D:/p", model: "m", title: "自定义标题" }, dir);
  b.appendMessage(m("user", "随便说点什么"));
  assert.equal(b.meta.title, "自定义标题");
});

test("崩溃留下的残行被跳过，不影响前面的历史", () => {
  const dir = tmpDir();
  const store = SessionStore.create({ workspace: "D:/p", model: "m" }, dir);
  store.appendMessage(m("user", "第一条"));
  store.appendMessage(m("assistant", "第二条"));

  // 模拟写到一半被 kill
  fs.appendFileSync(store.path, '{"t":"msg","m":{"role":"user","content":"半截', "utf8");

  store.appendMessage(m("assistant", "第三条"));
  const loaded = SessionStore.open(store.id, dir).load();
  assert.equal(loaded.messages.length, 3);
  assert.equal(loaded.broken, 1);
  assert.equal(loaded.messages[2].content, "第三条");
});

test("list 能列出会话并统计消息数，坏文件被忽略", () => {
  const dir = tmpDir();
  const a = SessionStore.create({ workspace: "D:/a", model: "m" }, dir);
  a.appendMessage(m("user", "甲"));
  const b = SessionStore.create({ workspace: "D:/b", model: "m" }, dir);
  b.appendMessage(m("user", "乙"));
  b.appendMessage(m("assistant", "回应"));

  fs.writeFileSync(path.join(dir, "garbage.jsonl"), "不是 JSON\n", "utf8");

  const list = SessionStore.list(dir);
  assert.equal(list.length, 2, "坏文件不应出现在列表里");
  const found = list.find((s) => s.id === b.id);
  assert.ok(found);
  assert.equal(found.messages, 2);
  assert.equal(found.turns, 1);
  assert.ok(found.bytes > 0);
});

test("open last 取最近更新的会话", () => {
  const dir = tmpDir();
  const first = SessionStore.create({ workspace: "D:/1", model: "m" }, dir);
  first.appendMessage(m("user", "早"));
  const second = SessionStore.create({ workspace: "D:/2", model: "m" }, dir);
  second.appendMessage(m("user", "晚"));

  // updatedAt 精度到毫秒，但同一毫秒内可能相同，这里显式把 second 推后
  const file = path.join(dir, `${second.id}.jsonl`);
  const raw = fs.readFileSync(file, "utf8").split("\n");
  const meta = JSON.parse(raw[0]);
  meta.meta.updatedAt = new Date(Date.now() + 5000).toISOString();
  raw[0] = JSON.stringify(meta);
  fs.writeFileSync(file, raw.join("\n"), "utf8");

  const last = SessionStore.open("last", dir);
  assert.equal(last.id, second.id);
});

test("版本过高的会话拒绝打开，提示升级", () => {
  const dir = tmpDir();
  const file = path.join(dir, "future.jsonl");
  fs.writeFileSync(
    file,
    JSON.stringify({ t: "meta", meta: { v: 99, id: "future", title: "未来", workspace: "D:/x", model: "m", createdAt: "", updatedAt: "" } }) + "\n",
    "utf8",
  );
  assert.throws(() => SessionStore.open("future", dir), /版本/);
});

test("压缩与用量记录被计入统计", () => {
  const dir = tmpDir();
  const store = SessionStore.create({ workspace: "D:/p", model: "m" }, dir);
  store.appendMessage(m("user", "开始"));
  store.appendCompact(3000, 900, 12);
  store.appendUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });

  const loaded = store.load();
  assert.equal(loaded.compacts, 1);
  assert.equal(loaded.usage?.total_tokens, 150);
  assert.ok(store.stats().tokens > 0);
});

test("删除会话后 open 报错，重复删除返回 false", () => {
  const dir = tmpDir();
  const store = SessionStore.create({ workspace: "D:/p", model: "m" }, dir);
  assert.equal(SessionStore.remove(store.id, dir), true);
  assert.equal(SessionStore.remove(store.id, dir), false);
  assert.throws(() => SessionStore.open(store.id, dir), /不存在/);
});

test("ID 只含安全字符，可安全拼路径", () => {
  const dir = tmpDir();
  const store = SessionStore.create({ workspace: "D:/p", model: "m" }, dir);
  assert.match(store.id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});
