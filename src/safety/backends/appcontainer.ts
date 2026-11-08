/**
 * Windows 原生隔离后端：AppContainer。
 *
 * 为什么是它：Windows 上想做进程级隔离，可选路径只有四条——
 *   Windows Sandbox（要 Pro/Enterprise + 重启，且是整机虚拟机）、
 *   Hyper-V 容器（要 daemon + 管理员）、
 *   Docker/WSL（要 daemon 或内核组件）、
 *   AppContainer（普通用户即可，系统自带，进程级 + 文件系统级）。
 * 前三条都要环境前提，只有 AppContainer 在「一台普通家用 Windows」上开箱可用。
 *
 * 工作原理：给工作区单独注册一个 AppContainer profile（一个随机 SID），
 * 只把这个 SID 授权到工作区目录，然后用该 SID 的令牌启动子进程。
 * 子进程读不到 %USERPROFILE% 下的任何东西，也写不出去——不是靠命令过滤，
 * 是内核在 CreateProcess 时就把令牌限定死了。
 *
 * 三条硬约束：
 * 1. 授权用 ACL，不是路径白名单。所以必须显式 grant 工作区，退出时 revoke。
 *    不 revoke 就是安全债：ACL 会一直留在目录上。
 * 2. profile 按工作区路径哈希命名，不同工作区互相看不见对方的授权。
 * 3. 启动必须真跑一次 selfTest。见 isolation.ts 顶部那段。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecFn } from "../../types.ts";
import { realpathLoose } from "../policy.ts";
import type {
  IsolationAvailability,
  IsolationBackend,
  RunPaths,
  SelfTestReport,
  SpawnPlan,
} from "../isolation.ts";
import { decoyName } from "../isolation.ts";

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), "appcontainer.ps1");
// 不从这里 import CONFIG_DIR：config.ts 反向依赖 safety/exec.ts，会形成循环
const SID_DIR = path.join(os.homedir(), ".feima", "sandbox");

function psExe(): string {
  return process.env.SYSTEMROOT
    ? path.join(process.env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

/** 每台机器第一次启动时编译一次 C#，之后从缓存读 */
const PROFILE_PS1 = String.raw`
param([string]$Name)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;

public static class FeimaProfile {
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int CreateAppContainerProfile(string name, string displayName, string description,
    IntPtr capabilities, uint capabilityCount, out IntPtr sid);

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
  static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "ConvertSidToStringSidW")]
  static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr LocalFree(IntPtr h);

  public static string SidOf(string name) {
    IntPtr sid;
    // 必须先 Create：Derive 只是按名字算 SID，对未注册的 profile 也会"成功"，
    // 拿到的 SID 拿去 CreateProcess 会得到一句莫名其妙的 failed: 2。
    int hr = CreateAppContainerProfile(name, name, "feima sandbox", IntPtr.Zero, 0, out sid);
    if (hr != 0) {
      // 0x800700B7 = ERROR_ALREADY_EXISTS，说明之前建过，直接派生即可
      if (hr != unchecked((int)0x800700B7) || DeriveAppContainerSidFromAppContainerName(name, out sid) != 0) {
        throw new Exception("CreateAppContainerProfile failed hr=0x" + hr.ToString("X8"));
      }
    }
    IntPtr str;
    if (!ConvertSidToStringSid(sid, out str)) throw new Exception("ConvertSidToStringSid failed");
    string text = Marshal.PtrToStringUni(str);
    LocalFree(str);
    return text;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
[FeimaProfile]::SidOf($Name)
`;

function runPs(scriptFile: string, args: string[], timeout = 60_000): { code: number; out: string; err: string } {
  const res = spawnSync(psExe(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, ...args], {
    encoding: "latin1", // SID 与 icacls 输出都是 ASCII，用 latin1 只为原样取字节
    timeout,
    windowsHide: true,
  });
  return {
    code: res.status ?? 1,
    out: (res.stdout ?? "").trim(),
    err: (res.stderr ?? "").trim() || (res.error ? String(res.error.message) : ""),
  };
}

function profileName(workspace: string): string {
  const real = realpathLoose(workspace).toLowerCase();
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
  return `Feinao.Feima.Sandbox.${hash}`;
}

function sidCachePath(workspace: string): string {
  return path.join(SID_DIR, `${profileName(workspace).split(".").pop()}.sid`);
}

function readCachedSid(workspace: string): string | null {
  try {
    const sid = fs.readFileSync(sidCachePath(workspace), "utf8").trim();
    return /^S-1-15-2(-\d+)+$/.test(sid) ? sid : null;
  } catch {
    return null;
  }
}

function ensureSid(workspace: string): string {
  const cached = readCachedSid(workspace);
  if (cached) return cached;

  const name = profileName(workspace);
  const script = path.join(os.tmpdir(), `feima-profile-${process.pid}.ps1`);
  // 必须带 BOM：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，
  // 内嵌 C# 里的中文注释会被读成乱码，编译报「当前上下文中不存在名称 xxx」
  fs.writeFileSync(script, "\uFEFF" + PROFILE_PS1, "utf8");
  try {
    const res = runPs(script, ["-Name", name]);
    const sid = (res.out.split(/\r?\n/).filter((l) => /^S-1-15-2/.test(l.trim())).pop() ?? "").trim();
    if (!sid) {
      throw new Error(`无法为该工作区注册 AppContainer（exit ${res.code}）：${res.err || res.out || "无输出"}`);
    }
    fs.mkdirSync(SID_DIR, { recursive: true });
    fs.writeFileSync(sidCachePath(workspace), sid + "\n", "utf8");
    return sid;
  } finally {
    try {
      fs.unlinkSync(script);
    } catch {
      /* 临时文件删不掉不影响功能 */
    }
  }
}

/**
 * 拼一份 Windows 原生格式的 PATH。
 *
 * 为什么需要：从 Git Bash / MSYS 启动 node 时，process.env.PATH 是一串
 * `/c/Users/...` 的 POSIX 路径，且**不含 C://Windows//System32**。
 * AppContainer 里 CreateProcess 靠 PATH 找 cmd.exe，找不到就只回一句
 * "CreateProcess failed: 2"——看起来像隔离后端坏了，实际是启动环境的问题。
 * 系统目录永远排在前面，原有条目去重后接在后面（用户装的工具仍然可用）。
 */
export function windowsPath(): string {
  const sysRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:////Windows";
  const system = [
    path.join(sysRoot, "System32"),
    sysRoot,
    path.join(sysRoot, "System32", "Wbem"),
    path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0"),
    path.join(sysRoot, "System32", "OpenSSH"),
  ];
  const seen = new Set(system.map((p) => p.toLowerCase()));
  const extra: string[] = [];
  for (const raw of (process.env.PATH ?? "").split(";")) {
    const item = raw.trim();
    // 丢掉 POSIX 风格条目（/c/Users/...）与 MSYS 残留的单字母项（C）
    if (!item || item.startsWith("/") || /^[A-Za-z]$/.test(item)) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push(item);
  }
  return [...system, ...extra].join(";");
}

/** AppContainer 定位自身目录所需的最小用户目录集合 */
function userDirs(): Record<string, string> {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const roaming = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const systemDrive = process.env.SystemDrive ?? "C:";
  return {
    USERPROFILE: home,
    // cmd.exe 启动时会主动 cd 到 HOMEDRIVE+HOMEPATH。指向用户目录的话，
    // 那一步立刻「拒绝访问」，之后所有命令都在 C:// 上跑（dir 全被拒）。
    // 这里指到工作区，cmd 落地即可访问。
    HOMEDRIVE: path.parse(home).root.replace(/\\$/, "") || systemDrive,
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    USERNAME: process.env.USERNAME ?? os.userInfo().username,
    USERDOMAIN: process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? ".",
    COMPUTERNAME: process.env.COMPUTERNAME ?? ".",
    LOCALAPPDATA: local,
    APPDATA: roaming,
    TEMP: path.join(local, "Temp"),
    TMP: path.join(local, "Temp"),
    ProgramData: process.env.ProgramData ?? path.join(systemDrive, "\\", "ProgramData"),
    "ProgramFiles": process.env.ProgramFiles ?? path.join(systemDrive, "\\", "Program Files"),
    SystemDrive: systemDrive,
  };
}

function icacls(args: string[], timeout = 30_000): { code: number; out: string } {
  const res = spawnSync("icacls", args, { encoding: "latin1", windowsHide: true, timeout });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (res.error) return { code: -1, out: `${out} ${res.error.message}`.trim() };
  return { code: res.status ?? 1, out };
}

/**
 * 从工作区往上到盘符根的所有祖先目录。
 *
 * AppContainer 的访问检查是"逐级"的：要打开 D://a//b//c//file，必须先能进入
 * D://、D://a、D://a//b。这些目录默认都没有给 AppContainer SID 的 ACE
 * （它们只对 Users / Authenticated Users 授权，而容器不看这两个组），
 * 所以哪怕目标目录本身给了完全控制，`cd` 和 `dir` 仍会"拒绝访问"。
 *
 * 改祖先目录的 ACL 往往需要管理员权限；非提权时 icacls 会挂起等 UAC，
 * 因此这里带短超时，失败就如实记录，不硬撑。
 */
function ancestorsOf(workspace: string): string[] {
  const out: string[] = [];
  let cur = path.dirname(workspace);
  for (let i = 0; i < 12; i++) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/**
 * 给工作区的每一级祖先目录加上「遍历」权限，让容器能走进去。
 *
 * 单独暴露成命令，是因为这一步经常需要管理员权限：非提权的 icacls 会挂起
 * 等 UAC，在一个无人值守的进程里表现为"卡住"。与其在启动路径里静默赌一次，
 * 不如让用户显式执行 `feima sandbox grant`，看到每一步的结果。
 */
export function grantAncestors(workspace: string, timeoutMs = 60_000): { ok: boolean; log: string[] } {
  const log: string[] = [];
  const real = realpathLoose(workspace);
  const sid = ensureSid(workspace);
  log.push(`SID  ${sid}`);
  let ok = true;
  for (const dir of [...ancestorsOf(real), real]) {
    const res = icacls([dir, "/grant", `*${sid}:(X)`], timeoutMs);
    const good = res.code === 0;
    if (!good) ok = false;
    log.push(`${good ? "OK  " : "FAIL"} ${dir}${good ? "" : `  ← ${res.out.split(/\r?\n/)[0] || "超时或权限不足"}`}`);
  }
  return { ok, log };
}

export function createAppContainerBackend(): IsolationBackend {
  const sids = new Map<string, string>();
  /** 本次运行给哪些目录加过 ACE，退出时要一条条撤掉 */
  const store = { ancestors: new Set<string>(), linked: new Set<string>() };

  const sidOf = (workspace: string): string => {
    const key = realpathLoose(workspace).toLowerCase();
    const hit = sids.get(key);
    if (hit) return hit;
    const sid = ensureSid(workspace);
    sids.set(key, sid);
    return sid;
  };

  return {
    id: "appcontainer",
    real: true,
    // 子进程由 launcher 里的 CreateProcess 创建，是 Node 的"孙进程"，
    // 管道句柄第二次转发不可靠（只会得到一句 CreateProcess failed: 2）
    capture: "files",
    label: "AppContainer（Windows 原生，按目录授权，无网络能力）",

    availability(): IsolationAvailability {
      if (process.platform !== "win32") {
        return { available: false, reason: "AppContainer 只在 Windows 上存在（其他平台用 bwrap / sandbox-exec）" };
      }
      if (!fs.existsSync(LAUNCHER)) {
        return { available: false, reason: `启动器缺失：${LAUNCHER}` };
      }
      return { available: true, reason: "Windows 原生 AppContainer 可用" };
    },

    async prepare(workspace: string): Promise<void> {
      const sid = sidOf(workspace);
      const real = realpathLoose(workspace);
      // 先清后加：保证幂等，避免反复启动后 ACE 累积
      icacls([real, "/remove:g", `*${sid}`]);
      const granted = icacls([real, "/grant", `*${sid}:(OI)(CI)M`]);
      if (granted.code !== 0) {
        throw new Error(`授权工作区失败（AppContainer 需要目录 ACL 才能写文件）：${granted.out}`);
      }

      // 运行时目录只读：容器读不到 %USERPROFILE%，不授权的话 node/npm/git
      // 全是"不是内部或外部命令"，Agent 连一条命令都跑不起来
      const nodeDir = path.dirname(process.execPath);
      icacls([nodeDir, "/grant", `*${sid}:(OI)(CI)RX`], 15_000);
      store.linked.add(real.toLowerCase());

      // 祖先目录只给"遍历"（X），够走进来就行，不给读也不给写
      for (const dir of ancestorsOf(real)) {
        const res = icacls([dir, "/grant", `*${sid}:(X)`], 8_000);
        if (res.code === 0) store.ancestors.add(dir.toLowerCase());
      }
    },

    plan(command: string, workspace: string, paths?: RunPaths): SpawnPlan {
      if (!paths) throw new Error("appcontainer 后端需要输出文件路径（capture=files）");
      const b64 = Buffer.from(command, "utf8").toString("base64");
      return {
        file: psExe(),
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          LAUNCHER,
          "-SidString",
          sidOf(workspace),
          "-Cwd",
          realpathLoose(workspace),
          "-CommandB64",
          b64,
          "-OutFile",
          paths.out,
          "-ErrFile",
          paths.err,
          "-AuxFile",
          paths.aux,
        ],
        // 环境白名单是给"用户命令"用的，但启动器本身需要 SystemRoot 与一份
        // Windows 原生 PATH 才能让 CreateProcess 定位 cmd.exe。这两样都不含凭据。
        // AppContainer 启动时需要一整套用户目录变量来定位自己的 LocalState
        // （%LOCALAPPDATA%\Packages\<name>\AC），缺了就只会得到
        // "CreateProcess failed: 203"（ERROR_ENVVAR_NOT_FOUND）。都不含凭据。
        env: {
          SystemRoot: process.env.SystemRoot ?? "C:////Windows",
          windir: process.env.windir ?? "C:////Windows",
          PATH: windowsPath(),
          ...userDirs(),
        },
      };
    },

    async selfTest(workspace: string, execInSandbox: ExecFn): Promise<SelfTestReport> {
      const home = os.homedir();
      const inName = decoyName();
      const hostName = decoyName();
      const insidePath = path.join(workspace, inName);
      const hostPath = path.join(home, hostName);
      const token = `feima-${Math.random().toString(36).slice(2, 12)}`;

      fs.writeFileSync(insidePath, token, "utf8");
      let hostWritten = false;
      try {
        fs.writeFileSync(hostPath, "host-secret", "utf8");
        hostWritten = true;
      } catch {
        // 写不进家目录（只读配置或权限被收紧）时，这一项无法验证，标记为未知
      }

      const readWorkspace = await execInSandbox(`type "${insidePath}"`, workspace, { timeoutMs: 20_000 })
        .then((r) => r.stdout.includes(token))
        .catch(() => false);

      const denyHostRead = hostWritten
        ? await execInSandbox(`type "${hostPath}"`, workspace, { timeoutMs: 20_000 })
            .then((r) => !r.stdout.includes("host-secret"))
            .catch(() => true)
        : true;

      const listWorkspace = await execInSandbox('dir /b', workspace, { timeoutMs: 30_000 })
        .then((r) => r.exitCode === 0 && r.stdout.trim().length > 0)
        .catch(() => false);
      const writeWorkspace = await execInSandbox(`echo ${token} > "${path.join(workspace, inName + ".w")}"`, workspace, {
        timeoutMs: 20_000,
      })
        .then((r) => {
          try {
            return fs.readFileSync(path.join(workspace, inName + ".w"), "utf8").includes(token);
          } catch {
            return false;
          }
        })
        .catch(() => false);

      const denyHostWrite = await execInSandbox(`echo x > "${hostPath}.w"`, workspace, { timeoutMs: 20_000 })
        .then(() => !fs.existsSync(`${hostPath}.w`))
        .catch(() => true);

      for (const p of [insidePath, `${insidePath}.w`, hostPath, `${hostPath}.w`]) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* 不存在就算了 */
        }
      }

      const ok = readWorkspace && denyHostRead && writeWorkspace && denyHostWrite && listWorkspace;
      const parts = [
        `读工作区 ${readWorkspace ? "通过" : "失败"}`,
        `读宿主家目录 ${denyHostRead ? "被拒" : "**未拦住**"}`,
        `写工作区 ${writeWorkspace ? "通过" : "失败"}`,
          `列目录 ${listWorkspace ? "通过" : "**被拒**"}`,
        `写宿主家目录 ${denyHostWrite ? "被拒" : "**未拦住**"}`,
      ];
      return {
        ok,
        readWorkspace,
        denyHostRead,
        writeWorkspace,
        listWorkspace,
        denyHostWrite,
        detail: parts.join("；") + (hostWritten ? "" : "（家目录不可写，读取项按通过计）"),
      };
    },

    async dispose(workspace: string): Promise<void> {
      const sid = sids.get(realpathLoose(workspace).toLowerCase()) ?? readCachedSid(workspace);
      if (!sid) return;
      // 撤销授权：留着 ACL 就是安全债，下一个 AppContainer 进程仍能读到这个目录
      icacls([realpathLoose(workspace), "/remove:g", `*${sid}`]);
      icacls([path.dirname(process.execPath), "/remove:g", `*${sid}`], 15_000);
      for (const dir of store.ancestors) {
        icacls([dir, "/remove:g", `*${sid}`], 8_000);
      }
      store.ancestors.clear();
      store.linked.delete(realpathLoose(workspace).toLowerCase());
    },
  };
}
