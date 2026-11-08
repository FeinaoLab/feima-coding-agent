/**
 * 上下文压缩。
 *
 * 目标不是「省 token」，而是让长会话还能继续跑：一段会话跑到几万 token 后，
 * 上游要么报超长、要么开始丢中间的细节，表现是「明明刚看过这个文件，它又问一遍」。
 *
 * 三条硬约束：
 * 1. 系统提示永不折叠——它定义了行为边界，摘要成一句话就丢掉了约束力。
 * 2. 切分点只能落在 user 消息上。assistant(tool_calls) 与紧随的 tool 结果是一对，
 *    切在中间会让上游直接报 400（tool_call_id 找不到对应请求）。
 * 3. 压缩必须真的变小才生效，否则叠加摘要反而更长。
 */

import type { ChatMessage, Provider } from "../types.ts";

/** 摘要消息的识别前缀，用于二次压缩时把旧摘要并进来而不是重复摘要 */
export const SUMMARY_MARK = "[上下文摘要";

const MESSAGE_OVERHEAD = 4;

/** 折叠区低于这个估算体积就不值得花一次摘要调用 */
const MIN_FOLD_TOKENS = 240;

/**
 * 粗略 token 估算：中日韩字符按 1.05、其余按 3.6 字符估。
 * 不追求精确——用于触发判断，误差 15% 以内就够；真正计费以 usage 为准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2e80) cjk++;
    else rest++;
  }
  return Math.ceil(cjk * 1.05 + rest / 3.6);
}

export function estimateMessage(m: ChatMessage): number {
  let n = MESSAGE_OVERHEAD + estimateTokens(m.content ?? "");
  if (m.tool_calls) {
    for (const c of m.tool_calls) {
      n += estimateTokens(c.name) + estimateTokens(c.arguments) + 6;
    }
  }
  if (m.name) n += estimateTokens(m.name);
  return n;
}

export function estimateMessages(msgs: ChatMessage[]): number {
  let n = 0;
  for (const m of msgs) n += estimateMessage(m);
  return n;
}

export interface CompactConfig {
  /** 估算 token 上限，超过即压缩 */
  budget: number;
  /** 保留最近多少个用户轮次（含其后所有消息） */
  keepRecentTurns: number;
  /**
   * 找不到足够用户轮次时（典型是「一轮任务里跑了 30 次工具」），
   * 按 token 保留尾部这么多内容。默认取预算的一半。
   */
  keepTokens?: number;
  /** 摘要生成器；抛错时自动降级为规则摘要 */
  summarize?: (folded: ChatMessage[], previous: string | null) => Promise<string>;
}

export interface CompactResult {
  messages: ChatMessage[];
  compacted: boolean;
  before: number;
  after: number;
  /** 被折叠的消息条数 */
  folded: number;
  reason?: string;
}

export const DEFAULT_COMPACT: CompactConfig = {
  // 32k 上下文留 8k 给输出，剩下按 0.9 折再留余量
  budget: 22000,
  keepRecentTurns: 3,
};

function short(text: string | null, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 模型不可用时的降级摘要：只保留骨架，不编造内容 */
export function fallbackSummary(folded: ChatMessage[]): string {
  const asks: string[] = [];
  const said: string[] = [];
  const tools: string[] = [];
  for (const m of folded) {
    if (m.role === "user" && m.content && !m.content.startsWith(SUMMARY_MARK)) {
      asks.push(short(m.content, 120));
    } else if (m.role === "assistant") {
      if (m.content) said.push(short(m.content, 100));
      for (const c of m.tool_calls ?? []) tools.push(c.name);
    }
  }
  const lines: string[] = ["（自动摘要，摘要模型不可用时的降级结果）"];
  // 只留最近 8 条诉求：折叠的意义是变短，把所有条目都列出来反而比原文更长
  if (asks.length) lines.push("用户先后提出：", ...asks.slice(-8).map((t) => `- ${t}`));
  if (tools.length) {
    const uniq = [...new Set(tools)];
    lines.push(`期间调用工具 ${tools.length} 次：${uniq.join("、")}`);
  }
  if (said.length) lines.push("已知结论：", ...said.slice(-3).map((t) => `- ${t}`));
  lines.push("细节（文件内容、命令输出）已折叠，需要时重新读取。");
  const text = lines.join("\n");
  return text.length > 700 ? text.slice(0, 700) + "…" : text;
}

/** 用 provider 生成摘要；失败由调用方降级 */
export function makeSummarizer(
  provider: Provider,
  model: string,
  maxChars = 900,
): (folded: ChatMessage[], previous: string | null) => Promise<string> {
  return async (folded, previous) => {
    const transcript = folded
      .map((m) => {
        const who = m.role === "assistant" ? "助手" : m.role === "tool" ? `工具(${m.name ?? "?"})` : "用户";
        const body = short(m.content, 600);
        const calls = m.tool_calls?.length ? ` [调用 ${m.tool_calls.map((c) => c.name).join(",")}]` : "";
        return `${who}${calls}: ${body}`;
      })
      .join("\n");

    const prompt = [
      "把下面这段编程助手对话折叠成一段可继续工作的摘要。",
      "必须保留：用户的目标与约束、已改动或已确认的文件路径、跑过的命令与结果、当前的阻塞点与下一步。",
      "不要保留：完整文件内容、完整命令输出、寒暄与重复解释。",
      "用中文，条目式，不超过 400 字。只输出摘要正文，不要开头结尾的说明。",
      previous ? `\n此前已有的摘要（请合并，不要丢失其中的关键路径与结论）：\n${previous}` : "",
      `\n待折叠的对话：\n${transcript}`,
    ].join("");

    let text = "";
    for await (const evt of provider.stream({
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model,
      temperature: 0,
      maxTokens: 800,
    })) {
      if (evt.text) text += evt.text;
    }
    text = text.trim();
    if (!text) throw new Error("摘要为空");
    return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
  };
}

/** 从尾部数第 n 个 user 消息的下标；不足返回 -1 */
function isSummaryMessage(m: ChatMessage): boolean {
  return m.role === "user" && typeof m.content === "string" && m.content.startsWith(SUMMARY_MARK);
}

/**
 * 安全的切分点：不能落在 tool 结果上。
 * 切在 tool 上意味着 assistant(tool_calls) 被折进去而结果还留着，
 * 上游会报 tool_call_id 找不到对应请求，整轮直接 400。
 */
function isSafeCut(messages: ChatMessage[], i: number): boolean {
  // 2 是允许的最小值：折叠区 = [1, 2) 正好是一条 user。
  // 体积门槛在 compactIfNeeded 里判，这里只管结构是否安全。
  if (i < 2 || i >= messages.length) return false;
  return messages[i].role !== "tool";
}

/**
 * 找切点，两种策略：
 * 1. 用户轮次（多轮对话的常态）：保留最近 keepRecentTurns 个完整轮次。
 * 2. token 保留（单轮长工具链）：一轮任务里跑了 30 次工具时只有一条 user，
 *    按轮次算永远找不到切点，上下文会一路涨到上游报超长。
 *    这时改成从尾部往前累积，保留 keepTokens 的内容，切点在安全边界上。
 */
function findCut(messages: ChatMessage[], cfg: CompactConfig, budget: number): number {
  const keep = Math.max(1, cfg.keepRecentTurns);
  let seen = 0;
  for (let i = messages.length - 1; i > 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || isSummaryMessage(m)) continue;
    seen++;
    if (seen === keep) {
      if (isSafeCut(messages, i)) return i;
      break;
    }
  }

  // 保留量不能超过预算的八成，否则「保留区本身就超预算」，每次请求前都要压一遍
  const reserve = Math.min(
    Math.max(200, cfg.keepTokens ?? Math.floor(budget * 0.5)),
    Math.max(200, Math.floor(budget * 0.8)),
  );
  let acc = 0;
  let start = -1;
  for (let i = messages.length - 1; i >= 2; i--) {
    acc += estimateMessage(messages[i]);
    if (acc >= reserve) {
      start = i;
      break;
    }
  }
  // 尾部全部加起来还不够 reserve（例如一条超长的任务描述 + 一组短工具结果）：
  // 那就只折掉那条任务描述，保留整组工具调用。切点仍然合法。
  if (start < 0) start = 2;

  // 起点若是 tool，右移到整组结束，宁可多留也不切断配对
  let cut = start;
  while (cut < messages.length && messages[cut]?.role === "tool") cut++;
  if (isSafeCut(messages, cut)) return cut;

  // 右移越过了尾部（整组都在保留区里）：退回这组开头
  cut = start;
  while (cut > 2 && messages[cut]?.role === "tool") cut--;
  if (isSafeCut(messages, cut)) return cut;
  return -1;
}

/**
 * 必要时压缩。返回新数组，不修改入参。
 */
export async function compactIfNeeded(
  messages: ChatMessage[],
  cfg: CompactConfig,
): Promise<CompactResult> {
  const before = estimateMessages(messages);
  const unchanged = (reason: string): CompactResult => ({
    messages,
    compacted: false,
    before,
    after: before,
    folded: 0,
    reason,
  });

  if (messages.length <= 2) return unchanged("消息太少");
  if (before <= cfg.budget) return unchanged("未超预算");

  const cut = findCut(messages, cfg, cfg.budget);
  if (cut < 0) return unchanged("找不到安全的切分点");

  const foldedAll = messages.slice(1, cut);
  const previousMsg = foldedAll.find((m) => isSummaryMessage(m));
  const previous = previousMsg?.content ?? null;
  const body = foldedAll.filter((m) => m !== previousMsg);

  if (!body.length) return unchanged("没有可折叠内容");
  // 门槛看体积而不是条数：一次请求里甩出七八个工具调用时，折叠区可能只有
  // 「一条 user + 一条 assistant(tool_calls) + 若干 tool」，条数很少但体积很大。
  // 反过来，为了省两百 token 花一次摘要调用不划算，所以给个体积下限。
  if (estimateMessages(body) < MIN_FOLD_TOKENS) return unchanged("可折叠内容过少");

  let summary: string;
  if (cfg.summarize) {
    try {
      summary = await cfg.summarize(foldedAll, previous);
    } catch {
      summary = fallbackSummary(body);
    }
  } else {
    summary = fallbackSummary(body);
  }

  const head = messages[0];
  if (!head || head.role !== "system") return unchanged("首条不是系统提示，拒绝压缩");

  const next: ChatMessage[] = [
    head,
    { role: "user", content: `${SUMMARY_MARK}] 以下是更早对话的折叠摘要，细节已省略：\n${summary}` },
    ...messages.slice(cut),
  ];
  const after = estimateMessages(next);
  if (after >= before) return unchanged("压缩后未变小");

  return { messages: next, compacted: true, before, after, folded: foldedAll.length };
}
