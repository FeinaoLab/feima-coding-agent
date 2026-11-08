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

import process from "node:process";
import { loadConfig } from "../config.ts";
import { buildSystemPrompt } from "../prompt.ts";
import { AgentLoop } from "../core/loop.ts";
import { createOpenAIProvider } from "../providers/openai.ts";
import { builtinTools } from "../tools/builtin.ts";
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

export async function startRpcHost(opts: { workspace?: string } = {}): Promise<number> {
  const config = loadConfig({ workspace: opts.workspace ?? loadConfig().workspace });
  const workspace = assertWorkspace(config.workspace);
  const policy = defaultPolicy({ workspace });
  const sandbox = createSandbox({ mode: config.sandbox, policy });

  try {
    await handshake(sandbox, workspace);
  } catch (err) {
    // 握手失败必须上报并退出，不能带着“假绿”继续接受命令
    writeLine({ type: "fatal", message: redact(err instanceof Error ? err.message : String(err)) });
    return 1;
  }

  const loop = new AgentLoop({
    provider: createOpenAIProvider({ baseUrl: config.baseUrl, apiKey: config.apiKey }),
    model: config.model,
    tools: builtinTools({ policy }),
    workspace,
    exec: sandbox.exec,
    systemPrompt: buildSystemPrompt(workspace, config.systemExtra),
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
  });

  loop.setEventHandler((event) => writeLine({ type: "event", event }));

  writeLine({
    type: "ready",
    protocol: 1,
    workspace,
    model: config.model,
    sandbox: sandbox.describe(),
    isolated: sandbox.isolated,
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
