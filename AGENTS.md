# AGENTS.md

给在这个仓库里工作的 Agent（包括飞码自己）的可执行规范。每条都能判定对错，没有"请注意保持整洁"。

## 项目结构

- `src/cli.ts`：命令行入口，只做参数解析与事件渲染，不写业务逻辑。
- `src/core/`：循环、状态机、上下文压缩、会话持久化。
  - 改 `loop.ts` 必须同步改 `tests/loop.test.ts`；
  - 改 `compact.ts` 必须保证 `assistant(tool_calls)` 与 `tool` 结果不被拆开，用例在 `tests/compact.test.ts`；
  - 改 `session.ts` 必须覆盖"残行/坏行"两种损坏形态，用例在 `tests/session.test.ts`。
- `src/providers/`：模型接入。新增厂商用适配器，不许在循环里写 `if (model.startsWith(...))`。
- `src/tools/`：工具实现。新增工具必须：① 参数手动校验；② 路径走 policy；③ 输出有截断。
- `src/safety/`：策略与执行。这是安全边界，改动需要额外用例覆盖。
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
- 压缩切分点只允许落在 `role === "user"` 的位置。`tool` 消息永远不能位于折叠边界的新区首位。
- 系统提示永不进入摘要；恢复会话时用当前配置重新生成，不沿用文件里那条。
- 摘要生成失败必须降级为 `fallbackSummary()`，不允许把异常抛给用户，也不允许"压一半就返回"。
- 会话文件目录只由 `defaultSessionDir()` 决定，测试一律传临时目录，禁止写到真实 `~/.feima`。
- append 之前必须确保文件末尾有换行（`ensureTrailingNewline`）；新增写入路径时同样处理。

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
