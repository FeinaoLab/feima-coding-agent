/**
 * 飞链 RAG 检索工具。
 *
 * 接的是知识库的 `/api/ai/search`（chunk 检索，不经过大模型，秒级返回）。
 * 三条约束写在代码里，别改成"更顺手"的样子：
 *
 * 1. 未配置就不注册工具。注册一个永远报错的工具，模型会反复试，
 *    几轮就把上下文烧完了；缺失状态由 doctor 报给用户。
 * 2. 输出必须截断。检索结果是外部文本，长度不可控，原样塞进上下文
 *    会挤掉工作区里的真实代码。
 * 3. 凭据只在本进程内存里。token 不落盘、不进日志、不传给子进程。
 */

import type { Tool, ToolContext, ToolResult } from "../types.ts";
import { PolicyError, redact } from "../safety/policy.ts";

/** 知识库片段：字段名对齐 /api/ai/search 的实际返回 */
export interface KnowledgeHit {
  snippet: string;
  score: number;
  documentId: number;
  title: string;
  chunkIndex: number;
  chunkId: number;
}

export interface KnowledgeOptions {
  /** 知识库地址，例如 http://42.193.158.63；空则不启用 */
  url: string;
  /** 直接给 token（长期可用） */
  token?: string;
  /** 或者给账号，由工具自己换 token（内存缓存） */
  username?: string;
  password?: string;
  /** 检索路径，默认 /api/ai/search */
  endpoint?: string;
  /** 默认取 5 条 */
  topK?: number;
  timeoutMs?: number;
  /** 便于用例注入；生产用全局 fetch */
  fetchImpl?: typeof fetch;
}

const DEFAULT_ENDPOINT = "/api/ai/search";
const DEFAULT_TOPK = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
/** 单条片段上限：400 字够模型判断相关性，又不至于一条吃掉半个上下文 */
const SNIPPET_LIMIT = 400;

export function knowledgeConfigured(opts: KnowledgeOptions | null | undefined): boolean {
  return Boolean(opts && opts.url && opts.url.trim());
}

/** 去掉检索结果里的高亮标签，避免把 <em> 当成 Markdown 灌进上下文 */
function plain(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][^>]{0,40}>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string, limit = SNIPPET_LIMIT): string {
  const t = plain(text);
  return t.length > limit ? t.slice(0, limit) + "…" : t;
}

/** 把接口返回统一成 KnowledgeHit[]：兼容 data 为数组 / 数组直接在顶层两种情况 */
export function parseHits(payload: unknown): KnowledgeHit[] {
  const root = payload as { data?: unknown } | unknown[] | null;
  const list = Array.isArray(root) ? root : Array.isArray((root as { data?: unknown })?.data) ? (root as { data: unknown[] }).data : null;
  if (!list) {
    const msg = (payload as { message?: string })?.message;
    throw new PolicyError("KB_BAD_RESPONSE", `知识库返回结构不认识${msg ? `：${msg}` : ""}`);
  }
  return list
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      snippet: String(item.snippet ?? ""),
      score: Number(item.score ?? 0),
      documentId: Number(item.documentId ?? 0),
      title: String(item.title ?? "（无标题）"),
      chunkIndex: Number(item.chunkIndex ?? 0),
      chunkId: Number(item.chunkId ?? 0),
    }))
    .filter((hit) => hit.snippet.trim().length > 0);
}

export function formatHits(hits: KnowledgeHit[], keyword: string): string {
  if (!hits.length) {
    return [
      `知识库没有检索到「${keyword}」相关的内容。`,
      "可以换一种说法再搜一次；如果确认知识库里没有，就直接在工作区里用 grep 找。",
    ].join("\n");
  }
  const lines = [
    `知识库检索到 ${hits.length} 条（关键词：${keyword}）`,
    "这些是知识库片段，不是工作区文件：引用前先确认内容与当前代码是否一致。",
    "",
  ];
  hits.forEach((hit, i) => {
    lines.push(`[${i + 1}] ${hit.title} · doc ${hit.documentId} · score ${hit.score.toFixed(1)}`);
    lines.push("    " + clip(hit.snippet).replace(/\n/g, "\n    "));
    lines.push("");
  });
  lines.push("引用时写成 [1] 这种编号，并在句末注明文档标题。");
  return lines.join("\n").trimEnd();
}

export function createKnowledgeTool(opts: KnowledgeOptions): Tool {
  const base = opts.url.replace(/\/+$/, "");
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const topK = Math.min(8, Math.max(1, opts.topK ?? DEFAULT_TOPK));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  let cachedToken: string | null = opts.token?.trim() || null;

  async function login(): Promise<string> {
    if (cachedToken) return cachedToken;
    if (!opts.username || !opts.password) {
      throw new PolicyError("KB_NO_AUTH", "知识库未配置 token，也没有账号密码，无法检索");
    }
    const res = await doFetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: opts.username, password: opts.password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: { data?: { token?: string }; message?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PolicyError("KB_BAD_RESPONSE", `知识库登录返回非 JSON（HTTP ${res.status}）`);
    }
    const token = json?.data?.token;
    if (!res.ok || !token) {
      throw new PolicyError("KB_NO_AUTH", `知识库登录失败（HTTP ${res.status}）${json?.message ? "：" + json.message : ""}`);
    }
    cachedToken = token;
    return token;
  }

  return {
    name: "search_knowledge",
    description:
      "在项目知识库（飞链 RAG）里检索资料，返回带编号的片段。适合查设计决策、历史结论、领域知识；" +
      "查代码本身用 grep，不要用这个工具。结果带编号，引用时标注。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词，尽量具体，例如「隔离后端 AppContainer」" },
        limit: { type: "number", description: `返回条数，默认 ${topK}，最多 8` },
      },
      required: ["query"],
    },
    async run(args, ctx: ToolContext): Promise<ToolResult> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { ok: false, content: "参数 query 必须是非空字符串" };
      const limit = Math.min(8, Math.max(1, typeof args.limit === "number" ? args.limit : topK));

      let token: string;
      try {
        token = await login();
      } catch (err) {
        return { ok: false, content: redact(err instanceof Error ? err.message : String(err)) };
      }

      let res: Response;
      try {
        res = await doFetch(base + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ keyword: query, limit }),
          // 检索要快：慢过 15 秒就不该等，宁可让模型换个词。
          // 这里用 any 而不是二选一：用户取消（ctx.signal）和超时都得生效，
          // 写成 `ctx.signal ?? timeout` 的话，一旦有 ctx.signal 就再也不会超时。
          signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, content: redact(`知识库检索请求失败：${msg}`) };
      }

      const text = await res.text();
      if (!res.ok) {
        return { ok: false, content: redact(`知识库检索失败（HTTP ${res.status}）：${text.slice(0, 200)}`) };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return { ok: false, content: "知识库返回的不是 JSON，可能被网关拦截了" };
      }
      const code = (payload as { code?: number }).code;
      if (typeof code === "number" && code !== 200) {
        const msg = (payload as { message?: string }).message ?? "";
        return { ok: false, content: `知识库返回错误 code=${code}${msg ? "：" + msg : ""}` };
      }

      let hits: KnowledgeHit[];
      try {
        hits = parseHits(payload);
      } catch (err) {
        return { ok: false, content: redact(err instanceof Error ? err.message : String(err)) };
      }
      return { ok: true, content: formatHits(hits.slice(0, limit), query) };
    },
  };
}
