import test from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "../src/cli/flags.ts";

test("解析 --json / --no-save / --workspace / --model", () => {
  const f = parseFlags(["任务文本", "--json", "--no-save", "--workspace", "D:/repo", "--model", "qwen3"]);
  assert.equal(f.json, true);
  assert.equal(f.noSave, true);
  assert.equal(f.workspace, "D:/repo");
  assert.equal(f.model, "qwen3");
  assert.deepEqual(f.rest, ["任务文本"]);
});

test("参数在任务文本之前也能解析", () => {
  const f = parseFlags(["--workspace", "D:/repo", "把测试跑一遍"]);
  assert.equal(f.workspace, "D:/repo");
  assert.deepEqual(f.rest, ["把测试跑一遍"]);
});

test("缺值时报错，不静默变成 undefined", () => {
  // 静默失败的后果：Agent 在 cwd 里改文件，用户以为限制在指定目录
  assert.throws(() => parseFlags(["任务", "--workspace"]), /需要一个值/);
  assert.throws(() => parseFlags(["任务", "--model", "--json"]), /需要一个值/);
});

test("-- 之后的内容原样作为任务，不被当作参数", () => {
  const f = parseFlags(["run", "--", "解释一下 --json 这个参数"]);
  assert.equal(f.json, false);
  assert.deepEqual(f.rest, ["run", "解释一下 --json 这个参数"]);
});

test("没有参数时全部落到 rest", () => {
  const f = parseFlags(["读 README 并总结"]);
  assert.equal(f.json, false);
  assert.equal(f.workspace, undefined);
  assert.deepEqual(f.rest, ["读 README 并总结"]);
});
