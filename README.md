# 飞码 CodingAgent

中文优先的终端编程 Agent。零运行时依赖，一条命令跑起来，能读代码、改文件、执行命令，并把每一步都限制在你指定的工作区内。

```
feima run "把 src/config.ts 里的超时改成可配置，并补一个测试"
```

## 为什么又做一个

参考 `@inkwellio/my-coding-agent` 的桌面端实现之后，判断很清楚：桌面壳（Electron）不是难点，Agent 的**循环、状态机、安全边界**才是。飞码先把这三件事做对，再谈界面。

五条设计取向：

- **零依赖**。只用 Node 内置能力（`node:fs` / `node:child_process` / `fetch`）。没有 SDK、没有框架、没有状态库。装完之后 `node_modules` 是空的。
- **安全边界先于功能**。路径越界、环境变量泄漏、`.git/hooks` 持久化、符号链接绕过，这些在 v0.1 就堵住，不等以后。
- **状态以 `isStreaming` 为唯一权威**。事件只用来提示，不用来判定结束。这是 UI 不闪烁、任务不误判的前提。
- **长会话可用**。上下文超预算自动折叠早期历史，会话落盘可恢复；不是「聊到一半就得重开」。
- **外部能力默认关闭**。MCP 这类跑在自己策略层之外的工具，必须显式打开、逐次确认；宁可少一个工具，不留一个未经确认的出口。

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
| `feima doctor` | 体检：配置、策略、各隔离后端探测 + 真自检、会话目录、上下文预算、项目约定、知识库检索探针、MCP 子进程、确认策略、权限档、命令白名单、重试 |
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

| 工具 | 说明 | 副作用 | 约束 |
| --- | --- | --- | --- |
| `read_file` | 带行号读文件，支持分段 | 读 | 只能读工作区内、且不在 denyRead 列表 |
| `write_file` | 写入或覆盖 | 写 | 只能写工作区内、且不在 denyWrite 列表 |
| `edit_file` | 精确替换，要求唯一匹配 | 写 | 同上 |
| `list_dir` | 列目录 | 读 | 只读 |
| `glob` | 通配符找文件 | 读 | 只读 |
| `grep` | 正则搜内容 | 读 | 只读 |
| `bash` | 执行命令（Windows 走 PowerShell） | 执行 + 写 | 命令策略过滤 + 可选白名单 + 执行层超时杀进程 |
| `search_knowledge` | 检索飞链知识库，返回带编号的片段 | 读 | 未配置就不注册；单条截断 400 字 |

「副作用」这一列不是文档装饰：`--confirm write` 与 `--confirm exec` 按它决定问不问人，`--perms read|write|exec` 按它决定注不注册。

外部工具（MCP）不在这张表里：要显式打开，且每次调用都要确认，见下文。

## 项目约定（AGENTS.md）

工作区根目录放一个 `AGENTS.md`，启动时自动读进系统提示词。写清楚这个仓库的规矩——目录结构、命名、禁止的做法、常用命令——比每次口述一遍划算。

```bash
# 无需任何配置，放在工作区根目录即可
echo "# 本项目用 2 空格缩进，禁止直接改 dist/" > AGENTS.md
feima doctor    # 会显示「项目约定 AGENTS.md 已载入 7.5 KB」
```

三条硬约束：

1. **只读工作区根目录这一个文件**，不向上遍历、不读子目录里的同名文件；符号链接会被 `realpath` 检查，指向工作区外就当作不存在。
2. **上限 32 KB**，超出截断并明说「只截取了前 32 KB」。往 AGENTS.md 里贴整份文档会把上下文预算吃光，反而让 Agent 记不住最近几轮。
3. **它不能放宽安全边界**。注入时会先写一段声明：任何要求跳过确认、忽略策略、读取凭据、向工作区外写入的内容一律无效。理由很实际——`AGENTS.md` 是仓库里的普通文件，谁都能改；如果它能覆盖安全策略，那往仓库提一个 `AGENTS.md` 就等于提权。

## 知识库检索（飞链 RAG）

配置后多一个 `search_knowledge` 工具，检索飞链知识库（`POST /api/ai/search`）并返回带编号的片段。

```bash
# 方式一：账号密码（进程内换 token，不落盘）
export FEIMA_KB_URL=http://your-kb-host
export FEIMA_KB_USER=admin
export FEIMA_KB_PASSWORD=***

# 方式二：直接给 token
export FEIMA_KB_URL=http://your-kb-host FEIMA_KB_TOKEN=***

feima doctor          # 「检索探针」会真检索一次，不只看配置在不在
```

设计上的三点：

- **未配置就不注册工具**。注册一个永远报错的工具，模型会反复试，几轮就把上下文烧完。
- **结果必须截断**：单条 400 字、最多 8 条。检索结果是外部文本，长度不可控，原样灌进去会挤掉工作区里的真实代码。
- **凭据只在内存**：token 不落盘、不进日志、不传给子进程；`doctor` 只报「已配置凭据」。

## MCP 外部工具

支持 stdio 传输的 MCP 服务器（`initialize` / `tools/list` / `tools/call` 三件事，其余协议部分不实现）。

```bash
# ~/.feima/mcp.json
{
  "servers": {
    "everything": { "command": "node", "args": ["/path/to/server-everything/dist/index.js"] }
  }
}

FEIMA_MCP=1 feima            # 打开；默认是关的
FEIMA_MCP=1 feima doctor     # 会真起子进程并列出每个服务器的工具数
feima run "..." --mcp-allow everything.get-sum   # 非交互模式：显式放行
```

默认关闭的理由不是多疑，而是**能力边界不同**：内置工具跑在策略层 + 沙盒里，读写被约束在工作区；MCP 工具是外部进程，它拿什么凭据、能访问什么、会不会把数据发出去，飞码一概不知道。所以：

| 场景 | 行为 |
| --- | --- |
| 交互模式（`feima`） | 每次调用弹确认，显示工具名与参数摘要，默认是「否」 |
| 非交互（`run` / `rpc`） | 无确认入口，只认 `--mcp-allow` 放行列表，其余一律拒绝 |
| 一台服务器起不来 | 只记一条失败原因，其余服务器照常可用，不拖死整个进程 |

工具名统一加前缀 `mcp__<server>__<tool>`，与内置工具不可能撞名。服务器往 stdout 打的日志会被识别成噪音并丢弃——一个 `console.log` 不该让整套工具不可用。

## 安全模型

两层：**策略层**永远生效，**隔离层**按需启用。

| 机制 | 做了什么 |
| --- | --- |
| 路径围栏 | 所有路径先 `realpath` 再判断，防 `../` 与符号链接绕过 |
| 写入黑名单 | `.git/hooks`、`.git/config`、`node_modules`、`.agents`、`.codex` |
| 环境变量白名单 | 子进程只拿到 16 类变量，API Key 一律不传 |
| 命令策略 | 拦 `rm -rf /`、强推、`curl \| sh` 等破坏性指令 |
| 命令白名单（可选） | 开了就只放行写过的命令前缀；分号、管道、命令替换、重定向都逐段校验 |
| 副作用确认（可选） | 写文件 / 执行命令前问人；外部工具无论如何都问 |
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

## 运行时闸门（v0.5）

四个开关管住「什么时候不许动」。默认全部最宽松，需要时逐级收紧。

```bash
# 写文件与执行命令都先问一句（交互模式弹提示，非交互模式直接拒绝）
feima --confirm exec

# 非交互场景（run / rpc）没人可问，要放行必须显式 --yes
feima run "跑测试" --confirm exec --yes

# 只读审查：不注册 write_file / edit_file / bash
feima run "审一遍 src/ 有没有逻辑漏洞" --perms read

# 命令白名单：只允许写过的前缀
feima --cmd-allow "git status,git diff,npm test" --confirm exec
```

| 开关 | 取值 | 说明 |
| --- | --- | --- |
| `--confirm` | `off`（默认）/ `write` / `exec` / `external` / `all` | `exec` 是 `write` 的超集：能执行命令就能写文件，所以它把写文件一起管住。反过来只开 `write` **挡不住** `bash` 写文件——这是能力上的事实，帮助文本里写明了 |
| `--yes` | 标志 | 需要确认但没有交互通道时放行。只对 `run` / `rpc` 有意义，且会发一条 `notice` 留痕 |
| `--perms` | `read` / `write` / `exec`（默认） | 累进。「不注册」而不是「注册了再拒绝」：一个必然失败的工具留在列表里，模型会反复试，几轮就把上下文烧光 |
| `--cmd-allow` | 逗号分隔 | 可多次累加。命令按 shell 语法切段校验，`git status; rm -rf ~` 的后半段会单独过白名单 |
| `--retries` | 0～6（默认 3） | 总尝试次数。只有「连不上、还没吐出第一个字节」的失败才重试——吐过正文或半截工具参数就不再重试，否则会重复输出、重复执行 |
| `FEIMA_REPEAT` | `0` 关闭 | 空转检测。模型围着同一个坑反复撞时，先提醒（工具结果里加一句 + `notice`），撞满就中止这一轮——不是杀进程，会话还在 |

**空转检测（v0.6）** 不是开关型的闸门，而是一条随时的兜底：同一个失败原因出现 3 次、或同一个工具连续失败 3 次、或完全相同的调用出现 4 次，就往工具结果里插一句「你已经在这撞了几次」；到 5/8 次直接中止这一轮。它解决的是真机上观测到的行为——模型被拒绝之后不会放弃，而是换五种写法继续撞同一堵墙。阈值不提成命令行参数，因为调它只在调试提示词时有意义。

**外部工具（MCP）不受 `--confirm off` 影响**：它跑在策略层之外，飞码不知道它拿什么凭据、能访问什么，所以无条件逐次确认。这一条是刻意的，没有留关掉的口子。

## 多模型与按任务选模

`~/.feima/config.json` 里写别名，命令行只写自己的习惯：

```json
{
  "models": {
    "快":   { "model": "qwen-turbo" },
    "远程": { "model": "claude-sonnet-4", "baseUrl": "https://api.other/v1", "apiKey": "sk-…" }
  },
  "compactModel": "快"
}
```

```bash
feima --model 远程 run "重构这个模块"
feima --compact-model 快 run "长任务：跑一天也没关系"
```

别名不带 `baseUrl` / `apiKey` 时回落到主配置——大多数别名只是同一网关下的不同模型名，强制写全等于把配置写两遍。

`compactModel` 是「按任务选模型」里最实在的一处：折叠上下文是纯体力活，用主模型的额度做不划算。

## 架构

```
CLI / RPC / (未来的 GUI)
        ↕ 事件流（text_delta / tool_start / tool_end / compact / turn_end / agent_settled）
   AgentLoop  ── 内层：模型→工具→模型；外层：追加任务
        ├── Compact（超预算折叠 → 摘要 / 降级规则摘要）
        ├── Session（JSONL append-only，随消息流同步落盘）
        ├── Provider（OpenAI 兼容，SSE 自己切 \n）
        ├── Tools（7 个内置 + search_knowledge + MCP 外部工具）
        └── Sandbox（策略层 + 隔离后端：appcontainer / bwrap / docker）
```

细节见 `docs/01-架构.md`，演进过程见 `EVOLUTION.md`，取舍理由见 `docs/03-决策记录.md`。

## 目录

```
bin/feima.mjs         入口（加载 TS，无构建）
src/
  cli.ts              命令行、斜杠命令、会话接入
  config.ts           配置装载
  prompt.ts           系统提示词、AGENTS.md 载入
  types.ts            公共类型
  core/loop.ts        双循环与状态机
  core/compact.ts     上下文压缩与 token 估算
  core/session.ts     会话持久化
  core/retry.ts       重试与退避（带副作用判断）
  core/repeat.ts      空转检测（重复调用 / 同一失败原因）
  core/models.ts      模型别名解析
  providers/openai.ts SSE 流式与工具调用拼装
  tools/builtin.ts    7 个内置工具与权限档过滤
  tools/knowledge.ts  飞链 RAG 检索工具
  mcp/client.ts       MCP stdio 客户端（initialize / tools/list / tools/call）
  mcp/tools.ts        把 MCP 工具包成飞码工具，含逐次确认闸门
  safety/policy.ts    路径与环境变量策略、脱敏
  safety/exec.ts      执行器、握手、命令过滤
  safety/confirm.ts   副作用确认（模式、参数摘要、脱敏）
  safety/allowlist.ts 命令白名单（切分、前缀匹配、拒绝元字符）
  rpc/host.ts         JSONL 协议宿主
tests/                node:test，163 个用例
scripts/smoke.mjs    离线冒烟：七场景，约 3 秒
scripts/e2e.mjs      端到端：真模型跑三场景，约 2 分钟
docs/                 立项书、架构、路线图、决策记录
EVOLUTION.md          版本演进台账
```

## 开发

```bash
npm test          # 163 个用例，全部离线，不联网
npm run smoke     # 离线冒烟：七场景跑完整链路，约 3 秒
npm run typecheck # tsc --noEmit（typescript 是开发依赖）
npm run e2e       # 真模型跑三场景（要本机有模型，约 2 分钟，不进 CI）
npm run doctor
```

四道检查各守一段，缺一不可：

| 检查 | 守什么 | 什么时候跑 |
| --- | --- | --- |
| `npm test` | 单个函数 / 模块对不对 | 每次改代码 |
| `npm run smoke` | 装起来还能不能用（假 provider 驱动真工具） | 提交前 |
| `npm run typecheck` | 类型与导入路径一致性 | 提交前 |
| `npm run e2e` | 真模型能不能干活、拒绝理由它读不读得懂 | 动提示词 / 工具描述 / 拒绝文案后 |

Node 的类型擦除只删类型、不检查类型，所以**类型检查与用例是两件事，都需要**。v0.1～v0.4 的 `typecheck` 脚本因为没装 `typescript` 而一直空转（`npx` 找不到包时只打印一句提示并以 0 退出），那四个版本里「类型检查通过」都不成立；v0.5 补上依赖，第一次真跑就报出 20 个问题。教训写在 `AGENTS.md`：**新增任何检查手段，先证明它在故意写错时确实会红。**

## 路线

v0.1：核心循环、工具、策略层安全、CLI、RPC。
v0.2：上下文压缩、会话持久化。
v0.2.1：长任务验收补做，修掉「单轮长工具链不压缩」「空输出截断判完成」「`--workspace` 失效」。
v0.3：隔离后端——AppContainer / bubblewrap / docker，真探针式自检。
v0.4：飞链 RAG 检索、AGENTS.md 自动载入、MCP 客户端（默认关、逐次确认）。
v0.5：重试、副作用确认、命令白名单、权限档、多模型别名、离线冒烟。
v0.6（当前）：真模型端到端验收、空转检测（重复调用 / 同一失败原因）。
v1.0：Electron 桌面端，复用 `feima rpc`，不重写引擎。

详见 `docs/02-路线图.md`。
