/**
 * 模型解析。
 *
 * 别名不是「为了少打字」——它解决的是两个实际问题：
 * 1. 同一个模型在不同网关上的名字不一样（`claude-sonnet-4` / `anthropic/claude-sonnet-4`），
 *    别名让配置文件记住网关的写法，命令行只写自己的习惯。
 * 2. 别名可以带自己的 baseUrl 与 key。摘要、分类这类辅助调用该走便宜线路，
 *    而不是拿主线路的额度去折叠上下文。
 *
 * 一条约定：别名没写 baseUrl/apiKey 时回落到主配置，而不是报错。
 * 大多数别名只是同一个网关下的不同模型名，强制写全等于把配置写两遍。
 */

export interface ModelAlias {
  model: string;
  baseUrl?: string;
  apiKey?: string;
  /** 展示用名字，例如「便宜线路」；不写就用别名本身 */
  label?: string;
}

export interface ModelSource {
  model: string;
  baseUrl: string;
  apiKey: string;
  models?: Record<string, ModelAlias>;
}

export interface ResolvedModel {
  /** 命令行/配置里写的那个名字，用于显示 */
  name: string;
  /** 真正发给上游的模型标识 */
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 命中的别名；null 表示直接当模型名用 */
  alias: string | null;
  label: string;
}

export function resolveModel(src: ModelSource, name?: string): ResolvedModel {
  const wanted = (name ?? src.model ?? "").trim();
  const aliases = src.models ?? {};
  const hit = wanted && Object.prototype.hasOwnProperty.call(aliases, wanted) ? aliases[wanted] : null;

  if (hit && typeof hit.model === "string" && hit.model.trim()) {
    return {
      name: wanted,
      model: hit.model.trim(),
      baseUrl: (hit.baseUrl ?? "").trim() || src.baseUrl,
      apiKey: (hit.apiKey ?? "").trim() || src.apiKey,
      alias: wanted,
      label: hit.label ?? wanted,
    };
  }

  return {
    name: wanted || src.model,
    model: wanted || src.model,
    baseUrl: src.baseUrl,
    apiKey: src.apiKey,
    alias: null,
    label: wanted || src.model,
  };
}

/** 配置里的 models 字段是任意的，读进来要逐项校验；坏项报出来而不是悄悄丢掉 */
export function parseModelAliases(raw: unknown): { models: Record<string, ModelAlias>; problems: string[] } {
  const models: Record<string, ModelAlias> = {};
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) problems.push("models 必须是对象：{ \"别名\": { \"model\": \"...\" } }");
    return { models, problems };
  }

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`models.${name} 必须是对象`);
      continue;
    }
    const item = value as Record<string, unknown>;
    const model = typeof item.model === "string" ? item.model.trim() : "";
    if (!model) {
      problems.push(`models.${name} 缺少 model 字段，已忽略`);
      continue;
    }
    models[name] = {
      model,
      ...(typeof item.baseUrl === "string" && item.baseUrl.trim() ? { baseUrl: item.baseUrl.trim() } : {}),
      ...(typeof item.apiKey === "string" && item.apiKey.trim() ? { apiKey: item.apiKey.trim() } : {}),
      ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
    };
  }
  return { models, problems };
}
