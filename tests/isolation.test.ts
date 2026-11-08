/**
 * 隔离后端的离线用例。
 *
 * 这里测的全是"参数怎么拼"——因为参数拼错是这一层最常见的失败，
 * 而且真机跑一次要几十秒，没法在每次改动时都验。
 * 真正"隔离生不生效"只能靠 selfTest，那个用例在 tests/longrun.test.ts 里
 * 用假执行器验结构，真机验证记在 EVENTS/README。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildBwrapArgs } from "../src/safety/backends/bwrap.ts";
import { buildDockerArgs } from "../src/safety/backends/docker.ts";
import { windowsPath } from "../src/safety/backends/appcontainer.ts";
import { mergeEnv } from "../src/safety/exec.ts";
import { realpathLoose } from "../src/safety/policy.ts";

const existsAll = () => true;

test("bwrap：白名单挂载，工作区是唯一可写路径", () => {
  const args = buildBwrapArgs({
    command: "npm test",
    workspace: "/home/u/proj",
    network: false,
    exists: existsAll,
  });
  const joined = args.join(" ");

  // 系统目录只读绑定
  assert.ok(joined.includes("--ro-bind /usr /usr"));
  assert.ok(joined.includes("--ro-bind /etc /etc"));
  // 工作区可写（路径会被 path.resolve 归一化，Windows 上 /home/u/proj 变成 D://home//u//proj）
  const ws = realpathLoose("/home/u/proj");
  assert.ok(joined.includes(`--bind ${ws} ${ws}`));
  // 敏感文件盖成 /dev/null：绑进来的是整份 /etc，得单独堵住
  assert.ok(joined.includes("--ro-bind /dev/null /etc/shadow"));
  // 默认不出网
  assert.ok(joined.includes("--unshare-all"));
  assert.ok(!joined.includes("--share-net"));
  assert.deepEqual(args.slice(-4), ["--", "/bin/sh", "-c", "npm test"]);
});

test("bwrap：明确要求联网时才加 --share-net", () => {
  const args = buildBwrapArgs({ command: "curl x", workspace: "/w", network: true, exists: existsAll });
  assert.ok(args.includes("--share-net"));
  assert.ok(args.includes("--unshare-all"), "--unshare-all 仍在，只把网络放回来");
});

test("bwrap：不存在的系统目录不写进参数，避免 bwrap 直接报错", () => {
  const args = buildBwrapArgs({
    command: "ls",
    workspace: "/w",
    network: false,
    exists: (p) => p === "/usr" || p === "/w",
  });
  assert.ok(args.includes("--ro-bind"));
  assert.ok(args.includes("/usr"));
  assert.ok(!args.includes("/nix/store"));
  assert.ok(!args.includes("/bin"), "只有 /usr 存在时不该绑 /bin");
});

test("docker：同路径挂载，让容器内外的路径字符串一致", () => {
  const args = buildDockerArgs({ command: "npm test", workspace: "/srv/app", network: false });
  const joined = args.join(" ");

  const ws = realpathLoose("/srv/app");
  assert.ok(joined.includes(`-v ${ws}:${ws}`), "必须同路径挂载，否则工具返回的路径在宿主上不存在");
  assert.ok(joined.includes(`-w ${ws}`));
  assert.ok(joined.includes("--network none"));
  assert.ok(joined.includes("--cap-drop ALL"));
  assert.ok(joined.includes("--security-opt no-new-privileges"));
  assert.ok(joined.includes("--entrypoint /bin/sh"));
  assert.equal(args.at(-1), "npm test");
});

test("docker：给网络时才用 bridge", () => {
  const args = buildDockerArgs({ command: "npm i", workspace: "/w", network: true });
  const i = args.indexOf("--network");
  assert.equal(args[i + 1], "bridge");
});

test("docker：指定 uid:gid，避免产物属主变成 root", () => {
  const args = buildDockerArgs({ command: "touch a", workspace: "/w", network: false, user: "1000:1000" });
  const i = args.indexOf("--user");
  assert.equal(args[i + 1], "1000:1000");
});

test("windowsPath：丢掉 POSIX 条目与 MSYS 残留，系统目录永远在最前", () => {
  const origin = process.env.PATH;
  const originRoot = process.env.SystemRoot;
  try {
    process.env.SystemRoot = "C:\\Windows";
    // 从 Git Bash 启动时 Path 长这样：第一项是被冒号切碎的 "C"，
    // 后面是 /c/Users/... 的 POSIX 路径，System32 根本不在里面
    process.env.PATH = "C;/c/Users/u/.nvm;/usr/bin;C:\\Tools\\bin;C:\\Windows\\System32";
    const p = windowsPath();
    const parts = p.split(";");

    assert.equal(parts[0].toLowerCase(), "c:\\windows\\system32", "系统目录必须排最前");
    assert.ok(!p.includes("/c/Users"), "POSIX 路径要丢掉");
    assert.ok(!parts.includes("C"), "被冒号切碎的单字母项要丢掉");
    assert.ok(parts.some((x) => x === "C:\\Tools\\bin"), "真正的工具目录要保留");
    assert.equal(parts.filter((x) => x.toLowerCase() === "c:\\windows\\system32").length, 1, "重复项要去重");
  } finally {
    if (origin === undefined) delete process.env.PATH;
    else process.env.PATH = origin;
    if (originRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originRoot;
  }
});

test("mergeEnv：同名不同大小写只留后者的值", () => {
  // 踩过：基础环境里是 Path（POSIX 格式），后端补的是 PATH（Windows 格式），
  // 两个键并存时 spawn 传出两个条目，系统取哪个看运气
  const merged = mergeEnv({ Path: "/c/Windows", HOME: "/home/u" }, { PATH: "C:\\Windows\\System32" });
  const keys = Object.keys(merged).filter((k) => k.toLowerCase() === "path");
  assert.equal(keys.length, 1);
  assert.equal(merged[keys[0]], "C:\\Windows\\System32");
  assert.equal(merged.HOME, "/home/u", "不相关的变量要留下");
});
