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

import readline from "node:readline";
import process from "node:process";
import path from "node:path";
import { loadConfig, writeExampleConfig, CONFIG_FILE } from "./config.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { AgentLoop } from "./core/loop.ts";
import { SessionStore, defaultSessionDir } from "./core/session.ts";
import { estimateMessages } from "./core/compact.ts";
import { createOpenAIProvider } from "./providers/openai.ts";
import { builtinTools } from "./tools/builtin.ts";
import { assertWorkspace, defaultPolicy, redact } from "./safety/policy.ts";
import { createSandbox, handshake, describePlatform } from "./safety/exec.ts";
import { startRpcHost } from "./rpc/host.ts";
import type { AgentEvent, ChatMessage } from "./types.ts";

const VERSION = "0.2.0";

interface Runtime {
  config: ReturnType<typeof loadConfig>;
  loop: AgentLoop;
  sandboxInfo: string;
  session: SessionStore | null;
}

async function buildRuntime(session: SessionStore | null, workspace?: string): Promise<Runtime> {
  const config = loadConfig({ workspace: workspace ?? loadConfig().workspace });
  const ws = assertWorkspace(config.workspace);
  const policy = defaultPolicy({ workspace: ws });
  const sandbox = createSandbox({ mode: config.sandbox, policy });
  await handshake(sandbox, ws);

  const tools = builtinTools({ policy });
  const provider = createOpenAIProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  const loop = new AgentLoop({
    provider,
    model: config.model,
    tools,
    workspace: ws,
    exec: sandbox.exec,
    systemPrompt: buildSystemPrompt(ws, config.systemExtra),
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    compaction: { budget: config.contextBudget, keepRecentTurns: config.keepRecentTurns },
    onRecord: session
      ? (rec) => {
          if (rec.kind === "message") session.appendMessage(rec.message);
          else if (rec.kind === "compact") session.appendCompact(rec.before, rec.after, rec.folded);
          else session.appendNote("reset");
        }
      : undefined,
  });

  return { config, loop, sandboxInfo: sandbox.describe(), session };
}

function maskKey(key: string): string {
  if (!key) return "（未配置）";
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
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

async function doctor(): Promise<number> {
  const config = loadConfig();
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

    const sandbox = createSandbox({ mode: config.sandbox, policy });
    const token = await handshake(sandbox, ws);
    console.log("执行握手   ", `通过（token ${token.slice(0, 6)}…）`);
    console.log("隔离能力   ", sandbox.isolated ? "已启用" : "未启用（进程级隔离后端未安装）");
    if (config.sandbox === "strict" && !sandbox.isolated) {
      console.log("结论       ", "strict 模式下命令执行会被拒绝，请改回 policy 或安装隔离后端");
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
  console.log("上下文预算 ", `${config.contextBudget} tokens，保留最近 ${config.keepRecentTurns} 轮`);
  console.log("会话保存   ", config.saveSession ? "开启" : "关闭");

  if (!config.apiKey || config.apiKey.includes("在这里填")) {
    console.log("提示       ", `还没有配置 API Key，可编辑 ${CONFIG_FILE}`);
    ok = false;
  }
  console.log("─".repeat(52));
  console.log(ok ? "状态：可用" : "状态：需要处理后才能正常跑");
  return ok ? 0 : 1;
}

async function runOnce(task: string, json: boolean, session: SessionStore | null): Promise<number> {
  const rt = await buildRuntime(session);
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

async function interactive(opts: { session?: SessionStore | null; resume?: boolean } = {}): Promise<number> {
  const session = opts.session === undefined ? newSession(loadConfig()) : opts.session;
  const rt = await buildRuntime(session);
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
  console.log(`输入 /help 查看命令，Ctrl+C 中止当前任务，Ctrl+D 退出\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36m›\x1b[0m " });

  let streaming = false;
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

async function resumeSession(id: string): Promise<number> {
  const cfg = loadConfig();
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
  return interactive({ session: store, resume: true });
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
  --sandbox <policy|strict>   沙盒模式，strict 下命令执行需隔离后端
  --no-save                   不写会话文件
  --json                      事件流输出

环境变量：
  FEIMA_API_KEY / FEIMA_BASE_URL / FEIMA_MODEL / FEIMA_WORKSPACE / FEIMA_SANDBOX
  FEIMA_CONTEXT_BUDGET（默认 22000）/ FEIMA_KEEP_TURNS（默认 3）/ FEIMA_NO_SAVE
  FEIMA_HOME（覆盖 ~/.feima）
`);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (!args.length) return interactive();

  const cmd = args[0];
  const flags = parseFlags(args.slice(1));
  const saveOverride: Partial<{ saveSession: boolean }> = flags.noSave ? { saveSession: false } : {};

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
  if (cmd === "doctor") return doctor();
  if (cmd === "rpc") return startRpcHost({ workspace: flags.workspace });
  if (cmd === "sessions") return sessionsCommand(flags.rest, flags.json);
  if (cmd === "resume") return resumeSession(flags.rest[0] ?? "last");
  if (cmd === "run") {
    const task = flags.rest.join(" ").trim();
    if (!task) {
      console.error("缺少任务描述，例如：feima run \"把 README 里的 TODO 补完\"");
      return 2;
    }
    const cfg = loadConfig(saveOverride);
    return runOnce(task, flags.json, newSession(cfg));
  }

  // 兜底：按一次性任务处理，方便 feima "直接说需求"
  return runOnce(args.join(" "), false, newSession(loadConfig(saveOverride)));
}

function parseFlags(rest: string[]): {
  json: boolean;
  noSave: boolean;
  workspace?: string;
  rest: string[];
  model?: string;
} {
  const out = {
    json: false,
    noSave: false,
    rest: [] as string[],
    workspace: undefined as string | undefined,
    model: undefined as string | undefined,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") out.json = true;
    else if (a === "--no-save") out.noSave = true;
    else if (a === "--workspace") out.workspace = rest[++i];
    else if (a === "--model") out.model = rest[++i];
    else out.rest.push(a);
  }
  return out;
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[错误] ${redact(err instanceof Error ? err.stack ?? err.message : String(err))}`);
    process.exit(1);
  });
