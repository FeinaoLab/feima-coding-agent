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
  rest: string[];
}

/** 需要取一个值的参数名，单独列出来便于统一做「缺值报错」 */
const VALUED = ["--workspace", "--model", "--sandbox", "--isolation", "--docker-image"] as const;
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
      }
      i++;
    } else out.rest.push(a);
  }
  return out;
}
