/**
 * 一次运行的可量化画像。
 *
 * 端到端脚本原来只回答「这次成不成」，成不成就没了。但真正想知道的往往是
 * 「比上次好没有」——同样一个修 bug 的任务，上次 12 次工具调用、这次 5 次，
 * 那不是运气，是提示词或闸门改动生效了。要把这种判断变成数字，就得先把
 * 一次运行摊成可比的字段。
 *
 * 这里只做聚合，不碰 IO、不看时间、不读环境变量：给定一串事件，吐出同一组数。
 * 这样单测可以拿假事件喂它，端到端脚本拿真事件喂它，两边算的是同一套口径。
 */
import type { AgentEvent } from "../types.ts";

export interface RunMetrics {
  /** 用户轮次（turn_end）：一次 submit 算一轮，单任务跑法下通常是 1 */
  rounds: number;
  /** 模型往返次数（step）：一次请求 + 一次回复。效率看这个，不看轮次 */
  steps: number;
  /** 工具调用总数（tool_start） */
  toolCalls: number;
  toolOk: number;
  toolFail: number;
  /** 失败里属于「策略拦下」的：白名单、确认闸门、权限档、用户拒绝 */
  blocked: number;
  /** 失败但不是策略拦的：命令自己退出码非 0、参数错、文件不存在 */
  failedOther: number;
  /** 请求级重试次数（retry） */
  retries: number;
  /** 提示类事件：--yes 放行、空转提醒、中止告知 */
  notices: number;
  compactions: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 输出正文长度，粗略代表「说了多少话」 */
  textChars: number;
  /** 思考块分片数，粗略代表「想了多久」 */
  reasoningChunks: number;
  wallMs: number;
  /** 这一轮怎么结束的 */
  ended: "settled" | "error" | "aborted" | "unknown";
}

/**
 * 策略性失败的特征串。
 *
 * 不按错误码判：这些失败返回的都是普通错误，没有独立类型，只能认措辞。
 * 措辞由我们自己写在闸门里，所以这套匹配是「自家的词表」，不是猜第三方报错。
 */
const BLOCK_PATTERNS: RegExp[] = [
  /不在白名单/,
  /确认模式拦下/,
  /用户拒绝/,
  /按拒绝处理/,
  /权限档/,
  /没有可交互的确认入口/,
];

export function isBlockedFailure(preview: string): boolean {
  return BLOCK_PATTERNS.some((re) => re.test(preview));
}

export function emptyMetrics(wallMs = 0): RunMetrics {
  return {
    rounds: 0,
    steps: 0,
    toolCalls: 0,
    toolOk: 0,
    toolFail: 0,
    blocked: 0,
    failedOther: 0,
    retries: 0,
    notices: 0,
    compactions: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    textChars: 0,
    reasoningChunks: 0,
    wallMs,
    ended: "unknown",
  };
}

export function summarizeRun(events: AgentEvent[], wallMs: number): RunMetrics {
  const m = emptyMetrics(wallMs);
  for (const e of events) {
    switch (e.type) {
      case "turn_end":
        m.rounds += 1;
        break;
      case "step":
        m.steps += 1;
        break;
      case "tool_start":
        m.toolCalls += 1;
        break;
      case "tool_end":
        if (e.ok) {
          m.toolOk += 1;
        } else {
          m.toolFail += 1;
          if (isBlockedFailure(String(e.preview ?? ""))) m.blocked += 1;
          else m.failedOther += 1;
        }
        break;
      case "retry":
        m.retries += 1;
        break;
      case "notice":
        m.notices += 1;
        break;
      case "compact":
        m.compactions += 1;
        break;
      case "usage":
        // 每家 provider 的口径不完全一样：有的整轮只报一次，有的每个分片都报。
        // 累加是唯一能对齐的做法；真实账单以 provider 为准，这里只用来比趋势。
        m.promptTokens += Number(e.usage?.prompt_tokens ?? 0);
        m.completionTokens += Number(e.usage?.completion_tokens ?? 0);
        m.totalTokens += Number(e.usage?.total_tokens ?? 0);
        break;
      case "text_delta":
        m.textChars += String(e.text ?? "").length;
        break;
      case "reasoning_delta":
        m.reasoningChunks += 1;
        break;
      case "error":
        m.ended = "error";
        break;
      case "aborted":
        m.ended = "aborted";
        break;
      case "agent_settled":
        if (m.ended === "unknown") m.ended = "settled";
        break;
      default:
        break;
    }
  }
  return m;
}

/** 工具成功率；一次都没调用时返回 null，避免把「没跑」算成 0% */
export function successRate(m: RunMetrics): number | null {
  if (m.toolCalls === 0) return null;
  return m.toolOk / m.toolCalls;
}

export function formatRate(m: RunMetrics): string {
  const r = successRate(m);
  return r === null ? "—" : `${Math.round(r * 100)}%`;
}

export interface Delta {
  label: string;
  before: number | null;
  after: number | null;
  /** 变大是好事（false 表示越小越好，例如 token、耗时、被拦次数） */
  higherIsBetter: boolean;
}

/**
 * 两次运行的可比字段。
 *
 * 只挑「同一任务下变动即有意义」的项：轮次、工具次数、被拦、重试、token、耗时。
 * 不挑「总量」类字段（textChars、reasoningChunks）——它们随模型心情变，比了也没结论。
 */
export function compareRuns(before: RunMetrics, after: RunMetrics): Delta[] {
  return [
    { label: "往返", before: before.steps, after: after.steps, higherIsBetter: false },
    { label: "轮次", before: before.rounds, after: after.rounds, higherIsBetter: false },
    { label: "工具调用", before: before.toolCalls, after: after.toolCalls, higherIsBetter: false },
    { label: "失败", before: before.toolFail, after: after.toolFail, higherIsBetter: false },
    { label: "被拦", before: before.blocked, after: after.blocked, higherIsBetter: false },
    { label: "重试", before: before.retries, after: after.retries, higherIsBetter: false },
    { label: "token", before: before.totalTokens || null, after: after.totalTokens || null, higherIsBetter: false },
    { label: "耗时ms", before: before.wallMs || null, after: after.wallMs || null, higherIsBetter: false },
  ];
}

/** totals 里每一项都必须是数字，缺一个趋势表就少一列 */
const HISTORY_TOTALS_KEYS = [
  "steps",
  "rounds",
  "toolCalls",
  "toolOk",
  "toolFail",
  "blocked",
  "retries",
  "totalTokens",
] as const;

/**
 * 校验 e2e/history.jsonl 的一条记录，返回问题清单（空数组 = 合格）。
 *
 * 为什么值得单独一个函数：写入方是 scripts/e2e.mjs，读的一方是趋势表和人。
 * 字段名漂移的后果不是报错，而是趋势表安静地打一排空格子——「这版变便宜了」
 * 和「这版字段名改了」在屏幕上长得一模一样。三个地方（写、读、单测）都调它，
 * 口径只有一处。
 */
export function validateHistoryRecord(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["记录不是对象；期望 { at, version, rev, totals, scenarios }"];
  }
  const r = value as Record<string, unknown>;
  const problems: string[] = [];

  // 最常见的漂移：totals 写成 total、rev 写成 commit
  const aliases: Array<[string, string]> = [
    ["total", "totals"],
    ["commit", "rev"],
  ];
  for (const [wrong, right] of aliases) {
    if (wrong in r && !(right in r)) {
      problems.push(`字段名对不上：读到 ${wrong}，期望 ${right}（趋势表按 ${right} 取值，改名会让整列变空）`);
    }
  }

  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) {
    problems.push(`at 不是可解析的时间（读到 ${JSON.stringify(r.at)}）；期望 ISO 时间串`);
  }
  if (typeof r.version !== "string" || !r.version.trim()) {
    problems.push("version 缺失或为空；期望形如 0.7.0");
  }
  if (typeof r.rev !== "string") {
    problems.push("rev 缺失；期望提交号字符串，取不到时写空串，别省掉这个字段");
  }

  const t = r.totals;
  if (typeof t !== "object" || t === null || Array.isArray(t)) {
    problems.push("totals 缺失或不是对象；趋势表的步数、被拦、token 全从它取");
  } else {
    const tt = t as Record<string, unknown>;
    for (const k of HISTORY_TOTALS_KEYS) {
      if (typeof tt[k] !== "number" || Number.isNaN(tt[k])) {
        problems.push(`totals.${k} 应为数字，实际是 ${JSON.stringify(tt[k])}`);
      }
    }
  }

  if (!Array.isArray(r.scenarios)) {
    problems.push("scenarios 应为数组；跑失败时也要写，哪怕是空数组");
  }

  return problems;
}
