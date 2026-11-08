/**
 * 配置装载。优先级：命令行 > 环境变量 > ~/.feima/config.json > 默认值。
 *
 * 安全约定：API Key 只保存在本进程内，永不写入日志、永不传给子进程。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IsolationChoice, SandboxMode } from "../safety/exec.ts";

export interface FeimaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  workspace: string;
  sandbox: SandboxMode;
  /** 进程级隔离后端：auto / appcontainer / bwrap / docker / none */
  isolation: IsolationChoice;
  /** 沙盒内是否允许出网 */
  network: boolean;
  /** docker 后端使用的镜像 */
  dockerImage: string;
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

type FileConfig = Partial<Record<keyof FeimaConfig, string | number | string[]>>;

function readFileConfig(): FileConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? (parsed as FileConfig) : {};
  } catch {
    return {};
  }
}

function pickStr(...values: Array<string | undefined>): string {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim();
  return "";
}

function pickNum(fallback: number, ...values: Array<string | number | undefined>): number {
  for (const v of values) {
    const n = typeof v === "number" ? v : v ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/** 允许多来源给列表：数组直接用，字符串按逗号切 */
function pickList(...values: Array<string | string[] | undefined>): string[] {
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
    sandbox: sandboxRaw === "strict" ? "strict" : "policy",
    isolation,
    network: networkRaw === "1" || networkRaw === "true" || networkRaw === "yes",
    dockerImage: pickStr(
      overrides.dockerImage,
      env.FEIMA_DOCKER_IMAGE,
      typeof file.dockerImage === "string" ? file.dockerImage : "",
      "node:22-alpine",
    ),
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
    workspace: cfg.workspace,
    sandbox: cfg.sandbox,
    isolation: cfg.isolation,
    network: cfg.network,
    dockerImage: cfg.dockerImage,
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
