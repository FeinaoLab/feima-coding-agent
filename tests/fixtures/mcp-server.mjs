#!/usr/bin/env node
/**
 * 测试用的最小 MCP 服务（stdio + 换行分隔 JSON-RPC）。
 *
 * 故意做几件"不合规但真实存在"的事：
 * - 往 stdout 打一行横幅（真服务端会这么干，协议要求不许）
 * - slow 工具永远不返回（验超时）
 * - FIXTURE_CRASH=1 时启动即退出（验启动失败的报错）
 */

const CRASH = process.env.FIXTURE_CRASH === "1";
if (CRASH) {
  process.stderr.write("fixture: 按配置直接退出\n");
  process.exit(3);
}

process.stdout.write("fixture-mcp 0.1.0 ready\n"); // 这行不是 JSON，客户端应忽略

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function handle(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "0.1.0" },
      },
    });
    return;
  }
  if (!msg.id && msg.method) return; // 通知

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "原样回显 text",
            inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
          {
            name: "fail-me",
            description: "永远返回 isError",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "slow",
            description: "永不返回，用来验超时",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "with.image",
            description: "返回一段文本加一张图",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: String(args.text ?? "") }] } });
      return;
    }
    if (name === "fail-me") {
      send({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: "故意失败" }] } });
      return;
    }
    if (name === "with.image") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: "图在下面" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      });
      return;
    }
    if (name === "slow") return; // 故意不回
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `未知工具 ${name}` } });
    return;
  }

  if (msg.id) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `未知方法 ${msg.method}` } });
}
