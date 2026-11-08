/**
 * 命令行参数解析。
 *
 * 单独成文件只为可测：cli.ts 是入口脚本，import 它会立刻执行 main()，
 * 参数解析藏在里面就没法写用例。而参数解析恰恰是最容易「静默失效」的一层——
 * `--workspace` 解析出来却没人用，表现是 Agent 在错误的目录里改文件，不报错。
 */

export interface CliFlags {
  json: boolean;
  noSave: boolean;
  workspace?: string;
  model?: string;
  sandbox?: "policy" | "strict";
  isolation?: "auto" | "appcontainer" | "bwrap" | "docker" | "none";
  network?: boolean;
  dockerImage?: string;
  knowledgeUrl?: string;
  knowledgeToken?: string;
  mcp?: boolean;
  mcpConfigFile?: string;
  mcpAllow?: string[];
  /** 哪些副作用要确认：off / write / exec / external / all */
  confirm?: "off" | "write" | "exec" | "external" | "all";
  /** 无人工确认时放行 */
  yes?: boolean;
  /** 权限档 */
  perms?: "read" | "write" | "exec";
  /** 命令白名单，多次出现累加 */
  cmdAllow?: string[];
  /** 压缩摘要用哪个模型 */
  compactModel?: string;
  /** 总尝试次数；0 表示关闭重试 */
  retries?: number;
  rest: string[];
}

/** 需要取一个值的参数名，单独列出来便于统一做「缺值报错」 */
const VALUED = [
  "--workspace",
  "--model",
  "--sandbox",
  "--isolation",
  "--docker-image",
  "--knowledge",
  "--kb-token",
  "--mcp-config",
  "--mcp-allow",
  "--confirm",
  "--perms",
  "--cmd-allow",
  "--compact-model",
  "--retries",
] as const;
type Valued = (typeof VALUED)[number];

export function parseFlags(rest: string[]): CliFlags {
  const out: CliFlags = { json: false, noSave: false, rest: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      // 之后全部当任务文本，避免任务里出现 --xxx 被误当参数
      out.rest.push(...rest.slice(i + 1));
      break;
    }
    if (a === "--json") out.json = true;
    else if (a === "--no-save") out.noSave = true;
    else if (a === "--network") out.network = true;
    else if (a === "--mcp") out.mcp = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if ((VALUED as readonly string[]).includes(a)) {
      const value = rest[i + 1];
      // 缺值时报错，不静默变成 undefined：否则 `--workspace` 写在末尾就等于没写
      if (!value || value.startsWith("--")) throw new Error(`${a} 需要一个值`);
      switch (a as Valued) {
        case "--workspace":
          out.workspace = value;
          break;
        case "--model":
          out.model = value;
          break;
        case "--sandbox":
          if (value !== "policy" && value !== "strict") throw new Error("--sandbox 只接受 policy 或 strict");
          out.sandbox = value;
          break;
        case "--isolation":
          if (!["auto", "appcontainer", "bwrap", "docker", "none"].includes(value)) {
            throw new Error("--isolation 只接受 auto / appcontainer / bwrap / docker / none");
          }
          out.isolation = value as CliFlags["isolation"];
          break;
        case "--docker-image":
          out.dockerImage = value;
          break;
        case "--knowledge":
          out.knowledgeUrl = value;
          break;
        case "--kb-token":
          out.knowledgeToken = value;
          break;
        case "--mcp-config":
          out.mcpConfigFile = value;
          break;
        case "--mcp-allow":
          out.mcpAllow = value
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean);
          break;
        case "--confirm":
          if (!["off", "write", "exec", "external", "all"].includes(value)) {
            throw new Error("--confirm 只接受 off / write / exec / external / all");
          }
          out.confirm = value as CliFlags["confirm"];
          break;
        case "--perms":
          if (!["read", "write", "exec"].includes(value)) {
            throw new Error("--perms 只接受 read / write / exec（累进：read 只读，write 加写文件，exec 加命令）");
          }
          out.perms = value as CliFlags["perms"];
          break;
        case "--cmd-allow":
          // 逗号分隔，并且允许多次出现累加：规则一多，一行写不完
          out.cmdAllow = [
            ...(out.cmdAllow ?? []),
            ...value
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ];
          break;
        case "--compact-model":
          out.compactModel = value;
          break;
        case "--retries": {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error("--retries 只接受 0～6 的整数（总尝试次数）");
          out.retries = n;
          break;
        }
      }
      i++;
    } else out.rest.push(a);
  }
  return out;
}
