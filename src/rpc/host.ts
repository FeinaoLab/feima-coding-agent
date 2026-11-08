/**
 * RPC 宿主办。
 *
 * 协议：stdin 每行一条 JSON 命令，stdout 每行一条 JSON 响应或事件。
 * 只按 \n 切分，绝不用 readline 解析这条流——行内可能夹带超长 JSON，
 * readline 的缓冲语义会让参数错位（Pi 的 rpc-host 里写着同一句警告）。
 *
 * 命令：
 *   {"id":"1","method":"prompt","params":{"text":"..."}}
 *   {"id":"2","method":"steer","params":{"text":"..."}}
 *   {"id":"3","method":"queue","params":{"text":"..."}}
 *   {"id":"4","method":"abort"}
 *   {"id":"5","method":"get_state"}
 *   {"id":"6","method":"reset"}
 *   {"id":"7","method":"shutdown"}
 */

import fs from "node:fs";
import process from "node:process";
import { loadConfig, type FeimaConfig } from "../config.ts";
import { buildSystemPrompt, loadProjectMemory } from "../prompt.ts";
import { AgentLoop } from "../core/loop.ts";
import { createOpenAIProvider } from "../providers/openai.ts";
import { builtinTools, filterByPerms } from "../tools/builtin.ts";
import { resolveModel } from "../core/models.ts";
import { makeSummarizer } from "../core/compact.ts";
import { NO_RETRY, DEFAULT_RETRY } from "../core/retry.ts";
import { parseAllowlist } from "../safety/allowlist.ts";
import { createKnowledgeTool, knowledgeConfigured } from "../tools/knowledge.ts";
import { parseMcpConfig } from "../mcp/client.ts";
import { loadMcpTools } from "../mcp/tools.ts";
import { assertWorkspace, defaultPolicy, redact } from "../safety/policy.ts";
import { createSandbox, handshake } from "../safety/exec.ts";

interface RpcRequest {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
}

function writeLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export async function startRpcHost(opts: Partial<FeimaConfig> = {}): Promise<number> {
  const config = loadConfig(opts);
  const workspace = assertWorkspace(config.workspace);
  const policy = defaultPolicy({ workspace });
  const allow = parseAllowlist(config.cmdAllow);
  const sandbox = createSandbox({
    mode: config.sandbox,
    policy,
    isolation: config.isolation,
    network: config.network,
    dockerImage: config.dockerImage,
    commandAllowlist: allow.rules,
  });

  try {
    await sandbox.init();
    // 验证不通过就退出：桌面端不能带着"以为隔离了"的状态接受命令
    await handshake(sandbox);
  } catch (err) {
    // 握手失败必须上报并退出，不能带着“假绿”继续接受命令
    writeLine({ type: "fatal", message: redact(err instanceof Error ? err.message : String(err)) });
    return 1;
  }

  const tools = filterByPerms(builtinTools({ policy }), config.perms);
  if (knowledgeConfigured({ url: config.knowledgeUrl })) {
    tools.push(
      createKnowledgeTool({
        url: config.knowledgeUrl,
        token: config.knowledgeToken,
        username: config.knowledgeUser,
        password: config.knowledgePassword,
        topK: config.knowledgeTopK,
      }),
    );
  }

  const mcpNotes: string[] = [];
  const mcpClients: Array<{ close: () => Promise<void> }> = [];
  if (config.mcp) {
    try {
      const parsed = parseMcpConfig(JSON.parse(fs.readFileSync(config.mcpConfigFile, "utf8")));
      mcpNotes.push(...parsed.problems);
      const loaded = await loadMcpTools({ config: parsed.config, allow: config.mcpAllow });
      tools.push(...loaded.tools);
      mcpClients.push(...loaded.clients);
      mcpNotes.push(...loaded.notes);
    } catch (err) {
      mcpNotes.push(`读取 ${config.mcpConfigFile} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const primary = resolveModel(config, config.model);
  const compactSource = config.compactModel ? resolveModel(config, config.compactModel) : null;
  const summarize = compactSource
    ? makeSummarizer(
        createOpenAIProvider({ baseUrl: compactSource.baseUrl, apiKey: compactSource.apiKey }),
        compactSource.model,
      )
    : undefined;

  const loop = new AgentLoop({
    provider: createOpenAIProvider({ baseUrl: primary.baseUrl, apiKey: primary.apiKey }),
    model: primary.model,
    tools,
    workspace,
    exec: sandbox.exec,
    // 项目约定与 CLI 走同一条路径：桌面端与终端看到的系统提示必须是同一个
    systemPrompt: buildSystemPrompt(workspace, config.systemExtra, loadProjectMemory(workspace)),
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    // 桌面端会话往往更长，压缩必须和 CLI 一致，否则同一段历史两边表现不同
    compaction: {
      budget: config.contextBudget,
      keepRecentTurns: config.keepRecentTurns,
      ...(config.keepTokens > 0 ? { keepTokens: config.keepTokens } : {}),
      ...(summarize ? { summarize } : {}),
    },
    // RPC 宿主没人可以问：确认模式要求的调用一律拒绝，除非宿主显式 --yes
    confirmMode: config.confirm,
    assumeYes: config.assumeYes,
    retry: config.retries > 1 ? { ...DEFAULT_RETRY, attempts: config.retries } : NO_RETRY,
  });

  loop.setEventHandler((event) => writeLine({ type: "event", event }));

  writeLine({
    type: "ready",
    protocol: 1,
    workspace,
    model: primary.alias ? `${primary.alias} → ${primary.model}` : primary.model,
    sandbox: sandbox.describe(),
    isolated: sandbox.isolated,
    perms: config.perms,
    confirm: config.confirm,
    assumeYes: config.assumeYes,
    projectMemory: loadProjectMemory(workspace)?.path ?? null,
    knowledge: knowledgeConfigured({ url: config.knowledgeUrl }),
    mcpTools: tools.filter((t) => t.name.startsWith("mcp__")).length,
    mcpNotes,
    // 桌面端要知道：MCP 工具在这里只认放行列表，发起调用前得自己确认过
    mcpConfirm: config.mcp ? "allowlist" : "off",
    cmdAllow: allow.rules.map((r) => r.raw),
    cmdAllowProblems: allow.problems,
  });

  process.stdin.setEncoding("utf8");
  let buffer = "";

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) void handleLine(line);
      idx = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    for (const c of mcpClients) void c.close();
    process.exit(0);
  });

  let shuttingDown = false;

  async function handleLine(line: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      writeLine({ type: "response", id: null, ok: false, error: "不是合法 JSON" });
      return;
    }

    const id = req.id ?? null;
    const params = req.params ?? {};

    switch (req.method) {
      case "prompt": {
        const text = typeof params.text === "string" ? params.text : "";
        if (!text.trim()) {
          writeLine({ type: "response", id, ok: false, error: "text 不能为空" });
          return;
        }
        // 立即回执，真正的结束由 agent_settled 事件通知
        writeLine({ type: "response", id, ok: true, result: { accepted: true } });
        const outcome = await loop.submit(text);
        writeLine({ type: "response", id: null, ok: true, result: { done: true, outcome } });
        return;
      }
      case "steer":
      case "queue": {
        const text = typeof params.text === "string" ? params.text : "";
        if (!text.trim()) {
          writeLine({ type: "response", id, ok: false, error: "text 不能为空" });
          return;
        }
        if (req.method === "steer") loop.steer(text);
        else loop.queue(text);
        writeLine({ type: "response", id, ok: true, result: loop.getSnapshot() });
        return;
      }
      case "abort": {
        loop.abort();
        writeLine({ type: "response", id, ok: true, result: { aborted: true } });
        return;
      }
      case "get_state": {
        writeLine({ type: "response", id, ok: true, result: loop.getSnapshot() });
        return;
      }
      case "reset": {
        loop.reset();
        writeLine({ type: "response", id, ok: true, result: { reset: true } });
        return;
      }
      case "usage": {
        writeLine({ type: "response", id, ok: true, result: loop.getUsage() });
        return;
      }
      case "shutdown": {
        shuttingDown = true;
        writeLine({ type: "response", id, ok: true, result: { bye: true } });
        for (const c of mcpClients) await c.close();
        process.exit(0);
        return;
      }
      default:
        writeLine({ type: "response", id, ok: false, error: `未知方法：${String(req.method)}` });
    }
  }

  // 常驻，直到 stdin 关闭或收到 shutdown
  await new Promise<void>(() => {
    if (shuttingDown) return;
  });
  return 0;
}
