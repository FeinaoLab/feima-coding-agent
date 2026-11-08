import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinTools } from "../src/tools/builtin.ts";
import { defaultPolicy } from "../src/safety/policy.ts";
import { createSandbox } from "../src/safety/exec.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "feima-tools-"));

function tool(name: string) {
  const list = builtinTools({ policy: defaultPolicy({ workspace }) });
  const found = list.find((t) => t.name === name);
  assert.ok(found, `没有 ${name} 工具`);
  return found;
}

test("list_dir：目录不存在必须报错，不能报「空目录」", async () => {
  // 真机端到端踩到的坑：模型把路径写错，拿到「（空目录）」，
  // 于是断定工作区是空的、任务没得做，直接收工。
  const r = await tool("list_dir").run({ path: "nope" }, { workspace, exec: async () => ({}) as never });
  assert.equal(r.ok, false, "不存在的目录被当成空目录了");
  assert.match(r.content, /不存在/);
});

test("list_dir：拿文件当目录也要说清楚，而不是返回空", async () => {
  fs.writeFileSync(path.join(workspace, "a.txt"), "x", "utf8");
  const r = await tool("list_dir").run({ path: "a.txt" }, { workspace, exec: async () => ({}) as never });
  assert.equal(r.ok, false);
  assert.match(r.content, /不是目录/);
});

test("list_dir：真空目录才说空，且列出内容时目录带斜杠", async () => {
  fs.mkdirSync(path.join(workspace, "empty"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "sub"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "sub", "b.txt"), "y", "utf8");

  const empty = await tool("list_dir").run({ path: "empty" }, { workspace, exec: async () => ({}) as never });
  assert.equal(empty.ok, true);
  assert.match(empty.content, /空目录/);

  const listed = await tool("list_dir").run({}, { workspace, exec: async () => ({}) as never });
  assert.equal(listed.ok, true);
  assert.match(listed.content, /sub\//, "目录要带斜杠后缀，模型才知道能不能进去");
  assert.match(listed.content, /a\.txt/);
});

test("list_dir：留空等同工作区根目录", async () => {
  const r = await tool("list_dir").run({ path: "  " }, { workspace, exec: async () => ({}) as never });
  assert.equal(r.ok, true);
  assert.match(r.content, /sub\//);
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("沙盒在只读工具链上装得起来（守住工具构造没被改坏）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feima-tools2-"));
  const sb = await createSandbox({ mode: "policy", policy: defaultPolicy({ workspace: dir }) });
  assert.ok(sb);
  await sb.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});
