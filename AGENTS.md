# AGENTS.md

给在这个仓库里工作的 Agent（包括飞码自己）的可执行规范。每条都能判定对错，没有"请注意保持整洁"。

## 项目结构

- `src/cli.ts`：命令行入口，只做参数解析与事件渲染，不写业务逻辑。
- `src/core/`：循环与状态机。改这里必须同步改 `tests/loop.test.ts`。
- `src/providers/`：模型接入。新增厂商用适配器，不许在循环里写 `if (model.startsWith(...))`。
- `src/tools/`：工具实现。新增工具必须：① 参数手动校验；② 路径走 policy；③ 输出有截断。
- `src/safety/`：策略与执行。这是安全边界，改动需要额外用例覆盖。
- `src/rpc/`：协议层。改协议必须同步更新 `docs/01-架构.md` 第七节。
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

## 提交规范

格式：`类型: 简短描述`，类型取 `feat` / `fix` / `docs` / `test` / `chore`。

CHANGELOG 每条必须写清三件事：现象、根因、修法。不写"修复了一些问题"。

## 安全提示

- 凭据只从环境变量或 `~/.feima/config.json` 读，绝不写进代码、测试、示例。
- 测工具或 RPC 时把工作区指到临时目录，不要拿本仓库当靶子。
- 任何"失败时降级为无沙盒"的写法都不接受。要降级必须由用户显式选择，并在输出里说明。
- 新增路径处理一律先 `realpathLoose`，不要用 `startsWith` 比较字符串。
