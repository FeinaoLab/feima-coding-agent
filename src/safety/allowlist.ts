/**
 * 命令白名单。
 *
 * 默认不启用——启用后只放行规则里写过的命令前缀，其余一律拒绝。
 *
 * 为什么必须自己切分命令串：`git status; rm -rf ~` 整串看开头是 git，
 * 真正执行的是两条命令。用正则找「有没有 rm」也不行：`grep "rm -rf" notes.md`
 * 里的 rm 只是参数，拦掉它等于把正常用法一起废掉。所以先按 shell 语法切段
 * （尊重引号与转义），再逐段取 argv 头部做前缀匹配。
 *
 * 两类东西在白名单模式下直接拒绝，不给「规则里写全就行」的口子：
 * 命令替换（`$(...)`、反引号、`${...}`）与重定向。它们能构造出规则里没写的命令，
 * 或者把输出写到规则覆盖不到的地方。真要写文件，用 write_file，那条路上有策略检查。
 */

export interface AllowRule {
  /** 规则原文，报错时原样回显，方便对照 */
  raw: string;
  /** 切好的前缀，例如 "git status" → ["git","status"] */
  argv: string[];
}

export interface ParsedAllowlist {
  rules: AllowRule[];
  problems: string[];
}

/** 这几个 shell 内建没有副作用，也不进 PATH，放行它们才能写上文的 `cd /d x && npm test` */
const HARMLESS_BUILTINS = new Set(["cd", "true", ":", "exit", "pwd"]);

/** 命令替换：替换出来的内容在校验之后才生成，白名单管不了 */
const SUBSTITUTION = /`|\$\(|\$\{|\<\(|\>\(/;

/**
 * 按 shell 分隔符切段，尊重单双引号与反斜杠转义。
 *
 * 只处理「会启动新进程」的分隔符：`&&` `||` `;` `|` `&` 与换行。
 * `|` 后面也是新进程，所以管道两侧都必须各自过白名单。
 */
export function splitCommands(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // 双引号里的 \" 是转义引号，不能当成结束——否则 `echo "他说 \"a; b\""` 会被
      // 从中间切开，多出一段本来不存在的命令。单引号里反斜杠是字面量，按 POSIX 不动。
      if (quote === '"' && ch === "\\") {
        cur += ch + (command[i + 1] ?? "");
        i++;
        continue;
      }
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "\\") {
      cur += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);

  return out.map((s) => s.trim()).filter(Boolean);
}

/** 把一段命令切成 argv：去引号、处理转义，不展开变量（展开就等于执行） */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      cur += segment[i + 1];
      has = true;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** 去掉引号内容，只留下结构字符，用来判断重定向时不被引号里的 `>` 骗到 */
function stripQuoted(text: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

export function parseAllowlist(list: string[]): ParsedAllowlist {
  const rules: AllowRule[] = [];
  const problems: string[] = [];
  for (const raw of list) {
    const text = raw.trim();
    if (!text) continue;
    if (/[;&|<>]/.test(stripQuoted(text))) {
      problems.push(`白名单规则忽略「${text}」：只能写命令前缀，不能写分隔符或重定向`);
      continue;
    }
    const argv = tokenize(text);
    if (!argv.length) {
      problems.push(`白名单规则忽略「${text}」：解析后为空`);
      continue;
    }
    if (rules.some((r) => r.argv.join(" ") === argv.join(" "))) continue;
    rules.push({ raw: text, argv });
  }
  return { rules, problems };
}

export type AllowDecision = { ok: true } | { ok: false; reason: string };

function clip(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

/**
 * 检查一条命令是否在白名单内。
 *
 * rules 为空视为未启用，返回 ok——「没配白名单」等于「不限制」，
 * 与 policy 模式的默认行为一致，不会因为忘配就把 Agent 卡死。
 */
export function checkCommandAllowed(command: string, rules: AllowRule[]): AllowDecision {
  if (!rules.length) return { ok: true };

  if (SUBSTITUTION.test(command)) {
    return {
      ok: false,
      reason: "白名单模式下不允许命令替换（$( )、反引号、${ }）：替换结果在校验之后才生成，无法预先判断",
    };
  }

  for (const segment of splitCommands(command)) {
    if (/[<>]/.test(stripQuoted(segment))) {
      return {
        ok: false,
        reason: `白名单模式下不允许重定向：${clip(segment)}（要写文件请用 write_file，那条路有路径策略）`,
      };
    }

    const argv = tokenize(segment);
    if (!argv.length) continue;
    if (HARMLESS_BUILTINS.has(argv[0])) continue;

    const hit = rules.find((rule) => rule.argv.every((token, i) => argv[i] === token));
    if (!hit) {
      return {
        ok: false,
        reason:
          `命令不在白名单内：${clip(segment)}\n` +
          `允许的命令前缀：${rules.map((r) => r.raw).join("、")}`,
      };
    }
  }

  return { ok: true };
}
