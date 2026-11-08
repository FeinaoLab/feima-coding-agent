/**
 * 配置装载。优先级：命令行 > 环境变量 > ~/.feima/config.json > 默认值。
 *
 * 安全约定：API Key 只保存在本进程内，永不写入日志、永不传给子进程。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxMode } from "../safety/exec.ts";

export interface FeimaConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  workspace: string;
  sandbox: SandboxMode;
  maxTurns: number;
  maxTokens: number;
  temperature: number;
  systemExtra: string;
}

export const CONFIG_DIR = path.join(os.homedir(), ".feima");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

type FileConfig = Partial<Record<keyof FeimaConfig, string | number>>;

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

export function loadConfig(overrides: Partial<FeimaConfig> = {}): FeimaConfig {
  const file = readFileConfig();
  const env = process.env;

  const sandboxRaw = pickStr(
    String(overrides.sandbox ?? ""),
    env.FEIMA_SANDBOX,
    typeof file.sandbox === "string" ? file.sandbox : "",
  );

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
    maxTurns: pickNum(40, overrides.maxTurns, env.FEIMA_MAX_TURNS, file.maxTurns),
    maxTokens: pickNum(4096, overrides.maxTokens, env.FEIMA_MAX_TOKENS, file.maxTokens),
    temperature: pickNum(0.2, overrides.temperature, env.FEIMA_TEMPERATURE, file.temperature),
    systemExtra: pickStr(overrides.systemExtra, env.FEIMA_SYSTEM_EXTRA, typeof file.systemExtra === "string" ? file.systemExtra : ""),
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
    maxTurns: cfg.maxTurns,
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(sample, null, 2), { mode: 0o600 });
  return CONFIG_FILE;
}
