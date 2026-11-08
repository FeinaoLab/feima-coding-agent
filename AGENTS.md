# AGENTS.md

给在这个仓库里工作的 Agent（包括飞码自己）的可执行规范。每条都能判定对错，没有"请注意保持整洁"。

## 项目结构

- `src/cli.ts`：命令行入口，只做命令分发与事件渲染，不写业务逻辑。
- `src/cli/flags.ts`：参数解析。独立成文件是为了能测——`cli.ts` import 即执行 `main()`，藏在里面的解析逻辑永远测不到。
- `src/core/`：循环、状态机、上下文压缩、会话持久化。
  - 改 `loop.ts` 必须同步改 `tests/loop.test.ts`；
  - 改 `compact.ts` 必须保证 `assistant(tool_calls)` 与 `tool` 结果不被拆开，用例在 `tests/compact.test.ts`；
  - 改 `session.ts` 必须覆盖"残行/坏行"两种损坏形态，用例在 `tests/session.test.ts`。
- `src/providers/`：模型接入。新增厂商用适配器，不许在循环里写 `if (model.startsWith(...))`。
- `src/tools/`：工具实现。新增工具必须：① 参数手动校验；② 路径走 policy；③ 输出有截断。
- `src/safety/`：策略与执行。这是安全边界，改动需要额外用例覆盖。
  - `isolation.ts` 是隔离后端的契约；`backends/` 下每个平台一个实现，不许在 `exec.ts` 里写 `if (platform === ...)` 的分支逻辑。
  - 改任一后端必须保证 `selfTest` 仍是五项（读/写/列 + 两条"必须被拒"），少一项就会出现"安全但干不了活"的假绿。
- `src/rpc/`：协议层。改协议必须同步更新 `docs/01-架构.md` 第九节。
- `tests/`：只放测试，不放脚本。

## 命令

```bash
npm test                  # node --test tests/*.test.ts，必须全绿
npm run doctor            # 体检，改配置相关代码后跑
node src/cli.ts --help    # 改 CLI 参数后确认输出
```

- 不要引入构建步骤。Node 22.6+ 的类型擦除是刻意选择，不是临时方案。
- 不要 `npm install` 加运行时依赖。`dependencies` 必须保持为 `{}`；开发期依赖需要先讨论。

## 代码风格

- 2 空格缩进，双引号，语句结尾带分号。
- `import` 必须写完整扩展名：`from "./types.ts"`。Node 擦除运行要求如此。
- 只用 `import type` 引入类型；`verbatimModuleSyntax` 已开启。
- 禁用 `enum` / `namespace` / 构造函数参数属性——类型擦除不支持。
- 注释写"为什么"，不写"做了什么"。反面例子：`// 遍历数组`。
- 错误信息用中文，且必须能指导下一步操作（"路径越界：xxx 不在工作区内"）。

## 测试规范

- 框架用 `node:test` + `node:assert/strict`，不引第三方。
- 涉及文件系统的一律 `fs.mkdtempSync(path.join(os.tmpdir(), "feima-test-"))`，不许在工作区里造文件。
- 涉及符号链接的用例要能在不支持的环境下 `t.skip`，不能直接失败。
- 新增安全策略 → 必须同时加"被拒绝"和"正常放行"两个断言。

## 会话与压缩约定

- 任何写消息的地方都必须走 `AgentLoop.push()`，禁止直接 `this.messages.push(...)`。
  绕过它会导致"历史里有、会话文件里没有"，恢复出来的会话是断的。
- 压缩切分点不能落在 `role === "tool"` 上。`assistant(tool_calls)` 与紧随的 `tool` 结果是原子对，切在中间上游直接 400。按轮次找不到切点时必须走 token 兜底，不允许直接放弃压缩（单轮长工具链会因此完全不压）。
- 摘要消息是 `role: "user"`，必须排除在"用户轮次"计数外（按 `[上下文摘要` 前缀识别）。否则二次压缩的切点会算到摘要前面，折叠区只剩一条摘要，压缩永久停滞。
- 系统提示永不进入摘要；恢复会话时用当前配置重新生成，不沿用文件里那条。
- 摘要生成失败必须降级为 `fallbackSummary()`，不允许把异常抛给用户，也不允许"压一半就返回"。
- 会话文件目录只由 `defaultSessionDir()` 决定，测试一律传临时目录，禁止写到真实 `~/.feima`。
- append 之前必须确保文件末尾有换行（`ensureTrailingNewline`）；新增写入路径时同样处理。

## 隔离后端约定

- 后端只回答一个问题：这条命令交给谁 spawn。`plan()` 返回 `{file, args}`，不要在 `exec.ts` 里拼平台参数。
- **可用性必须靠真跑，不能靠检测。** "找到了 bwrap 这个文件"和"bwrap 真能把进程关起来"是两件事，中间隔着内核开关、命名空间权限、ACL 授权。`availability()` 只回答"装没装"，`selfTest()` 才回答"能不能用"。
- `selfTest` 的否定项（读宿主被拒）必须在**沙盒能正常执行**的前提下才算数。`catch(() => true)` 会把"命令没跑起来"也算成"被拦住了"。
- 探针要验"能不能干活"，不只是"拦没拦住"：`dir`/`ls` 必须成功。少了这一项，能 `type` 不能 `dir` 的后端会被判通过。
- `strict` 模式下自检失败必须**拒绝启动**，不允许降级运行。降级只能由用户显式选择（`--sandbox policy`）。
- 后端 `plan()` 里补的环境变量不许含凭据。`SystemRoot` / `PATH` / `LOCALAPPDATA` 这类系统变量属于必要项（AppContainer 缺了直接 `failed: 203`）。
- 合并环境变量必须按大小写不敏感去重（`mergeEnv`）：Windows 里 `Path` 与 `PATH` 会被当成两个条目，取哪个看运气。
- AppContainer 的 `lpApplicationName` 必须传 `NULL`，让加载器按 PATH 搜；显式给 `C:\Windows\System32\cmd.exe` 会返回 `ERROR_FILE_NOT_FOUND`。
- `DeriveAppContainerSidFromAppContainerName` 对未注册的 profile 也会返回 SID。必须先 `CreateAppContainerProfile`，再在 `ERROR_ALREADY_EXISTS` 时派生。
- 后端留下的 ACL 必须能撤销（`dispose`）。加过的每一条都要记下来，退出时逐条删掉。
- Windows 启动器 `.ps1` 必须保持纯 ASCII。PowerShell 5.1 对无 BOM 文件按 ANSI 解码，一个中文注释就会让脚本解析失败，表现为"沙盒坏了"。

## CLI 参数约定

- 新增 `--xxx` 参数必须：① 在 `flags.ts` 加解析并补用例；② 在 `usage()` 里写清；③ 确认它真的被**传给运行时**。
- "解析出来但没人用"是本项目踩过的真实 bug：`--workspace` 解析正确，`run`/`resume` 却没传给 `buildRuntime`，Agent 在 cwd 里改文件，没有任何报错。参数缺值必须报错，不允许静默变成 `undefined`。

## 提交规范

格式：`类型: 简短描述`，类型取 `feat` / `fix` / `docs` / `test` / `chore`。

CHANGELOG 每条必须写清三件事：现象、根因、修法。不写"修复了一些问题"。

## 文档约定

- 改动影响外部行为时，三处同步：`CHANGELOG.md`（使用者视角）、`EVOLUTION.md`（版本演进与验证数据）、相关 `docs/`。
- 做出有取舍的决定时追加一条 `docs/03-决策记录.md`（ADR），写清选项、结论、代价；推翻旧决定不删旧条，追加新条并标注取代关系。
- 验证数据必须可复现：写清模型、参数、前后数值，不写"明显变快"。

## 安全提示

- 凭据只从环境变量或 `~/.feima/config.json` 读，绝不写进代码、测试、示例。
- 测工具或 RPC 时把工作区指到临时目录，不要拿本仓库当靶子。
- 任何"失败时降级为无沙盒"的写法都不接受。要降级必须由用户显式选择，并在输出里说明。
- 新增路径处理一律先 `realpathLoose`，不要用 `startsWith` 比较字符串。
- 需要修改系统状态的操作（目录 ACL、注册表、服务）不许放进启动流程，必须做成显式命令，并在失败时给出可执行的下一步。`feima sandbox grant` 就是这条规则的产物。
