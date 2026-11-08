/**
 * 路径与策略守卫。
 *
 * 三条原则（来自 Pi 桌面端源码实证的经验）：
 * 1. 白名单优于黑名单——环境变量只放行固定 16 项。
 * 2. 判断必须基于真实路径，不能做字符串前缀比较，否则符号链接一绕就穿。
 * 3. 出错就拒绝，不静默降级。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class PolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyError";
    this.code = code;
  }
}

/** 只透传这些变量；API Key 一律不进子进程 */
export const ENV_ALLOWLIST =
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|USER|USERNAME|LOGNAME|LANG|LC_\w+|TERM|COLORTERM|TZ|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|TEMP|TMP|SHELL)$/i;

export function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ENV_ALLOWLIST.test(k)) out[k] = v;
  }
  // 强制无颜色、无交互，避免子进程输出 ANSI 序列污染上下文
  out.TERM = "dumb";
  out.NO_COLOR = "1";
  out.CI = "1";
  return out;
}

export interface PolicyOptions {
  workspace: string;
  home?: string;
  installRoot?: string;
}

export interface Policy {
  workspace: string;
  denyRead: string[];
  denyWrite: string[];
  allowWrite: string[];
}

export function defaultPolicy(opts: PolicyOptions): Policy {
  const home = opts.home ?? os.homedir();
  const ws = path.resolve(opts.workspace);
  const denyRead = [
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".gnupg"),
    path.join(home, ".npmrc"),
    path.join(home, ".git-credentials"),
    path.join(home, ".feima"),
    path.join(ws, ".env"),
  ];
  const denyWrite = [
    // 防持久化：git 进程在沙盒外执行 hook，写进去就能绕过所有隔离
    path.join(ws, ".git", "hooks"),
    path.join(ws, ".git", "config"),
    path.join(ws, "node_modules"),
    // 防横向移动：别的 Agent 工具的规则目录，不许改
    path.join(ws, ".agents"),
    path.join(ws, ".codex"),
    path.join(ws, ".feima"),
  ];
  return { workspace: ws, denyRead, denyWrite, allowWrite: [ws] };
}

/**
 * 解析“可能存在也可能不存在”的真实路径：
 * 逐级向上找到第一个存在的祖先做 realpath，再拼回剩余部分。
 * 这样 `workspace/link/new.txt`（link 指向 /etc）也会被解析成 /etc/new.txt。
 */
export function realpathLoose(target: string): string {
  let cur = path.resolve(target);
  const tail: string[] = [];
  for (let i = 0; i < 40; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail.reverse());
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(target);
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function hitDeny(target: string, list: string[]): string | null {
  for (const item of list) {
    if (isInside(realpathLoose(item), target) || isInside(path.resolve(item), target)) return item;
  }
  return null;
}

/** 读取前的校验：必须落在工作区内、且不在 denyRead 里 */
export function resolveRead(policy: Policy, input: string): string {
  const abs = realpathLoose(path.resolve(policy.workspace, input));
  if (!isInside(realpathLoose(policy.workspace), abs)) {
    throw new PolicyError("ESCAPE", `路径越界：${input} 不在工作区内`);
  }
  const deny = hitDeny(abs, policy.denyRead);
  if (deny) throw new PolicyError("DENY_READ", `路径被策略禁止读取：${input}`);
  return abs;
}

/** 写入前的校验：必须落在 allowWrite 内、且不命中 denyWrite */
export function resolveWrite(policy: Policy, input: string): string {
  const abs = realpathLoose(path.resolve(policy.workspace, input));
  const root = realpathLoose(policy.workspace);
  if (!isInside(root, abs)) {
    throw new PolicyError("ESCAPE", `路径越界：${input} 不在工作区内`);
  }
  const deny = hitDeny(abs, policy.denyWrite);
  if (deny) {
    // .git/hooks 单独给一条更好懂的话：这是防沙盒逃逸，不是普通越权
    const hint = deny.includes(path.join(".git", "hooks"))
      ? "（.git/hooks 会由沙盒外的 git 进程执行，写进去等于绕过隔离）"
      : "";
    throw new PolicyError("DENY_WRITE", `路径被策略禁止写入：${input}${hint}`);
  }
  return abs;
}

/** 启动时的自检：工作区必须真实存在，且不能是符号链接指向别处 */
export function assertWorkspace(workspace: string): string {
  const abs = path.resolve(workspace);
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    throw new PolicyError("NO_WORKSPACE", `工作区不存在：${abs}`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new PolicyError("NO_WORKSPACE", `工作区不是目录：${abs}`);
  }
  return real;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-…"],
  [/ghp_[A-Za-z0-9]{16,}/g, "ghp_…"],
  [/github_pat_[A-Za-z0-9_]{16,}/g, "github_pat_…"],
  [/AKIA[0-9A-Z]{12,}/g, "AKIA…"],
  [/(Bearer\s+)\S+/gi, "$1…"],
  [/((?:api[_-]?key|token|secret|password)"?\s*[:=]\s*")[^"]{6,}"/gi, '$1…"'],
];

/** 错误信息要展示、要写日志、要上报，每条都是泄漏路径，统一出口脱敏 */
export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}
