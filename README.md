# 飞码 CodingAgent

中文优先的终端编程 Agent。零运行时依赖，一条命令跑起来，能读代码、改文件、执行命令，并把每一步都限制在你指定的工作区内。

```
feima run "把 src/config.ts 里的超时改成可配置，并补一个测试"
```

## 为什么又做一个

参考 `@inkwellio/my-coding-agent` 的桌面端实现之后，判断很清楚：桌面壳（Electron）不是难点，Agent 的**循环、状态机、安全边界**才是。飞码先把这三件事做对，再谈界面。

四条设计取向：

- **零依赖**。只用 Node 内置能力（`node:fs` / `node:child_process` / `fetch`）。没有 SDK、没有框架、没有状态库。装完之后 `node_modules` 是空的。
- **安全边界先于功能**。路径越界、环境变量泄漏、`.git/hooks` 持久化、符号链接绕过，这些在 v0.1 就堵住，不等以后。
- **状态以 `isStreaming` 为唯一权威**。事件只用来提示，不用来判定结束。这是 UI 不闪烁、任务不误判的前提。
- **长会话可用**。上下文超预算自动折叠早期历史，会话落盘可恢复；不是「聊到一半就得重开」。

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
feima                                   # 交互模式（自动开会话）
feima run "读一下 README，列出待办"       # 单次执行
feima run "跑测试并修失败用例" --json     # 事件流，给脚本用
feima sessions                          # 看历史会话
feima resume last                       # 接着上次继续
feima rpc                               # JSONL 协议，给 GUI 用
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
| `feima resume [id\|last]` | 恢复会话，把历史带回来继续 |
| `feima sessions` | 列出会话（`--json` 可解析，`rm <id>` 删除） |
| `feima rpc` | 常驻进程，stdin/stdout 收发 JSON 行，供桌面端驱动 |
| `feima doctor` | 体检：配置、策略、各隔离后端探测 + 真自检、会话目录、上下文预算 |
| `feima init` | 生成 `~/.feima/config.json` 模板 |

交互模式里的斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/state` | 运行状态 + 上下文占用 |
| `/context` | 只看 token 占用与已折叠次数 |
| `/compact` | 立即折叠早期历史（不等超预算） |
| `/stop` | 中止当前任务 |
| `/reset` | 清空上下文（会话文件保留，追加一条 reset 记录） |
| `/new` | 开新会话 |
| `/resume [id]` | 当场切到某个会话 |
| `/sessions` | 列出会话 |
| `/config` | 显示配置（Key 打码） |

## 上下文压缩

会话变长时，早期消息会被折叠成一条摘要，而不是简单丢弃。

触发：估算 token 超过 `contextBudget`（默认 22000，对应 32k 上下文留 8k 输出）。

规则：

1. 系统提示永不折叠；
2. 切分点不会落在 `tool` 消息上，`assistant(tool_calls)` 与 `tool` 结果永远成对保留；
3. 最近 `keepRecentTurns`（默认 3）轮原样保留；
4. 一轮任务里跑了几十次工具、没有足够用户轮次时，改按 `keepTokens`（默认取预算一半）保留尾部；
5. 压缩后如果没有变小，就放弃这次压缩；
6. 摘要失败时降级为规则摘要（只列诉求、工具、结论），不会让整轮失败。

```
[上下文折叠] 8 条消息 → 摘要，5.6k → 1.2k tokens
```

可调：`FEIMA_CONTEXT_BUDGET=16000`、`FEIMA_KEEP_TURNS=2`、`FEIMA_KEEP_TOKENS=6000`。

## 会话持久化

会话写在 `~/.feima/sessions/<时间戳>-<随机4位>.jsonl`，一行一条记录，append-only。

```
{"t":"meta","meta":{"v":1,"id":"20261108-104117-yz8z","title":"只回答：飞码版本号是多少…",...}}
{"t":"msg","m":{"role":"user","content":"..."}}
{"t":"msg","m":{"role":"assistant","content":null,"tool_calls":[...]}}
{"t":"compact","before":5612,"after":1180,"folded":8}
```

- **崩溃安全**：进程被 kill 最多丢最后半行，前面的历史还能读；读取时坏行跳过并计数。
- **不污染仓库**：不放工作区，避免把业务信息提交上去。
- **恢复时系统提示重建**：用当前配置生成，不沿用旧会话里那条。
- 关掉：`--no-save` 或 `FEIMA_NO_SAVE=1`。

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

两层：**策略层**永远生效，**隔离层**按需启用。

| 机制 | 做了什么 |
| --- | --- |
| 路径围栏 | 所有路径先 `realpath` 再判断，防 `../` 与符号链接绕过 |
| 写入黑名单 | `.git/hooks`、`.git/config`、`node_modules`、`.agents`、`.codex` |
| 环境变量白名单 | 子进程只拿到 16 类变量，API Key 一律不传 |
| 命令策略 | 拦 `rm -rf /`、强推、`curl \| sh` 等破坏性指令 |
| 失败即阻断 | 自检不通过就拒绝执行，不静默降级 |
| 错误脱敏 | `sk-…`、`Bearer …`、`ghp_…` 在展示/落日志前统一抹掉 |
| 超时与进程组 | 命令超时按进程树杀掉，不留孤儿 |

### 隔离后端（v0.3）

`--sandbox strict` 的含义是「没有真隔离就不许执行命令」。真隔离由后端提供：

| 后端 | 平台 | 做法 | 前提 |
| --- | --- | --- | --- |
| `appcontainer` | Windows | 按工作区注册独立 AppContainer profile，用该 SID 的令牌启动子进程 | 无需 daemon；首次可能需 `feima sandbox grant` 授权上级目录 |
| `bwrap` | Linux | mount namespace 白名单，工作区唯一可写，`--unshare-all` 断网 | `apt install bubblewrap` |
| `docker` | Linux / macOS | 同路径挂载 + `--cap-drop ALL` + `--network none` | docker daemon |

```bash
FEIMA_SANDBOX=strict feima doctor          # 探测 + 真自检
FEIMA_SANDBOX=strict feima run "..."       # 自检不过就拒绝启动
feima sandbox grant                        # Windows：给上级目录授权（通常需管理员）
```

默认网络关闭（`FEIMA_NETWORK=1` 或 `--network` 才放行）。命令输出在 `files` 模式下走工作区里的 `.feima-tmp/`，由后端决定，对工具层透明。

**自检是五件事，不是四件**：读工作区诱饵、读宿主家目录诱饵被拒、写工作区、写宿主家目录被拒、**列目录必须成功**。最后一项是踩出来的——前四项全绿、`dir` 全被拒，因为前四项用的是已建立的 cwd 句柄，绕过了路径解析。

## 架构

```
CLI / RPC / (未来的 GUI)
        ↕ 事件流（text_delta / tool_start / tool_end / compact / turn_end / agent_settled）
   AgentLoop  ── 内层：模型→工具→模型；外层：追加任务
        ├── Compact（超预算折叠 → 摘要 / 降级规则摘要）
        ├── Session（JSONL append-only，随消息流同步落盘）
        ├── Provider（OpenAI 兼容，SSE 自己切 \n）
        ├── Tools（7 个内置）
        └── Sandbox（策略层 + 隔离后端：appcontainer / bwrap / docker）
```

细节见 `docs/01-架构.md`，演进过程见 `EVOLUTION.md`，取舍理由见 `docs/03-决策记录.md`。

## 目录

```
bin/feima.mjs         入口（加载 TS，无构建）
src/
  cli.ts              命令行、斜杠命令、会话接入
  config.ts           配置装载
  prompt.ts           系统提示词
  types.ts            公共类型
  core/loop.ts        双循环与状态机
  core/compact.ts     上下文压缩与 token 估算
  core/session.ts     会话持久化
  providers/openai.ts SSE 流式与工具调用拼装
  tools/builtin.ts    7 个内置工具
  safety/policy.ts    路径与环境变量策略、脱敏
  safety/exec.ts      执行器、握手、命令过滤
  rpc/host.ts         JSONL 协议宿主
tests/                node:test，38 个用例
docs/                 立项书、架构、路线图、决策记录
EVOLUTION.md          版本演进台账
```

## 开发

```bash
npm test          # 38 个用例，全部离线，不联网
npm run doctor
npm run typecheck # 需要另装 typescript（可选，开发期依赖）
```

类型擦除只删类型不检查类型，所以**测试是唯一的守门人**，新增能力必须带用例。

## 路线

v0.1：核心循环、工具、策略层安全、CLI、RPC。
v0.2：上下文压缩、会话持久化。
v0.2.1：长任务验收补做，修掉「单轮长工具链不压缩」「空输出截断判完成」「`--workspace` 失效」。
v0.3（当前）：隔离后端——AppContainer / bubblewrap / docker，真探针式自检。
v0.4：重试策略、工具确认、多模型配置。
v1.0：Electron 桌面端，复用 `feima rpc`，不重写引擎。

详见 `docs/02-路线图.md`。
