import test from "node:test";
import assert from "node:assert/strict";
import { parseModelAliases, resolveModel } from "../src/core/models.ts";

const base = {
  model: "gpt-4o-mini",
  baseUrl: "https://api.main/v1",
  apiKey: "sk-main",
  models: {
    便宜: { model: "qwen-turbo", label: "低成本线路" },
    远程: { model: "claude-sonnet-4", baseUrl: "https://api.other/v1", apiKey: "sk-other" },
    半截: { model: "", baseUrl: "https://ignored" },
  },
};

test("别名命中：换成具体模型，线路与 key 回落到主配置", () => {
  const got = resolveModel(base, "便宜");
  assert.equal(got.model, "qwen-turbo");
  assert.equal(got.baseUrl, "https://api.main/v1");
  assert.equal(got.apiKey, "sk-main");
  assert.equal(got.alias, "便宜");
  assert.equal(got.label, "低成本线路");
});

test("别名自带线路与 key 时优先用别名的", () => {
  const got = resolveModel(base, "远程");
  assert.equal(got.baseUrl, "https://api.other/v1");
  assert.equal(got.apiKey, "sk-other");
  assert.equal(got.alias, "远程");
});

test("不是别名就当裸模型名用，不报错", () => {
  const got = resolveModel(base, "gpt-4o");
  assert.equal(got.model, "gpt-4o");
  assert.equal(got.alias, null);
  assert.equal(got.baseUrl, "https://api.main/v1");
});

test("不传名字时用配置里的 model", () => {
  assert.equal(resolveModel(base).model, "gpt-4o-mini");
});

test("别名里 model 为空视为没命中，回落到裸模型名", () => {
  // 坏别名不能变成「model 是空字符串」发给上游，那样只会拿到一个看不懂的 400
  const got = resolveModel(base, "半截");
  assert.equal(got.model, "半截");
  assert.equal(got.alias, null);
});

test("别名解析：缺 model 的项被跳过并报出原因", () => {
  const { models, problems } = parseModelAliases({
    ok: { model: "m1" },
    bad: { baseUrl: "https://x" },
    worse: "不是对象",
  });
  assert.deepEqual(Object.keys(models), ["ok"]);
  assert.equal(problems.length, 2);
  assert.match(problems.join("\n"), /bad 缺少 model/);
});

test("models 不是对象时给一条明确的问题，而不是抛异常", () => {
  assert.equal(parseModelAliases(["a"]).problems.length, 1);
  assert.equal(parseModelAliases(undefined).problems.length, 0);
});
