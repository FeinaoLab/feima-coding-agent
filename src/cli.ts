#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 子命令：
 *   feima                      交互模式（自动开会话）
 *   feima run "任务描述"       单次执行，适合脚本与 CI
 *   feima resume [id|last]     恢复会话继续
 *   feima sessions             列出会话（--json 可解析）
 *   feima sessions rm <id>     删除会话
 *   feima rpc                  JSONL over stdio，供桌面端/GUI 驱动
 *   feima doctor               体检：配置、策略、沙盒握手、上下文与存储
 */

import fs from "node:fs";
import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { loadConfig, writeExampleConfig, CONFIG_FILE, type FeimaConfig } from "./config.ts";
import { buildSystemPrompt, loadProjectMemory, type ProjectMemory } from "./prompt.ts";
import { AgentLoop } from "./core/loop.ts";
import { SessionStore, defaultSessionDir } from "./core/session.ts";
import { estimateMessages } from "./core/compact.ts";
import { createOpenAIProvider } from "./providers/openai.ts";
import { builtinTools } from "./tools/builtin.ts";
import { createKnowledgeTool, knowledgeConfigured } from "./tools/knowledge.ts";
import { parseMcpConfig, type McpClient } from "./mcp/client.ts";
import { loadMcpTools } from "./mcp/tools.ts";
import { assertWorkspace, defaultPolicy, redact } from "./safety/policy.ts";
import { createSandbox, handshake, describePlatform, probeIsolation } from "./safety/exec.ts";
import { grantAncestors } from "./safety/backends/appcontainer.ts";
import { startRpcHost } from "./rpc/host.ts";
import { parseFlags } from "./cli/flags.ts";
import type { AgentEvent, ChatMessage } from "./types.ts";

const VERSION = "0.4.0";

interface Runtime {
  config: ReturnType<typeof loadConfig>;
  loop: AgentLoop;
  sandboxInfo: string;
  session: SessionStore | null;
  /** 工作区 AGENTS.md 的载入结果；null 表示没有 */
  memory: ProjectMemory | null;
  /** 知识库检索是否启用 */
  knowledge: boolean;
  /** MCP 装载过程中的说明与失败原因，启动横幅与 doctor 共用 */
  mcpNotes: string[];
  /** 收尾：关掉 MCP 子进程 */
  dispose: () => Promise<void>;
}

// 运行时覆盖沿用整套配置类型：新增开关（沙盒、隔离后端、网络）不必再改签名
type RuntimeOpts = Partial<FeimaConfig>;

async function buildRuntime(session: SessionStore | null, opts: RuntimeOpts = {}): Promise<Runtime> {
  const config = loadConfig(opts);
  const ws = assertWorkspace(config.workspace);
  const policy = defaultPolicy({ workspace: ws });
  const sandbox = createSandbox({
    mode: config.sandbox,
    policy,
    isolation: config.isolation,
    network: config.network,
    dockerImage: config.dockerImage,
  });
  await sandbox.init();
  const verify = await handshake(sandbox);
  if (config.sandbox === "strict" && !verify.ok) {
    throw new Error(`隔离自检未通过：${verify.detail}`);
  }
  // 退出时撤销 AppContainer 的目录授权：留着 ACL 就是安全债
  process.once("exit", () => void sandbox.dispose());

  const memory = loadProjectMemory(ws);
  const tools = builtinTools({ policy });

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
  const clients: McpClient[] = [];
  if (config.mcp) {
    let servers: Parameters<typeof loadMcpTools>[0]["config"] = { servers: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(config.mcpConfigFile, "utf8"));
      const parsed = parseMcpConfig(raw);
      servers = parsed.config;
      mcpNotes.push(...parsed.problems);
    } catch (err) {
      mcpNotes.push(`读取 ${config.mcpConfigFile} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (Object.keys(servers.servers).length) {
      const loaded = await loadMcpTools({ config: servers, allow: config.mcpAllow });
      tools.push(...loaded.tools);
      clients.push(...loaded.clients);
      mcpNotes.push(...loaded.notes);
    }
    process.once("exit", () => {
      for (const c of clients) void c.close();
    });
  }

  const provider = createOpenAIProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  const loop = new AgentLoop({
    provider,
    model: config.model,
    tools,
    workspace: ws,
    exec: sandbox.exec,
    systemPrompt: buildSystemPrompt(ws, config.systemExtra, memory),
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    compaction: {
      budget: config.contextBudget,
      keepRecentTurns: config.keepRecentTurns,
      ...(config.keepTokens > 0 ? { keepTokens: config.keepTokens } : {}),
    },
    onRecord: session
      ? (rec) => {
          if (rec.kind === "message") session.appendMessage(rec.message);
          else if (rec.kind === "compact") session.appendCompact(rec.before, rec.after, rec.folded);
          else session.appendNote("reset");
        }
      : undefined,
  });

  return {
    config,
    loop,
    sandboxInfo: sandbox.describe(),
    session,
    memory,
    knowledge: knowledgeConfigured({ url: config.knowledgeUrl }),
    mcpNotes,
    dispose: async () => {
      for (const c of clients) await c.close();
      await sandbox.dispose();
    },
  };
}

function maskKey(key: string): string {
  if (!key) return "（未配置）";
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}

/** readline 的问题-回答包成 Promise；确认闸门要用 */
function askLine(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

function newSession(config: ReturnType<typeof loadConfig>): SessionStore | null {
  if (!config.saveSession) return null;
  try {
    return SessionStore.create({ workspace: config.workspace, model: config.model });
  } catch (err) {
    console.error(`[警告] 会话无法落盘，本次不保存：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function doctor(opts: RuntimeOpts = {}): Promise<number> {
  const config = loadConfig(opts);
  console.log("飞码 CodingAgent · 体检");
  console.log("─".repeat(52));
  console.log("运行环境   ", describePlatform());
  console.log("工作区     ", config.workspace);
  console.log("模型       ", `${config.model} @ ${config.baseUrl}`);
  console.log("API Key    ", maskKey(config.apiKey));
  console.log("配置文件   ", CONFIG_FILE);

  let ok = true;
  try {
    const ws = assertWorkspace(config.workspace);
    const policy = defaultPolicy({ workspace: ws });
    console.log("沙盒模式   ", config.sandbox);
    console.log("denyRead   ", policy.denyRead.length, "项");
    console.log("denyWrite  ", policy.denyWrite.length, "项");

    for (const probe of probeIsolation({ network: config.network, dockerImage: config.dockerImage })) {
      console.log(`后端 ${probe.id.padEnd(13)}`, probe.availability.available
        ? `可用（${probe.availability.reason}）`
        : `不可用（${probe.availability.reason}）`);
    }

    const sandbox = createSandbox({
      mode: config.sandbox,
      policy,
      isolation: config.isolation,
      network: config.network,
      dockerImage: config.dockerImage,
    });
    console.log("隔离后端   ", sandbox.describe());
    console.log("选择理由   ", sandbox.rationale);
    await sandbox.init();

    const verify = await handshake(sandbox);
    if (!sandbox.isolated) {
      console.log("隔离自检   ", "跳过（当前没有任何隔离后端，策略层仍然生效）");
    } else {
      console.log("隔离自检   ", verify.ok ? "通过" : "未通过");
      console.log("  明细     ", verify.detail);
    }
    await sandbox.dispose();

    if (config.sandbox === "strict" && !verify.ok) {
      console.log("结论       ", "strict 模式下命令执行会被拒绝，请查看上面的探测原因");
      ok = false;
    }
  } catch (err) {
    console.log("检查失败   ", err instanceof Error ? err.message : String(err));
    ok = false;
  }

  try {
    const dir = defaultSessionDir();
    const list = SessionStore.list(dir);
    console.log("会话目录   ", `${dir}（${list.length} 个）`);
  } catch (err) {
    console.log("会话目录   ", `不可用：${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(
    "上下文预算 ",
    `${config.contextBudget} tokens，保留最近 ${config.keepRecentTurns} 轮` +
      `（单轮长工具链按 ${config.keepTokens || Math.floor(config.contextBudget / 2)} tokens 保留尾部）`,
  );
  console.log("会话保存   ", config.saveSession ? "开启" : "关闭");

  // 项目约定：只报结论，不打印正文——AGENTS.md 可能几十 KB
  const mem = loadProjectMemory(config.workspace);
  console.log(
    "项目约定   ",
    mem
      ? `${path.relative(config.workspace, mem.path) || "AGENTS.md"} 已载入 ${(mem.bytes / 1024).toFixed(1)} KB${mem.truncated ? "（超长已截断到 32 KB）" : ""}`
      : "未找到 AGENTS.md（可选，放在工作区根目录即可自动载入）",
  );

  // 知识库：配置了就真跑一次检索。检测到有 URL 和真能检索是两件事
  if (!knowledgeConfigured({ url: config.knowledgeUrl })) {
    console.log("知识库     ", "未配置（设置 FEIMA_KB_URL 后启用 search_knowledge）");
  } else {
    const hasAuth = Boolean(config.knowledgeToken || (config.knowledgeUser && config.knowledgePassword));
    const tool = createKnowledgeTool({
      url: config.knowledgeUrl,
      token: config.knowledgeToken,
      username: config.knowledgeUser,
      password: config.knowledgePassword,
      topK: 1,
      timeoutMs: 5000,
    });
    const probe = await tool.run({ query: "飞码", limit: 1 }, {
      workspace: config.workspace,
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    });
    console.log("知识库     ", config.knowledgeUrl + (hasAuth ? "（已配置凭据）" : "（缺凭据）"));
    console.log("  检索探针 ", probe.ok ? probe.content.split("\n")[0] : `失败：${probe.content.split("\n")[0]}`);
    if (!probe.ok) ok = false;
  }

  // MCP：默认关闭；开启了就真起一次子进程，而不是只读配置文件
  if (!config.mcp) {
    console.log("MCP        ", `未启用（外部工具默认关闭，--mcp 打开；配置写在 ${config.mcpConfigFile}）`);
  } else {
    let notes: string[] = [];
    let toolCount = 0;
    let clients: McpClient[] = [];
    try {
      const parsed = parseMcpConfig(JSON.parse(fs.readFileSync(config.mcpConfigFile, "utf8")));
      notes = parsed.problems.slice();
      const loaded = await loadMcpTools({ config: parsed.config, allow: config.mcpAllow });
      toolCount = loaded.tools.length;
      clients = loaded.clients;
      notes.push(...loaded.notes);
    } catch (err) {
      notes.push(`读取 ${config.mcpConfigFile} 失败：${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      console.log("MCP        ", `${config.mcpConfigFile} → ${toolCount} 个工具`);
      for (const note of notes) console.log("  ", note);
      if (config.mcpAllow.length) console.log("  放行列表 ", config.mcpAllow.join(", "));
      else console.log("  放行列表 ", "空（非交互模式下一律拒绝，交互模式逐次确认）");
    } finally {
      for (const c of clients) await c.close();
    }
  }

  if (!config.apiKey || config.apiKey.includes("在这里填")) {
    console.log("提示       ", `还没有配置 API Key，可编辑 ${CONFIG_FILE}`);
    ok = false;
  }
  console.log("─".repeat(52));
  console.log(ok ? "状态：可用" : "状态：需要处理后才能正常跑");
  return ok ? 0 : 1;
}

async function runOnce(
  task: string,
  json: boolean,
  session: SessionStore | null,
  opts: RuntimeOpts = {},
): Promise<number> {
  const rt = await buildRuntime(session, opts);
  if (!json) console.log(`▸ 工作区 ${rt.config.workspace}\n▸ 模型 ${rt.config.model}`);
  if (!json && session) console.log(`▸ 会话 ${session.id}`);
  if (!json) console.log("");

  let exitCode = 0;
  rt.loop.setEventHandler(json ? jsonEvents : consoleEvents(false));

  const outcome = await rt.loop.submit(task);
  if (outcome !== "done") exitCode = outcome === "aborted" ? 130 : 1;
  return exitCode;
}

const jsonEvents = (e: unknown): void => {
  process.stdout.write(JSON.stringify(e) + "\n");
};

function consoleEvents(interactive: boolean): (e: AgentEvent) => void {
  return (e) => {
    switch (e.type) {
      case "text_delta":
        process.stdout.write(e.text);
        break;
      case "tool_start": {
        const brief = e.args.length > 120 ? e.args.slice(0, 120) + "…" : e.args;
        process.stdout.write(`\n\x1b[36m▶ ${e.name}\x1b[0m ${brief}\n`);
        break;
      }
      case "tool_end":
        process.stdout.write(`\x1b[${e.ok ? "32" : "31"}m${e.ok ? "✓" : "✗"} ${e.name}\x1b[0m ${e.preview}\n`);
        break;
      case "compact":
        process.stdout.write(
          `\n\x1b[35m[上下文折叠] ${e.folded} 条消息 → 摘要，` +
            `${Math.round((e.before / 1000) * 10) / 10}k → ${Math.round((e.after / 1000) * 10) / 10}k tokens\x1b[0m\n`,
        );
        break;
      case "error":
        process.stdout.write(`\n\x1b[31m[错误] ${e.message}\x1b[0m\n`);
        break;
      case "aborted":
        process.stdout.write("\n\x1b[33m[已中止]\x1b[0m\n");
        break;
      case "usage":
        if (!interactive) process.stdout.write(`\n\x1b[90m[tokens ${e.usage.total_tokens}]\x1b[0m\n`);
        break;
      default:
        break;
    }
  };
}

/** 恢复会话时给一段概览，别让人对着空白屏幕猜刚才聊到哪 */
function printResumeBanner(loop: AgentLoop, session: SessionStore, loaded: ReturnType<SessionStore["load"]>): void {
  console.log(`已恢复会话 ${session.id} · ${loaded.meta.title}`);
  console.log(
    `消息 ${loaded.messages.length} 条，折叠 ${loaded.compacts} 次，约 ${estimateMessages(loop.getHistory())} tokens`,
  );
  if (loaded.broken) console.log(`\x1b[33m跳过 ${loaded.broken} 行损坏记录（会话曾异常退出）\x1b[0m`);
  const recent = loaded.messages.filter((m) => m.role === "user" && m.content && !m.content.startsWith("[上下文摘要")).slice(-3);
  for (const m of recent) {
    const t = (m.content ?? "").replace(/\s+/g, " ").slice(0, 70);
    console.log(`  › ${t}`);
  }
  console.log("");
}

async function interactive(
  opts: { session?: SessionStore | null; resume?: boolean } & RuntimeOpts = {},
): Promise<number> {
  const session = opts.session === undefined ? newSession(loadConfig(opts)) : opts.session;
  const rt = await buildRuntime(session, opts);
  const cfg = rt.config;

  if (session && opts.resume !== false && opts.session) {
    const loaded = session.load();
    rt.loop.restore(loaded.messages);
    printResumeBanner(rt.loop, session, loaded);
  } else {
    console.log(`飞码 CodingAgent v${VERSION}`);
    console.log(`工作区 ${cfg.workspace}`);
    console.log(`模型   ${cfg.model}  沙盒 ${rt.sandboxInfo}`);
    console.log(`上下文 ${cfg.contextBudget} tokens 自动折叠，保留最近 ${cfg.keepRecentTurns} 轮`);
    if (session) console.log(`会话   ${session.id}（已开启持久化）`);
  }
  console.log(`项目约定 ${rt.memory ? `已载入 ${(rt.memory.bytes / 1024).toFixed(1)} KB（AGENTS.md）` : "未找到 AGENTS.md"}`);
  console.log(`知识库 ${rt.knowledge ? cfg.knowledgeUrl + "（search_knowledge 已启用）" : "未配置（跳过 search_knowledge）"}`);
  if (cfg.mcp) {
    console.log(`MCP    ${rt.mcpNotes.length ? rt.mcpNotes.join("；") : "已启用，但没有可用工具"}`);
  } else {
    console.log("MCP    未启用（外部工具默认关闭，--mcp 打开）");
  }
  console.log(`输入 /help 查看命令，Ctrl+C 中止当前任务，Ctrl+D 退出\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36m›\x1b[0m " });

  let streaming = false;

  // 外部工具逐次确认：MCP 不在飞码的策略层里，每一次调用都得让人看见参数
  rt.loop.setConfirm(async (req) => {
    if (streaming) process.stdout.write("\x1b[90m（任务进行中，需要你确认一个外部动作）\x1b[0m\n");
    const answer = await askLine(rl, `\x1b[33m[确认] ${req.title}\x1b[0m\n${req.detail}\n允许执行？(y/N) `);
    return /^y(es)?$/i.test(answer.trim());
  });

  const print = consoleEvents(true);
  rt.loop.setEventHandler((e) => {
    if (e.type === "status") streaming = e.state === "chatting";
    print(e);
  });

  process.on("SIGINT", () => {
    const snap = rt.loop.getSnapshot();
    if (snap.isStreaming) {
      rt.loop.abort();
      process.stdout.write("\n\x1b[33m已中止，输入新指令继续\x1b[0m\n");
    } else {
      process.stdout.write("\n");
      rl.close();
      process.exit(0);
    }
  });

  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }
    if (text.startsWith("/")) {
      await handleSlash(text, rt, rl);
      if (!text.startsWith("/exit")) rl.prompt();
      return;
    }

    // 流式期间输入会被当成插话，不另起一轮
    if (streaming) process.stdout.write("\x1b[90m（已排队为插话）\x1b[0m\n");
    await rt.loop.submit(text);
    process.stdout.write("\n");
    rl.prompt();
  });

  return 0;
}

async function handleSlash(cmd: string, rt: Runtime, rl: readline.Interface): Promise<void> {
  const [name, ...rest] = cmd.split(/\s+/);
  switch (name) {
    case "/help":
      console.log(
        [
          "/help          显示帮助",
          "/state         查看运行状态（含上下文估算）",
          "/context       只看上下文占用与压缩次数",
          "/compact       立即折叠早期历史（模型摘要，失败降级为规则摘要）",
          "/stop          中止当前任务",
          "/reset         清空对话上下文（会话文件保留，另起一条 reset 记录）",
          "/new           开一个新会话并清空上下文",
          "/resume [id]   恢复某个会话，不传 id 用最近一个",
          "/sessions      列出全部会话",
          "/config        显示当前配置",
          "/exit          退出（Ctrl+D 同）",
          "其余输入直接发给模型；运行中键入会被当作插话",
        ].join("\n"),
      );
      break;
    case "/state":
      console.log(JSON.stringify({ ...rt.loop.getSnapshot(), session: rt.session?.id ?? null }, null, 2));
      break;
    case "/context": {
      const snap = rt.loop.getSnapshot();
      console.log(
        `约 ${snap.contextTokens} / ${rt.config.contextBudget} tokens，` +
          `消息 ${snap.messages} 条，已折叠 ${snap.compactions} 次`,
      );
      break;
    }
    case "/compact":
      console.log("正在折叠…");
      await rt.loop.compactNow();
      break;
    case "/stop":
      rt.loop.abort();
      break;
    case "/reset":
      rt.loop.reset();
      console.log("上下文已清空");
      break;
    case "/new": {
      const fresh = newSession(rt.config);
      if (!fresh) {
        console.log("会话持久化已关闭，仅清空上下文");
        rt.loop.reset();
        break;
      }
      rt.session = fresh;
      rt.loop.reset();
      console.log(`已开新会话 ${fresh.id}`);
      break;
    }
    case "/sessions":
      printSessionTable(SessionStore.list());
      break;
    case "/resume": {
      const id = rest[0] ?? "last";
      try {
        const store = SessionStore.open(id);
        const loaded = store.load();
        if (path.resolve(loaded.meta.workspace) !== path.resolve(rt.config.workspace)) {
          console.log(`\x1b[33m注意：该会话的原工作区是 ${loaded.meta.workspace}\x1b[0m`);
        }
        rt.session = store;
        rt.loop.restore(loaded.messages);
        printResumeBanner(rt.loop, store, loaded);
      } catch (err) {
        console.log(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }
    case "/config": {
      const cfg = loadConfig();
      console.log(JSON.stringify({ ...cfg, apiKey: maskKey(cfg.apiKey) }, null, 2));
      break;
    }
    case "/exit":
    case "/quit":
      rl.close();
      process.exit(0);
      break;
    default:
      if (name === "//") break;
      console.log(`未知命令 ${name}，输入 /help 查看`);
      if (rest.length) console.log("提示：直接输入内容即可发给模型");
  }
}

function printSessionTable(list: ReturnType<typeof SessionStore.list>): void {
  if (!list.length) {
    console.log("还没有任何会话");
    return;
  }
  // ISO 时间是 UTC，直接显示会差 8 小时，这里统一转本地
  const local = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const rows = list.slice(0, 20).map((s) => ({
    id: s.id,
    updated: local(s.updatedAt),
    msgs: String(s.messages),
    title: s.title,
    workspace: s.workspace,
  }));
  // 中文按双宽计算，否则列会错位
  const width = (s: string): number => [...s].reduce((n, ch) => n + (ch.codePointAt(0)! > 0x2e80 ? 2 : 1), 0);
  const pad = (s: string, w: number): string => s + " ".repeat(Math.max(1, w - width(s)));
  const cols = ["id", "updated", "msgs", "title", "workspace"] as const;
  const widths = cols.map((k) => Math.max(width(k), ...rows.map((r) => width(r[k]))) + 2);
  console.log(cols.map((k, i) => pad(k, widths[i])).join(""));
  for (const r of rows) {
    console.log(cols.map((k, i) => pad(r[k], widths[i])).join(""));
  }
  if (list.length > 20) console.log(`… 另有 ${list.length - 20} 个，feima sessions --json 查看全部`);
}

async function resumeSession(id: string, opts: RuntimeOpts = {}): Promise<number> {
  const cfg = loadConfig(opts);
  let store: SessionStore;
  try {
    store = SessionStore.open(id);
  } catch (err) {
    console.error(`[错误] ${err instanceof Error ? err.message : String(err)}`);
    console.error("用 feima sessions 查看可用会话");
    return 1;
  }
  const loaded = store.load();
  if (path.resolve(loaded.meta.workspace) !== path.resolve(cfg.workspace)) {
    console.log(`\x1b[33m注意：该会话原工作区为 ${loaded.meta.workspace}，当前工作区 ${cfg.workspace}\x1b[0m`);
  }
  return interactive({ session: store, resume: true, ...opts });
}

function sessionsCommand(args: string[], json: boolean): number {
  if (args[0] === "rm" || args[0] === "delete") {
    const id = args[1];
    if (!id) {
      console.error("用法：feima sessions rm <id>");
      return 2;
    }
    const done = SessionStore.remove(id);
    console.log(done ? `已删除 ${id}` : `没有找到 ${id}`);
    return done ? 0 : 1;
  }

  const list = SessionStore.list();
  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return 0;
  }
  printSessionTable(list);
  return 0;
}

function usage(): void {
  console.log(`飞码 CodingAgent v${VERSION}

用法：
  feima                       交互模式（自动创建会话）
  feima run "任务描述"        单次执行
  feima run "任务" --json     事件以 JSONL 输出（脚本/CI 用）
  feima resume [id|last]      恢复会话继续
  feima sessions              列出会话
  feima sessions rm <id>      删除会话
  feima rpc                   JSONL over stdio，给 GUI 用
  feima doctor                体检
  feima init                  生成 ~/.feima/config.json 示例

选项：
  --workspace <dir>           指定工作区，默认当前目录
  --model <name>              覆盖模型
  --sandbox <policy|strict>   沙盒模式：strict 必须有真隔离后端，否则拒绝执行命令
  --isolation <backend>       指定隔离后端：auto|appcontainer|bwrap|docker|none
  --network                   允许沙盒内出网（默认关闭）
  --docker-image <name>       docker 后端使用的镜像（默认 node:22-alpine）
  --no-save                   不写会话文件
  --json                      事件流输出
  --knowledge <url>           启用飞链 RAG 检索（知识库地址，例如 http://42.193.158.63）
  --kb-token <token>          知识库 token（也可用账号密码换，见环境变量）
  --mcp                       启用 MCP 外部工具（默认关闭；配置写在 ~/.feima/mcp.json）
  --mcp-config <file>         指定 MCP 配置文件
  --mcp-allow <a,b>           非交互模式下放行的 MCP 工具（交互模式逐次确认，不需要）

沙盒：
  feima sandbox grant [dir]   给 Windows AppContainer 授权工作区的上级目录（通常需管理员）

环境变量：
  FEIMA_API_KEY / FEIMA_BASE_URL / FEIMA_MODEL / FEIMA_WORKSPACE / FEIMA_SANDBOX
  FEIMA_ISOLATION（默认 auto）/ FEIMA_NETWORK=1（允许出网）/ FEIMA_DOCKER_IMAGE
  FEIMA_CONTEXT_BUDGET（默认 22000）/ FEIMA_KEEP_TURNS（默认 3）
  FEIMA_KEEP_TOKENS（单轮长工具链保留的尾部 token，默认取预算一半）/ FEIMA_NO_SAVE
  FEIMA_KB_URL / FEIMA_KB_TOKEN / FEIMA_KB_USER / FEIMA_KB_PASSWORD / FEIMA_KB_TOPK
  FEIMA_MCP=1（启用外部工具）/ FEIMA_MCP_CONFIG / FEIMA_MCP_ALLOW（逗号分隔）
  FEIMA_HOME（覆盖 ~/.feima）
`);
}

/**
 * `feima sandbox grant [dir]`
 *
 * AppContainer 要进入工作区，得先能穿过每一级上级目录；这些目录默认没有
 * 给容器的 ACE，而改它们往往需要管理员权限。这一步慢、要提权、会改系统状态，
 * 所以做成显式命令，不在启动路径里偷偷做。
 */
async function sandboxCommand(args: string[], opts: RuntimeOpts): Promise<number> {
  if (args[0] !== "grant") {
    console.error("用法：feima sandbox grant [dir]");
    return 2;
  }
  if (process.platform !== "win32") {
    console.error("sandbox grant 只对 Windows 的 AppContainer 后端有意义；Linux/macOS 用 bwrap / docker 不需要授权目录");
    return 2;
  }
  const target = assertWorkspace(args[1] ?? loadConfig(opts).workspace);
  const res = grantAncestors(target);
  for (const line of res.log) console.log(line);
  if (res.ok) {
    console.log("\n完成：AppContainer 现在可以进入这个工作区。用 FEIMA_SANDBOX=strict feima doctor 复验。");
    return 0;
  }
  console.log("\n有失败项。这些目录通常需要管理员权限，请用管理员终端重新执行本条命令。");
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (!args.length) return interactive();

  const cmd = args[0];
  const flags = parseFlags(args.slice(1));
  // 一份覆盖对象贯穿到底：沙盒模式与隔离后端同样要走命令行优先级，
  // 否则 `--sandbox strict` 只是被解析出来、并没有生效（v0.2.1 踩过的坑）
  const cfgOverride: RuntimeOpts = {
    ...(flags.noSave ? { saveSession: false } : {}),
    ...(flags.workspace ? { workspace: flags.workspace } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.sandbox ? { sandbox: flags.sandbox } : {}),
    ...(flags.isolation ? { isolation: flags.isolation } : {}),
    ...(flags.network ? { network: true } : {}),
    ...(flags.dockerImage ? { dockerImage: flags.dockerImage } : {}),
    ...(flags.knowledgeUrl ? { knowledgeUrl: flags.knowledgeUrl } : {}),
    ...(flags.knowledgeToken ? { knowledgeToken: flags.knowledgeToken } : {}),
    ...(flags.mcp ? { mcp: true } : {}),
    ...(flags.mcpConfigFile ? { mcpConfigFile: flags.mcpConfigFile } : {}),
    ...(flags.mcpAllow ? { mcpAllow: flags.mcpAllow } : {}),
  };

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }
  if (cmd === "init") {
    const file = writeExampleConfig(loadConfig());
    console.log(`已准备配置模板：${file}`);
    return 0;
  }
  // doctor 也吃命令行覆盖：否则 `feima doctor --mcp --mcp-config x` 会被静默忽略，
  // 用户看到「MCP 未启用」而以为自己参数写错了（v0.2.1 那类「解析出来没人用」）
  if (cmd === "doctor") return doctor(cfgOverride);
  if (cmd === "rpc") return startRpcHost(cfgOverride);
  if (cmd === "sessions") return sessionsCommand(flags.rest, flags.json);
  if (cmd === "sandbox") return sandboxCommand(flags.rest, cfgOverride);
  if (cmd === "resume") return resumeSession(flags.rest[0] ?? "last", cfgOverride);
  if (cmd === "run") {
    const task = flags.rest.join(" ").trim();
    if (!task) {
      console.error("缺少任务描述，例如：feima run \"把 README 里的 TODO 补完\"");
      return 2;
    }
    // 会话的 meta.workspace 必须与 --workspace 一致，否则列表里记的是另一个目录
    const cfg = loadConfig(cfgOverride);
    return runOnce(task, flags.json, newSession(cfg), { ...cfgOverride, workspace: cfg.workspace });
  }

  // 兜底：按一次性任务处理，方便 feima "直接说需求"
  const cfg = loadConfig(cfgOverride);
  return runOnce(flags.rest.join(" "), false, newSession(cfg), { ...cfgOverride, workspace: cfg.workspace });
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[错误] ${redact(err instanceof Error ? err.stack ?? err.message : String(err))}`);
    process.exit(1);
  });
