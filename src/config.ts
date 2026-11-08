/**
 * 配置装载。优先级：命令行 > 环境变量 > ~/.feima/config.json > 默认值。
 *
 * 安全约定：API Key 只保存在本进程内，永不写入日志、永不传给子进程。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IsolationChoice, SandboxMode } from "./safety/exec.ts";
import type { ConfirmMode } from "./safety/confirm.ts";
import { parseConfirmMode } from "./safety/confirm.ts";
import { parseModelAliases, type ModelAlias } from "./core/models.ts";
import type { Perms } from "./types.ts";

export interface FeimaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 模型别名：`--model 便宜` 能解析成具体模型与线路 */
  models: Record<string, ModelAlias>;
  /** 上下文压缩用哪个模型（别名或模型名）；空表示沿用主模型 */
  compactModel: string;
  workspace: string;
  sandbox: SandboxMode;
  /** 进程级隔离后端：auto / appcontainer / bwrap / docker / none */
  isolation: IsolationChoice;
  /** 沙盒内是否允许出网 */
  network: boolean;
  /** docker 后端使用的镜像 */
  dockerImage: string;
  /** 哪些副作用需要人工确认：off / write / exec / external / all */
  confirm: ConfirmMode;
  /** 无人工确认时是否放行（等价 --yes）；默认 false */
  assumeYes: boolean;
  /** 权限档：read / write / exec */
  perms: Perms;
  /** 命令白名单原始规则；空表示不启用 */
  cmdAllow: string[];
  /** 请求重试次数（总尝试次数，含首次）；1 表示不重试 */
  retries: number;
  /** 空转检测：模型反复撞同一个坑时先提醒再中止；默认开 */
  repeatGuard: boolean;
  maxTurns: number;
  maxTokens: number;
  temperature: number;
  systemExtra: string;
  /** 上下文估算 token 上限，超过即折叠中段历史 */
  contextBudget: number;
  /** 压缩时保留最近多少个用户轮次 */
  keepRecentTurns: number;
  /** 单轮长工具链找不到轮次切点时，按 token 保留尾部内容；0 表示取预算的一半 */
  keepTokens: number;
  /** 是否把会话写入 ~/.feima/sessions */
  saveSession: boolean;
  /** 飞链 RAG 知识库地址（例如 http://42.193.158.63），空表示不启用检索工具 */
  knowledgeUrl: string;
  /** 知识库 token；不给则用账号密码换 */
  knowledgeToken: string;
  knowledgeUser: string;
  knowledgePassword: string;
  /** 检索默认条数 */
  knowledgeTopK: number;
  /** 是否启用 MCP 外部工具；默认关闭——外部工具不在飞码的沙盒里 */
  mcp: boolean;
  /** MCP 配置文件路径，默认 ~/.feima/mcp.json */
  mcpConfigFile: string;
  /** 非交互模式下放行的 MCP 工具（交互模式走逐次确认，不需要这个） */
  mcpAllow: string[];
}

export const CONFIG_DIR = path.join(os.homedir(), ".feima");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const MCP_FILE = path.join(CONFIG_DIR, "mcp.json");

/**
 * 配置文件的内容未经校验：用户手写 JSON，什么类型都可能出现。
 * 这里统一用 unknown，交给 pick* 逐个判断——写窄了只会在调用处堆 as，
 * 写宽了至少有一处集中兜底。
 */
type FileConfig = Partial<Record<keyof FeimaConfig, unknown>>;

function readFileConfig(): FileConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? (parsed as FileConfig) : {};
  } catch {
    return {};
  }
}

function pickStr(...values: unknown[]): string {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

function pickNum(fallback: number, ...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

/** 允许多来源给列表：数组直接用，字符串按逗号切 */
function pickList(...values: unknown[]): string[] {
  for (const v of values) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === "string" && v.trim()) {
      return v
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    }
  }
  return [];
}

export function loadConfig(overrides: Partial<FeimaConfig> = {}): FeimaConfig {
  const file = readFileConfig();
  const env = process.env;

  const sandboxRaw = pickStr(
    String(overrides.sandbox ?? ""),
    env.FEIMA_SANDBOX,
    typeof file.sandbox === "string" ? file.sandbox : "",
  );
  const isolationRaw = pickStr(
    String(overrides.isolation ?? ""),
    env.FEIMA_ISOLATION,
    typeof file.isolation === "string" ? file.isolation : "",
    "auto",
  ).toLowerCase();
  const isolation: IsolationChoice =
    isolationRaw === "appcontainer" || isolationRaw === "bwrap" || isolationRaw === "docker" || isolationRaw === "none"
      ? isolationRaw
      : "auto";
  // 网络默认关：Agent 大多数任务不需要出网，关掉能顺手把"数据外带"这条路一起堵上
  const networkRaw = pickStr(String(overrides.network ?? ""), env.FEIMA_NETWORK, String(file.network ?? "")).toLowerCase();

  const aliasParsed = parseModelAliases(overrides.models ?? file.models);
  // 别名的坏项不阻止启动：它是可选的便利功能，写错了只该少一个别名，不该开不了工
  for (const problem of aliasParsed.problems) console.error(`[警告] ${problem}`);

  const confirmRaw = pickStr(String(overrides.confirm ?? ""), env.FEIMA_CONFIRM, String(file.confirm ?? ""), "off");
  const confirmMode = parseConfirmMode(confirmRaw);
  if (!confirmMode) {
    // 非法值直接报错：静默回落到 off 等于把用户要的确认悄悄关掉
    throw new Error(`确认模式 ${confirmRaw} 非法，可选 off / write / exec / external / all`);
  }

  const permsRaw = pickStr(String(overrides.perms ?? ""), env.FEIMA_PERMS, String(file.perms ?? ""), "exec").toLowerCase();
  const perms: Perms = permsRaw === "read" || permsRaw === "write" ? permsRaw : "exec";

  return {
    baseUrl: pickStr(
      overrides.baseUrl,
      env.FEIMA_BASE_URL,
      env.OPENAI_BASE_URL,
      typeof file.baseUrl === "string" ? file.baseUrl : "",
      "https://api.openai.com/v1",
    ),
    apiKey: pickStr(
      overrides.apiKey,
      env.FEIMA_API_KEY,
      env.OPENAI_API_KEY,
      typeof file.apiKey === "string" ? file.apiKey : "",
    ),
    model: pickStr(
      overrides.model,
      env.FEIMA_MODEL,
      typeof file.model === "string" ? file.model : "",
      "gpt-4o-mini",
    ),
    workspace: path.resolve(
      pickStr(
        overrides.workspace,
        env.FEIMA_WORKSPACE,
        typeof file.workspace === "string" ? file.workspace : "",
        process.cwd(),
      ),
    ),
    models: aliasParsed.models,
    compactModel: pickStr(
      overrides.compactModel,
      env.FEIMA_COMPACT_MODEL,
      typeof file.compactModel === "string" ? file.compactModel : "",
    ),
    sandbox: sandboxRaw === "strict" ? "strict" : "policy",
    isolation,
    network: networkRaw === "1" || networkRaw === "true" || networkRaw === "yes",
    dockerImage: pickStr(
      overrides.dockerImage,
      env.FEIMA_DOCKER_IMAGE,
      typeof file.dockerImage === "string" ? file.dockerImage : "",
      "node:22-alpine",
    ),
    confirm: confirmMode,
    assumeYes: env.FEIMA_YES ? env.FEIMA_YES === "1" || env.FEIMA_YES === "true" : (overrides.assumeYes ?? file.assumeYes ?? false) === true,
    perms,
    cmdAllow: pickList(overrides.cmdAllow, env.FEIMA_CMD_ALLOW, file.cmdAllow),
    // 总尝试次数含首次：默认 3 次尝试 = 最多重试 2 次
    retries: Math.min(6, Math.max(1, pickNum(3, overrides.retries, env.FEIMA_RETRIES, file.retries))),
    // 默认开：空转是默认发生的，而「关掉」是明确意图，所以只有显式写 0/false 才关
    repeatGuard: env.FEIMA_REPEAT
      ? env.FEIMA_REPEAT !== "0" && env.FEIMA_REPEAT !== "false"
      : (overrides.repeatGuard ?? file.repeatGuard ?? true) !== false,
    maxTurns: pickNum(40, overrides.maxTurns, env.FEIMA_MAX_TURNS, file.maxTurns),
    maxTokens: pickNum(4096, overrides.maxTokens, env.FEIMA_MAX_TOKENS, file.maxTokens),
    temperature: pickNum(0.2, overrides.temperature, env.FEIMA_TEMPERATURE, file.temperature),
    systemExtra: pickStr(overrides.systemExtra, env.FEIMA_SYSTEM_EXTRA, typeof file.systemExtra === "string" ? file.systemExtra : ""),
    contextBudget: pickNum(22000, overrides.contextBudget, env.FEIMA_CONTEXT_BUDGET, file.contextBudget),
    keepRecentTurns: Math.max(1, pickNum(3, overrides.keepRecentTurns, env.FEIMA_KEEP_TURNS, file.keepRecentTurns)),
    keepTokens: Math.max(0, pickNum(0, overrides.keepTokens, env.FEIMA_KEEP_TOKENS, file.keepTokens)),
    saveSession: env.FEIMA_NO_SAVE ? false : (overrides.saveSession ?? file.saveSession ?? true) !== false,
    knowledgeUrl: pickStr(
      overrides.knowledgeUrl,
      env.FEIMA_KB_URL,
      typeof file.knowledgeUrl === "string" ? file.knowledgeUrl : "",
    ),
    knowledgeToken: pickStr(
      overrides.knowledgeToken,
      env.FEIMA_KB_TOKEN,
      typeof file.knowledgeToken === "string" ? file.knowledgeToken : "",
    ),
    knowledgeUser: pickStr(
      overrides.knowledgeUser,
      env.FEIMA_KB_USER,
      typeof file.knowledgeUser === "string" ? file.knowledgeUser : "",
    ),
    knowledgePassword: pickStr(
      overrides.knowledgePassword,
      env.FEIMA_KB_PASSWORD,
      typeof file.knowledgePassword === "string" ? file.knowledgePassword : "",
    ),
    knowledgeTopK: Math.min(8, Math.max(1, pickNum(5, overrides.knowledgeTopK, env.FEIMA_KB_TOPK, file.knowledgeTopK as number))),
    // 默认关：外部工具能干什么，飞码管不了，所以必须用户显式打开
    mcp: env.FEIMA_MCP ? env.FEIMA_MCP === "1" || env.FEIMA_MCP === "true" : (overrides.mcp ?? file.mcp ?? false) === true,
    mcpConfigFile: pickStr(
      overrides.mcpConfigFile,
      env.FEIMA_MCP_CONFIG,
      typeof file.mcpConfigFile === "string" ? file.mcpConfigFile : "",
      MCP_FILE,
    ),
    mcpAllow: pickList(overrides.mcpAllow, env.FEIMA_MCP_ALLOW, file.mcpAllow as string[]),
  };
}

/** 写一份示例配置，方便第一次使用 */
export function writeExampleConfig(cfg: FeimaConfig): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE;
  const sample = {
    baseUrl: cfg.baseUrl,
    apiKey: "sk-在这里填你的 key",
    model: cfg.model,
    models: {
      便宜: { model: cfg.model, label: "压缩与摘要用" },
    },
    compactModel: "",
    workspace: cfg.workspace,
    sandbox: cfg.sandbox,
    isolation: cfg.isolation,
    network: cfg.network,
    dockerImage: cfg.dockerImage,
    confirm: cfg.confirm,
    assumeYes: cfg.assumeYes,
    perms: cfg.perms,
    cmdAllow: cfg.cmdAllow,
    retries: cfg.retries,
    repeatGuard: cfg.repeatGuard,
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    contextBudget: cfg.contextBudget,
    keepRecentTurns: cfg.keepRecentTurns,
    keepTokens: cfg.keepTokens,
    saveSession: cfg.saveSession,
    knowledgeUrl: cfg.knowledgeUrl,
    knowledgeToken: "（填 token，或改用 knowledgeUser / knowledgePassword）",
    knowledgeUser: cfg.knowledgeUser,
    knowledgePassword: "（与 knowledgeUser 配套）",
    knowledgeTopK: cfg.knowledgeTopK,
    mcp: cfg.mcp,
    mcpConfigFile: cfg.mcpConfigFile,
    mcpAllow: cfg.mcpAllow,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(sample, null, 2), { mode: 0o600 });
  return CONFIG_FILE;
}
