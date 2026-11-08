import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ENV_ALLOWLIST,
  assertWorkspace,
  defaultPolicy,
  filterEnv,
  isInside,
  realpathLoose,
  redact,
  resolveRead,
  resolveWrite,
  PolicyError,
} from "../src/safety/policy.ts";

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feima-test-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  return dir;
}

test("环境变量白名单只放行 16 类变量", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    LANG: "zh_CN.UTF-8",
    ANTHROPIC_API_KEY: "sk-secret",
    DEEPSEEK_API_KEY: "sk-secret2",
    AWS_SECRET_ACCESS_KEY: "x",
    RANDOM_VAR: "y",
  };
  const out = filterEnv(env as NodeJS.ProcessEnv);
  assert.equal(out.PATH, "/usr/bin");
  assert.equal(out.HOME, "/home/x");
  assert.equal(out.ANTHROPIC_API_KEY, undefined);
  assert.equal(out.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(out.RANDOM_VAR, undefined);
  assert.equal(out.TERM, "dumb");
  assert.equal(out.NO_COLOR, "1");
  assert.ok(ENV_ALLOWLIST.test("LC_ALL"));
  assert.ok(!ENV_ALLOWLIST.test("OPENAI_API_KEY"));
});

test("工作区外的路径被拒绝", () => {
  const ws = tmpWorkspace();
  const policy = defaultPolicy({ workspace: ws, home: path.join(ws, "home") });
  assert.throws(() => resolveRead(policy, "../outside.txt"), /越界/);
  assert.throws(() => resolveWrite(policy, "../evil.sh"), /越界/);
});

test(".git/hooks 与 node_modules 禁止写入", () => {
  const ws = tmpWorkspace();
  assertWorkspace(ws);
  const policy = defaultPolicy({ workspace: ws, home: path.join(ws, "home") });
  fs.mkdirSync(path.join(ws, ".git", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(ws, "node_modules", "x"), { recursive: true });

  assert.throws(
    () => resolveWrite(policy, ".git/hooks/pre-commit"),
    (err: unknown) => err instanceof PolicyError && err.code === "DENY_WRITE",
  );
  assert.throws(() => resolveWrite(policy, "node_modules/x/index.js"), /禁止写入/);
  // 正常写入仍然放行
  const ok = resolveWrite(policy, "src/b.ts");
  assert.ok(ok.endsWith("b.ts"));
});

test(".env 禁止读取", () => {
  const ws = tmpWorkspace();
  fs.writeFileSync(path.join(ws, ".env"), "KEY=1\n");
  const policy = defaultPolicy({ workspace: ws, home: path.join(ws, "home") });
  assert.throws(() => resolveRead(policy, ".env"), /禁止读取/);
});

test("符号链接指向外部时不能绕过", (t) => {
  const ws = tmpWorkspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "feima-outside-"));
  const link = path.join(ws, "link");
  try {
    fs.symlinkSync(outside, link, "dir");
  } catch {
    t.skip("当前环境不支持创建符号链接");
    return;
  }
  const policy = defaultPolicy({ workspace: ws, home: path.join(ws, "home") });
  assert.throws(() => resolveRead(policy, "link/secret.txt"), /越界/);
});

test("realpathLoose 对不存在的路径也能解析出真实祖先", () => {
  const ws = tmpWorkspace();
  const target = path.join(ws, "deep", "not", "exists.txt");
  const real = realpathLoose(target);
  assert.ok(real.endsWith("exists.txt"));
  assert.ok(isInside(realpathLoose(ws), real));
});

test("错误信息脱敏", () => {
  const raw = "请求失败 sk-abcdef1234567890 Authorization: Bearer ghp_abcdefghijklmnop1234";
  const out = redact(raw);
  assert.ok(!out.includes("sk-abcdef1234567890"));
  assert.ok(!out.includes("ghp_abcdefghijklmnop1234"));
  assert.ok(out.includes("sk-…"));
});
