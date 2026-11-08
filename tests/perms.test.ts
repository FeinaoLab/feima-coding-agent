import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinTools, filterByPerms } from "../src/tools/builtin.ts";
import { defaultPolicy } from "../src/safety/policy.ts";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "feima-perms-"));
const all = builtinTools({ policy: defaultPolicy({ workspace }) });
const names = (level: "read" | "write" | "exec"): string[] =>
  filterByPerms(all, level).map((t) => t.name).sort();

test("read 档只有只读工具", () => {
  const got = names("read");
  assert.deepEqual(got, ["glob", "grep", "list_dir", "read_file"]);
  assert.ok(!got.includes("bash"), "只读档不该给命令执行");
});

test("write 档加写文件，仍然不给命令", () => {
  const got = names("write");
  assert.ok(got.includes("write_file") && got.includes("edit_file"));
  assert.ok(!got.includes("bash"));
});

test("exec 档给全部内置工具", () => {
  assert.deepEqual(names("exec"), ["bash", "edit_file", "glob", "grep", "list_dir", "read_file", "write_file"]);
});

test("过滤是按名字减，不会改动工具对象本身", () => {
  // 反过来写（按档位白名单加）容易漏掉新加的工具，
  // 这条用例守着「默认全给、按档位减」的方向
  assert.equal(all.length, 7);
  assert.equal(filterByPerms(all, "read").length, 4);
});
