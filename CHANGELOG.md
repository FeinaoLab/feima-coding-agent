# CHANGELOG

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
