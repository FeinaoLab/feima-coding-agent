# 飞码 CodingAgent

中文优先的终端编程 Agent。零运行时依赖，一条命令跑起来，能读代码、改文件、执行命令，并把每一步都限制在你指定的工作区内。

```
feima run "把 src/config.ts 里的超时改成可配置，并补一个测试"
```

## 为什么又做一个

参考 `@inkwellio/my-coding-agent` 的桌面端实现之后，判断很清楚：桌面壳（Electron）不是难点，Agent 的**循环、状态机、安全边界**才是。飞码先把这三件事做对，再谈界面。

三条设计取向：

- **零依赖**。只用 Node 内置能力（`node:fs` / `node:child_process` / `fetch`）。没有 SDK、没有框架、没有状态库。装完之后 `node_modules` 是空的。
- **安全边界先于功能**。路径越界、环境变量泄漏、`.git/hooks` 持久化、符号链接绕过，这些在 v0.1 就堵住，不等以后。
- **状态以 `isStreaming` 为唯一权威**。事件只用来提示，不用来判定结束。这是 UI 不闪烁、任务不误判的前提。

## 快速开始

要求 Node ≥ 22.6（用内置 TS 类型擦除，无构建步骤）。

```bash
# 1. 配置（任选其一）
export FEIMA_BASE_URL=https://api.deepseek.com/v1
export FEIMA_API_KEY=sk-xxx
export FEIMA_MODEL=deepseek-chat

# 或者写配置文件
feima init && vi ~/.feima/config.json

# 2. 体检
feima doctor

# 3. 用起来
feima                                  # 交互模式
feima run "读一下 README，列出待办"      # 单次执行
feima run "跑测试并修失败用例" --json    # 事件流，给脚本用
feima rpc                              # JSONL 协议，给 GUI 用
```

本地模型也能直接用（Ollama 的 OpenAI 兼容端点）：

```bash
FEIMA_BASE_URL=http://localhost:11434/v1 FEIMA_API_KEY=ollama FEIMA_MODEL=qwen3:8b feima run "解释 src/core/loop.ts"
```

## 命令行

| 命令 | 作用 |
| --- | --- |
| `feima` | 交互模式；运行中键入的内容会作为**插话**进入下一轮，不另起任务 |
| `feima run "任务"` | 单次执行，结束即退出 |
| `feima run "任务" --json` | 事件按 JSONL 输出，便于脚本或 CI 消费 |
| `feima rpc` | 常驻进程，stdin/stdout 收发 JSON 行，供桌面端驱动 |
| `feima doctor` | 体检：配置、策略、沙盒握手、隔离能力 |
| `feima init` | 生成 `~/.feima/config.json` 模板 |

交互模式里的斜杠命令：`/help` `/state` `/stop` `/reset` `/config` `/exit`。

## 内置工具

| 工具 | 说明 | 约束 |
| --- | --- | --- |
| `read_file` | 带行号读文件，支持分段 | 只能读工作区内、且不在 denyRead 列表 |
| `write_file` | 写入或覆盖 | 只能写工作区内、且不在 denyWrite 列表 |
| `edit_file` | 精确替换，要求唯一匹配 | 同上 |
| `list_dir` | 列目录 | 只读 |
| `glob` | 通配符找文件 | 只读 |
| `grep` | 正则搜内容 | 只读 |
| `bash` | 执行命令（Windows 走 PowerShell） | 命令策略过滤 + 执行层超时杀进程 |

## 安全模型

v0.1 实现的是**策略层**隔离，进程级隔离（沙盒/容器）留了后端接口，尚未安装。

| 机制 | 做了什么 |
| --- | --- |
| 路径围栏 | 所有路径先 `realpath` 再判断，防 `../` 与符号链接绕过 |
| 写入黑名单 | `.git/hooks`、`.git/config`、`node_modules`、`.agents`、`.codex` |
| 环境变量白名单 | 子进程只拿到 16 类变量，API Key 一律不传 |
| 命令策略 | 拦 `rm -rf /`、强推、`curl \| sh` 等破坏性指令 |
| 失败即阻断 | 握手不通过就拒绝执行，不静默降级 |
| 错误脱敏 | `sk-…`、`Bearer …`、`ghp_…` 在展示/落日志前统一抹掉 |
| 超时与进程组 | 命令超时按进程树杀掉，不留孤儿 |

`--sandbox strict` 表示"没有真实隔离就不许执行命令"，需要接入隔离后端才可用；`policy`（默认）表示策略检查生效、但进程本身没有沙箱。

## 架构

```
CLI / RPC / (未来的 GUI)
        ↕ 事件流（text_delta / tool_start / tool_end / turn_end / agent_settled）
   AgentLoop  ── 内层：模型→工具→模型；外层：追加任务
        ├── Provider（OpenAI 兼容，SSE 自己切 \n）
        ├── Tools（7 个内置）
        └── Sandbox（策略 + 执行器，预留隔离后端）
```

细节见 `docs/01-架构.md`。

## 目录

```
bin/feima.mjs        入口（加载 TS，无构建）
src/
  cli.ts             命令行
  config.ts          配置装载
  prompt.ts          系统提示词
  types.ts           公共类型
  core/loop.ts       双循环与状态机
  providers/openai.ts  SSE 流式与工具调用拼装
  tools/builtin.ts   7 个内置工具
  safety/policy.ts   路径与环境变量策略、脱敏
  safety/exec.ts     执行器、握手、命令过滤
  rpc/host.ts        JSONL 协议宿主
tests/               node:test，18 个用例
docs/                立项书、架构、路线图
```

## 开发

```bash
npm test          # 18 个用例
npm run doctor
npm run typecheck # 需要 typescript（可选，开发期依赖）
```

## 路线

v0.1（当前）：核心循环、工具、策略层安全、CLI、RPC。
v0.2：真实隔离后端、上下文压缩、会话持久化、飞链 RAG 接入。
v0.3：Electron 桌面端，复用 `feima rpc`，不重写引擎。

详见 `docs/02-路线图.md`。
