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

test("沙盒与隔离相关参数能被解析出来", () => {
  const f = parseFlags(["--sandbox", "strict", "--isolation", "docker", "--network", "--docker-image", "node:20", "干活"]);
  assert.equal(f.sandbox, "strict");
  assert.equal(f.isolation, "docker");
  assert.equal(f.network, true);
  assert.equal(f.dockerImage, "node:20");
  assert.deepEqual(f.rest, ["干活"]);
});

test("非法沙盒模式与后端名直接报错，不留到运行时", () => {
  assert.throws(() => parseFlags(["--sandbox", "loose"]), /policy|strict/);
  assert.throws(() => parseFlags(["--isolation", "firejail"]), /appcontainer|bwrap/);
});

test("新参数缺值时同样报错，不静默变成 undefined", () => {
  for (const flag of ["--sandbox", "--isolation", "--docker-image"]) {
    assert.throws(() => parseFlags([flag]), /需要一个值/, `${flag} 缺值应当报错`);
  }
});
