#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 子命令：
 *   feima                      交互模式
 *   feima run "任务描述"       单次执行，适合脚本与 CI
 *   feima rpc                  JSONL over stdio，供桌面端/GUI 驱动
 *   feima doctor               体检：配置、策略、沙盒握手
 */

import readline from "node:readline";
import process from "node:process";
import { loadConfig, writeExampleConfig, CONFIG_FILE } from "./config.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { AgentLoop } from "./core/loop.ts";
import { createOpenAIProvider } from "./providers/openai.ts";
import { builtinTools } from "./tools/builtin.ts";
import { assertWorkspace, defaultPolicy, redact } from "./safety/policy.ts";
import { createSandbox, handshake, describePlatform } from "./safety/exec.ts";
import { startRpcHost } from "./rpc/host.ts";

const VERSION = "0.1.0";

interface Runtime {
  config: ReturnType<typeof loadConfig>;
  loop: AgentLoop;
  sandboxInfo: string;
}

async function buildRuntime(overrides: { workspace?: string } = {}): Promise<Runtime> {
  const config = loadConfig({ workspace: overrides.workspace ?? loadConfig().workspace });
  const workspace = assertWorkspace(config.workspace);
  const policy = defaultPolicy({ workspace });
  const sandbox = createSandbox({ mode: config.sandbox, policy });
  await handshake(sandbox, workspace);

  const tools = builtinTools({ policy });
  const provider = createOpenAIProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey });

  const loop = new AgentLoop({
    provider,
    model: config.model,
    tools,
    workspace,
    exec: sandbox.exec,
    systemPrompt: buildSystemPrompt(workspace, config.systemExtra),
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
  });

  return { config, loop, sandboxInfo: sandbox.describe() };
}

function maskKey(key: string): string {
  if (!key) return "（未配置）";
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}

async function doctor(): Promise<number> {
  const config = loadConfig();
  console.log("飞码 CodingAgent · 体检");
  console.log("─".repeat(46));
  console.log("运行环境   ", describePlatform());
  console.log("工作区     ", config.workspace);
  console.log("模型       ", `${config.model} @ ${config.baseUrl}`);
  console.log("API Key    ", maskKey(config.apiKey));
  console.log("配置文件   ", CONFIG_FILE);

  let ok = true;
  try {
    const workspace = assertWorkspace(config.workspace);
    const policy = defaultPolicy({ workspace });
    console.log("沙盒模式   ", config.sandbox);
    console.log("denyRead   ", policy.denyRead.length, "项");
    console.log("denyWrite  ", policy.denyWrite.length, "项");

    const sandbox = createSandbox({ mode: config.sandbox, policy });
    const token = await handshake(sandbox, workspace);
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

  if (!config.apiKey || config.apiKey.includes("在这里填")) {
    console.log("提示       ", `还没有配置 API Key，可编辑 ${CONFIG_FILE}`);
    ok = false;
  }
  console.log("─".repeat(46));
  console.log(ok ? "状态：可用" : "状态：需要处理后才能正常跑");
  return ok ? 0 : 1;
}

async function runOnce(task: string, json: boolean): Promise<number> {
  const rt = await buildRuntime();
  if (!json) console.log(`▸ 工作区 ${rt.config.workspace}\n▸ 模型 ${rt.config.model}\n`);

  let exitCode = 0;
  rt.loop.setEventHandler(json ? jsonEvents : consoleEvents(false));

  const outcome = await rt.loop.submit(task);
  if (outcome !== "done") exitCode = outcome === "aborted" ? 130 : 1;
  return exitCode;
}

const jsonEvents = (e: unknown): void => {
  process.stdout.write(JSON.stringify(e) + "\n");
};

function consoleEvents(interactive: boolean): (e: import("./types.ts").AgentEvent) => void {
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

async function interactive(): Promise<number> {
  const rt = await buildRuntime();
  const cfg = rt.config;

  console.log(`飞码 CodingAgent v${VERSION}`);
  console.log(`工作区 ${cfg.workspace}`);
  console.log(`模型   ${cfg.model}  沙盒 ${rt.sandboxInfo}`);
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
      await handleSlash(text, rt.loop, rl);
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

async function handleSlash(cmd: string, loop: AgentLoop, rl: readline.Interface): Promise<void> {
  const [name, ...rest] = cmd.split(/\s+/);
  switch (name) {
    case "/help":
      console.log(
        [
          "/help          显示帮助",
          "/state         查看运行状态",
          "/stop          中止当前任务",
          "/reset         清空对话上下文",
          "/config        显示当前配置",
          "/exit          退出（Ctrl+D 同）",
          "其余输入直接发给模型；运行中键入会被当作插话",
        ].join("\n"),
      );
      break;
    case "/state":
      console.log(JSON.stringify(loop.getSnapshot(), null, 2));
      break;
    case "/stop":
      loop.abort();
      break;
    case "/reset":
      loop.reset();
      console.log("上下文已清空");
      break;
    case "/config": {
      const cfg = loadConfig();
      console.log(
        JSON.stringify({ ...cfg, apiKey: maskKey(cfg.apiKey) }, null, 2),
      );
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

function usage(): void {
  console.log(`飞码 CodingAgent v${VERSION}

用法：
  feima                       交互模式
  feima run "任务描述"        单次执行
  feima run "任务" --json     事件以 JSONL 输出（脚本/CI 用）
  feima rpc                   JSONL over stdio，给 GUI 用
  feima doctor                体检
  feima init                  生成 ~/.feima/config.json 示例

选项：
  --workspace <dir>           指定工作区，默认当前目录
  --model <name>              覆盖模型
  --sandbox <policy|strict>   沙盒模式，strict 下命令执行需隔离后端

环境变量：
  FEIMA_API_KEY / FEIMA_BASE_URL / FEIMA_MODEL / FEIMA_WORKSPACE / FEIMA_SANDBOX
`);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (!args.length) return interactive();

  const cmd = args[0];
  const flags = parseFlags(args.slice(1));

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
  if (cmd === "run") {
    const task = flags.rest.join(" ").trim();
    if (!task) {
      console.error("缺少任务描述，例如：feima run \"把 README 里的 TODO 补完\"");
      return 2;
    }
    return runOnce(task, flags.json);
  }

  // 兜底：按一次性任务处理，方便 feima "直接说需求"
  return runOnce(args.join(" "), false);
}

function parseFlags(rest: string[]): { json: boolean; workspace?: string; rest: string[]; model?: string } {
  const out = { json: false, rest: [] as string[], workspace: undefined as string | undefined, model: undefined as string | undefined };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") out.json = true;
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
