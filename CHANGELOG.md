# CHANGELOG

## v0.5.0 — 2026-11-08

从「能干活」到「在会出事的地方停一下」。这一版没有新增能力，全在加约束：重试不能带副作用，
写文件和执行命令可以要求人工确认，命令可以收进白名单，工具可以按权限档关掉。

顺带发现了一件更要紧的事：**`npm run typecheck` 从 v0.1 起就是空转的**（见「修复」第一条）。

### 新增

- **重试策略**（`src/core/retry.ts`）：429/5xx/连接失败按指数退避重试，默认最多 3 次尝试，带 30% 抖动。唯一的硬约束是「本次尝试没产出任何东西才允许重试」——一旦流里吐过正文或半截工具参数，立刻放弃，因为重试会把同一段话发两遍，或者把只执行了一半的命令再执行一次。重试时发 `retry` 事件，界面能显示「正在重试」而不是干等。
- **确认闸门扩展到写文件与执行命令**（`src/safety/confirm.ts`）：`--confirm off|write|exec|external|all`。内置工具带上 `effects` 标签（read / write / exec），loop 在参数解析之后、工具执行之前问人。`write` 与 `exec` 是包含关系：能执行命令就能写文件，所以 `exec` 把写文件一起管住，反过来只开 `write` 挡不住 `bash` 写文件——这一点在帮助文本里明说，不做成「看起来更全」的假象。
- **无确认通道时默认拒绝**：`feima run` 与 `feima rpc` 没有 stdin 可问，要求的确认一律按拒绝处理，消息里告诉模型「加 `--yes` 才能放行」并叫它不要重试。`--yes` 生效时发一次 `notice`，之后不再问。
- **命令白名单**（`src/safety/allowlist.ts`）：`--cmd-allow "git status,git diff"`，只放行写过的命令前缀。自己按 shell 语法切段（尊重引号与转义），逐段取 argv 头部匹配——`git status; rm -rf ~` 这种整串看开头是 git 的写法会被切开，后半段单独过白名单。命令替换（`$( )`、反引号、`${ }`）与重定向一律拒。接在 `exec` 而不是工具层：任何执行路径都从这里过。
- **权限分级**（`--perms read|write|exec`）：累进三档。`read` 只注册只读工具，`write` 加写文件，`exec` 加 `bash`。不注册而不是「注册了再拒绝」——一个必然失败的工具留在 schema 里，模型会反复试，几轮就把上下文烧光。
- **多模型别名**（`src/core/models.ts`）：`models` 配置里写 `{ "便宜": { "model": "qwen-turbo" } }`，`--model 便宜` 即解析成对应模型与线路。别名可带自己的 `baseUrl` / `apiKey`，不写则回落到主配置。
- **按任务选模**：`--compact-model` / `FEIMA_COMPACT_MODEL` 让上下文折叠走便宜线路。这是最实在的一处「按任务选模型」：折叠是纯体力活，用主模型额度做不划算。
- **离线冒烟脚本**（`scripts/smoke.mjs`）：`npm run smoke`，约 3 秒。用脚本化假 provider 驱动**真实的**工具、沙盒、压缩、会话落盘，跑六个场景（写文件+执行 / 确认拒绝 / 白名单 / 压缩 / 重试 / 会话重载）。它守的是「组装起来还能不能用」。
- `doctor` 新增四块：确认策略、权限档、命令白名单（含规则写错时的告警）、重试与压缩模型。

### 修复

- **`npm run typecheck` 从 v0.1 起就是空转的**：仓库没有 `typescript` 依赖，`npx tsc --noEmit` 只会打印一句「This is not the tsc command you are looking for」并以 0 退出。于是 v0.1～v0.4 里每一句「类型检查通过」都是假的。补上 `typescript` + `@types/node` 后第一次真跑就报出 20 个错误，其中三个是真的 bug：
  - `config.ts` 里 `from "../safety/exec.ts"` 路径多了一层（类型导入会被 Node 的类型擦除删掉，所以运行时一直没炸）
  - `Sandbox.verify()` 在「没有后端」的分支里少返回 `listWorkspace`，与 `SelfTestReport` 不一致
  - `shellFor()` 的返回类型没带 `env`，`planned.env` 在类型上是 `never`
- **Windows 上短路径会把相对路径算成 `..\..\..`**：`%TEMP%` 常是 8.3 短名（`ADMINI~1`），`realpathLoose` 返回长名，两边直接 `path.relative` 会得到一串 `..\..\..\Administrator\...`。模型看到的是这种没有意义的东西，还以为写到了工作区外。基准改用 `realpathLoose(policy.workspace)`。这是冒烟脚本抓到的，单元用例抓不到——它们不跑真的临时目录。
- **`splitCommands` 不认双引号里的 `\"`**：`echo "他说 \"你好; 再见\""` 会被从中间切开，多出一段不存在的命令。虽然切开的结果是被拒（fail-closed），但拒绝理由会指错地方。双引号内的反斜杠按 POSIX 处理转义，单引号内保持字面量。
- **MCP 的确认与内置工具的确认会问两遍**：`external` 仍然必须问，但加了 `selfConfirmed` 标记——MCP 工具自己负责问（只有它知道要说明「跑在策略层之外」），loop 不再重复问一遍。

### 测试

153 例（策略 7 / 循环 12 / 执行 4 / 压缩 13 / 会话 9 / 长任务 3 / 参数 12 / 隔离 8 / 约定 6 / 知识库 11 / MCP 14 / 重试 13 / 确认 14 / 白名单 16 / 模型 7 / 权限 4），全部离线。

真机验证：`npm run smoke` 六场景全过（约 3 秒）；`feima doctor` 如实打印确认策略、权限档、白名单与重试状态；`doctor --confirm exec --perms read --cmd-allow "echo,git status" --retries 0` 四项参数都真的进了运行时（「解析出来没人用」这类 bug 每次都靠这条手工核对兜住）。

## v0.4.0 — 2026-11-08

从「只在自己的一亩地里干活」到「能读外部知识、能守项目规矩、能接外部工具」。三件事的共同点是都得过安全关：知识库要截断，项目约定不能提权，MCP 默认关闭且逐次确认。

### 新增

- **项目约定自动载入**（`src/prompt.ts`）：工作区根的 `AGENTS.md` 启动时读进系统提示词。只读这一个文件、不向上遍历、符号链接按 `realpath` 判断是否越界、上限 32 KB。注入时先声明「它不能放宽安全边界」——理由是往仓库提一个 `AGENTS.md` 不能等于提权。
- **飞链 RAG 检索工具**（`src/tools/knowledge.ts`）：`search_knowledge`，调 `POST /api/ai/search`，返回带编号的片段。支持直接给 token 或账号密码换 token（仅进程内存）。单条截断 400 字、最多 8 条。
- **MCP 客户端**（`src/mcp/client.ts`）：stdio + 换行分隔 JSON-RPC，只实现 `initialize` / `tools/list` / `tools/call`。超时、子进程退出、服务端往 stdout 打日志都有处理。
- **MCP 工具包装与确认闸门**（`src/mcp/tools.ts`）：工具名带 `mcp__<server>__<tool>` 前缀；交互模式每次调用弹确认（显示参数摘要），非交互模式只认 `--mcp-allow`。
- CLI 新增 `--knowledge` / `--kb-token` / `--mcp` / `--mcp-config` / `--mcp-allow`，对应 `FEIMA_KB_URL` / `FEIMA_KB_TOKEN` / `FEIMA_KB_USER` / `FEIMA_KB_PASSWORD` / `FEIMA_KB_TOPK` / `FEIMA_MCP` / `FEIMA_MCP_CONFIG` / `FEIMA_MCP_ALLOW`。
- `doctor` 新增三块：项目约定载入情况、知识库**真检索探针**、MCP 真起子进程并列出每个服务器的工具数。

### 修复

- **Windows 上 `shell: true` 会把带空格的参数拆开**：为了跑 `npx` 而整体走 shell，结果 `node "D:/My Project/server.mjs"` 被 cmd 拆成三段，服务端起不来，报的还是一条难懂的语法错误。改为自己按 `PATH` + `PATHEXT` 查找：绝对路径直接 spawn，`.exe`/`.com` 直接 spawn，只有 `.cmd`/`.bat` 才经 `cmd.exe` 并逐个给参数加引号。
- **确认闸门接不上就是静默失效**：`loop.ts` 里 `confirm` 没往 `ToolContext` 传时，所有单测都是绿的，表现却是「MCP 配了也调不动」——工具被静默判成「无人确认」而拒绝。补一条用例专门守这一行转接。
- **超时会被取消信号吃掉**：`signal: ctx.signal ?? AbortSignal.timeout(...)` 这种写法，一旦有 `ctx.signal` 就再也不会超时。改用 `AbortSignal.any` 让两者都生效。
- **`doctor` 忽略命令行覆盖**：`feima doctor --mcp --mcp-config x` 会被静默忽略，用户看到「MCP 未启用」还以为参数写错了。`doctor` 现在接收同一份覆盖对象。这是「解析出来没人用」这一类 bug 的第三次复发（前两次是 `--sandbox`、`--workspace`），所以这回顺便在 `AGENTS.md` 里把它写成硬规则。

### 测试

95 例（策略 7 / 循环 12 / 执行 4 / 压缩 13 / 会话 9 / 长任务 3 / 参数 8 / 隔离 8 / 约定 6 / 知识库 11 / MCP 14），全部离线。

真机验证：知识库检索（`http://42.193.158.63`）返回真实片段；`@modelcontextprotocol/server-everything` 起得来、列出 13 个工具、`callTool` 四场景（放行 / 未放行 / 用户拒绝 / 用户同意）行为正确；本仓库 `AGENTS.md`（7.5 KB）注入系统提示词。


## v0.3.0 — 2026-11-08

`strict` 从"空壳"变成"真的能隔离"。三平台各给一个后端，可用性靠探针判定而不是靠"装没装"。

### 新增

- **隔离后端契约**（`src/safety/isolation.ts`）：`availability / prepare / plan / selfTest / dispose`。执行层只问一句"这条命令交给谁 spawn"，平台差异全在各自后端里。
- **`appcontainer` 后端**（Windows 原生）：按工作区路径哈希注册独立 profile，只把该 SID 授权到工作区，用该 SID 的令牌启动子进程。读不到 `%USERPROFILE%`，写不出去，不靠命令过滤。
- **`bwrap` 后端**（Linux）：mount namespace 白名单，只绑定明确列出的系统目录，工作区是唯一可写路径，`--unshare-all` 默认断网。
- **`docker` 后端**（Linux/macOS）：同路径挂载 + `--cap-drop ALL` + `no-new-privileges`，默认 `--network none`。
- **真实自检**：宿主家目录放诱饵 → 沙盒内读必须失败；工作区读、写、列目录必须成功。五项全过才算"隔离可用"。
- **`feima sandbox grant [dir]`**：给工作区的上级目录授权遍历（AppContainer 的硬要求，通常需管理员）。
- CLI 新增 `--sandbox` / `--isolation` / `--network` / `--docker-image`，对应 `FEIMA_ISOLATION` / `FEIMA_NETWORK` / `FEIMA_DOCKER_IMAGE`。
- `doctor` 逐项列出每个后端的探测结果与不可用原因，并跑一次真自检。

### 修复

- **`--sandbox` 文档里有、解析里没有**：写进 `usage()` 但从没进 `parseFlags`，`feima run --sandbox strict "…"` 会把参数当成任务文本的一部分。这是 v0.2.1 那类"解析出来没人用"的复发，这次是根本没解析。
- **环境变量名大小写**：基础环境里的 `Path` 与后端补的 `PATH` 并存时，spawn 会传出两个条目，系统取哪个看运气。
- **MSYS/Git Bash 启动时 PATH 不含 System32**：容器里连 `cmd.exe` 都找不到。

### 测试

64 例（策略 7 / 循环 12 / 执行 4 / 压缩 13 / 会话 9 / 长任务 3 / 参数 8 / 隔离 8），全部离线。


## v0.2.1 — 2026-11-08

补做 v0.2.0 验收清单的最后一项（长任务连续性），做的时候用例直接挂了：25 轮工具调用，压缩一次都没触发。不是「压得不够勤」，是「完全不压」。

### 修复

- **单轮长工具链永远不压缩**：切分点只按「从尾部数第 N 个 user 消息」算，而一轮任务里跑几十次工具时整条历史只有一条 user 消息，找不到切点就直接返回。上下文一路涨到上游上限，模型开始反复读同一个文件——不报错，只是变笨。
  改为双策略：有足够用户轮次时按轮次切（原行为），没有时从尾部按 `keepTokens` 保留（默认取预算一半），切点右移到非 `tool` 的边界，宁可多留一组工具结果也不切断配对。
- **摘要消息参与轮次计数**：摘要本身是 `role: "user"`，第二次压缩会把切点算到它前面，折叠区只剩一条摘要，触发「可折叠内容不足」，压缩永久停滞。现在按 `[上下文摘要` 前缀排除在计数外。
- **`--workspace` 解析出来却没人用**：`run` / `resume` / 交互模式都没有把 `--workspace` 和 `--model` 传给运行时，Agent 实际在**当前目录**干活。真机跑长任务时暴露：指定工作区里一个文件都没有，产物全落在仓库里。会话 `meta.workspace` 也跟着记错。现在三个入口都统一传参，会话元信息与运行时一致。
- **`--workspace` 缺值静默变成 undefined**：写在末尾等于没写。现在缺值直接报错。
- **空输出被截断却当成完成**：推理型模型（qwen3 这类）会把 `maxTokens` 全花在 reasoning 上，这一轮既没有正文也没有工具调用，`finish_reason` 是 `length`。旧逻辑只在「有工具调用」时检查截断，没有调用就直接 `return "done"`——Agent 一句话不说就收工，用户以为它干完了。
  现在：无调用且 `length` 时回灌一条提示让模型直接开工，最多两次；三次仍空则报错并提示调大 `maxTokens`。
- **折叠门槛按条数算，一次批量调用就压不动**：门槛是「折叠区至少 3 条」，但模型一次请求甩出 7 个 `write_file` 时，折叠区只有「一条 user + 一条 assistant(tool_calls)」，条数只有 1～2，体积却有上千 token。改为按体积判断（低于 240 tokens 才拒绝），并把切点下限从 3 放宽到 2。
- **尾部全加起来不到保留量时找不到切点**：原先循环从 `i >= 3` 往前累积，凑不够 `keepTokens` 就返回 -1。现在凑不够就把切点退到最早一条之后（只折长任务描述、保留整组工具调用）。

### 新增

- 配置项 `keepTokens` / `FEIMA_KEEP_TOKENS`，`doctor` 与 `--help` 同步显示。
- `src/cli/flags.ts`：参数解析独立出来（入口脚本 import 即执行，藏在里面无法测）。
- `tests/flags.test.ts`：5 例，覆盖缺值报错与 `--` 分隔。
- 支持 `--` 分隔符：`feima run -- "解释一下 --json 这个参数"`，任务文本里的 `--xxx` 不会被当参数。
- `tests/loop.test.ts` 新增 2 例：空输出截断后重试、连续三次截断报错。
- `tests/longrun.test.ts`：长任务连续性验证。
  - 25 轮工具调用跨多次压缩，逐次检查「system 唯一且在首位、摘要不超过一条、tool_call_id 全部配对」；
  - 落盘后重新加载，历史条数一致、能接着跑下一轮；
  - 超过 `maxTurns` 时报错收敛且状态位复位。
- `tests/compact.test.ts` 新增 5 例：单轮长工具链必须能压、折叠后配对完整、连续三次压缩只留一条摘要且旧摘要并入新摘要、一次批量调用（7 个 tool_calls）也能压、折叠区过小不调摘要模型。

### 测试

53 例（策略 7 / 循环 12 / 执行 4 / 压缩 13 / 会话 9 / 长任务 3 / 参数 5），全部离线运行。


## v0.2.0 — 2026-11-08

主题是「让长会话能持续用」：上下文不再顶到模型上限，中断后不用重来。范围刻意压窄，只做压缩与持久化。

### 新增

- **上下文压缩**：估算 token 超过 `contextBudget`（默认 22000）时，把中段历史折叠成一条摘要消息；最近 `keepRecentTurns`（默认 3）轮原样保留。
  - 系统提示永不折叠；切分点只落在 `user` 消息，`assistant(tool_calls)` 与 `tool` 结果永远成对；
  - 压缩后若未变小则放弃；摘要失败降级为规则摘要（只列诉求、工具、结论），不让整轮失败；
  - 新事件 `compact`，带 `before` / `after` / `folded`。
- **会话持久化**：`~/.feima/sessions/<时间戳>-<随机4位>.jsonl`，append-only，随消息流同步落盘。
  - `feima resume [id|last]` 恢复并继续；`feima sessions` 列表、`sessions rm <id>` 删除；
  - 恢复时系统提示用当前配置重新生成，不沿用旧会话里那条；
  - `--no-save` / `FEIMA_NO_SAVE=1` 关闭。
- `AgentLoop.restore()` / `compactNow()` / `onRecord` 钩子；`getSnapshot()` 增加 `contextTokens` 与 `compactions`。
- 斜杠命令：`/context` `/compact` `/new` `/resume` `/sessions`。
- 配置项：`contextBudget`、`keepRecentTurns`、`saveSession`，对应 `FEIMA_CONTEXT_BUDGET` / `FEIMA_KEEP_TURNS` / `FEIMA_NO_SAVE`。
- `doctor` 报告会话目录数量、上下文预算与会话保存状态。

### 修复

- **崩溃后新记录也读不到**：残行没有结尾换行，append 把新记录粘在残行后，两条一起成为坏行。改为 append 前检查末字节，不是换行先补一个。
- **会话列表永远显示「未命名会话」**：标题只更新了内存 meta，文件首行没改。改为标题确定后重写首行。
- **列表时间早 8 小时**：`toISOString()` 是 UTC 却被直接截断显示。改为显示层转本地时间，文件内仍存 UTC 以便排序。
- **RPC 宿主没有压缩**：只在 CLI 挂压缩会导致同一段历史在桌面端表现为另一套行为。RPC 构造处补齐同样的策略。

### 变更

- 事件类型从 9 种增加到 10 种（新增 `compact`），其余不变。
- `LoopOptions` 增加可选的 `compaction` 与 `onRecord`，不传则行为与 v0.1 一致。
- 所有消息写入收敛到 `AgentLoop.push()`，避免出现「历史里有、会话文件里没有」的偏差。

### 已知限制

- 进程级隔离仍未实现，`policy` 模式下命令有真实系统权限，`strict` 模式因无后端拒绝执行。
- 压缩只在每轮请求前检查，单轮内超长工具链不会中途压缩。
- 会话无索引，`sessions` 扫目录读首行，数百个以内无感。
- 摘要质量依赖模型；弱模型可能漏掉路径，靠保留轮次兜底。

### 测试

38 例（策略 7 / 循环 10 / 执行 4 / 压缩 8 / 会话 9），全部离线运行。

## v0.1.0 — 2026-11-08

首个可运行版本。立项与实现同一天完成。

### 新增

- `AgentLoop` 双循环：内层推进工具调用链并消化插话，外层处理追加任务。
- 状态机以 `snapshot.isStreaming` 为唯一权威；`agent_settled` 只在状态落回 idle 后发出，UI 不会出现"答完了又跳起来"。
- 并发约定：运行中再次提交自动降级为插话，不并发跑两轮。置位发生在第一个 `await` 之前。
- 工具：`read_file`、`write_file`、`edit_file`、`list_dir`、`glob`、`grep`、`bash`。
- 安全五层：路径围栏、读写黑名单、环境变量白名单、命令策略、启动握手。错误信息统一脱敏。
- 三种接入：交互式 CLI、`run --json` 事件流、`feima rpc` JSONL 协议。
- `feima doctor`：报告配置、策略项数、握手 token、隔离能力。
- 测试 18 例：策略 7、循环 7、执行 4。

### 变更

- `finish_reason === "length"` 时不执行工具调用，回灌说明让模型缩短参数重发。原先直接执行会拿到被截断的命令片段，属于"看起来执行了其实没执行"的隐蔽错误。

### 修复

- 模型层向 provider 传递消息数组时改为传副本。原因是测试中发现：provider 持有原数组引用后，宿主后续追加的消息会"倒映"进已发出的请求，导致对请求快照的断言失真；在真实场景里也可能被上游实现顺手改写历史。
- `node --test tests/` 在 Windows 下被当成模块路径解析而报 `MODULE_NOT_FOUND`，脚本改为显式通配 `tests/*.test.ts`。

### 已知限制

- 进程级隔离未实现。`policy` 模式下命令仍有真实系统权限（入口被策略过滤），`strict` 模式下因无后端会拒绝执行命令。
- 无上下文压缩，长会话会顶到模型上限。
- 无会话持久化，退出即丢历史。
