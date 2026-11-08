/**
 * 隔离后端的契约。
 *
 * 一条原则贯穿整个文件：**可用性必须靠执行验证，不能靠检测。**
 * 「找到了 bwrap 这个文件」和「bwrap 真的能把进程关起来」是两件事，
 * 而中间那一段差距正是所有「假绿」的来源：装了半截、命名空间被禁、
 * 用户命名空间被 sysctl 关掉——镜像照样启动，扩展照样加载，
 * 只有真正跑一条越界读取时才会暴露。
 *
 * 所以后端必须实现 selfTest：在宿主放一个带随机值的诱饵文件，
 * 沙盒内读它**必须失败**，沙盒内写工作区**必须成功**。
 * 少一条就判定后端不可用，strict 模式直接拒绝启动。
 */

import type { ExecFn } from "../types.ts";

export type IsolationBackendId = "appcontainer" | "bwrap" | "docker" | "none";

export interface IsolationAvailability {
  available: boolean;
  /** 不可用的原因，要具体到能让人动手修（daemon 没起 / 内核开关没开 / 不是这个平台） */
  reason: string;
}

export interface SelfTestReport {
  ok: boolean;
  /** 读工作区里的诱饵：必须成功 */
  readWorkspace: boolean;
  /** 读宿主家目录里的诱饵：必须失败 */
  denyHostRead: boolean;
  /** 写工作区：必须成功 */
  writeWorkspace: boolean;
  /** 列工作区目录：必须成功。少了这一项，能 type 能 echo 但 dir 全被拒也会被判"通过" */
  listWorkspace: boolean;
  /** 往宿主家目录写诱饵：必须失败 */
  denyHostWrite: boolean;
  detail: string;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  /** 额外环境变量（在 filterEnv 之后合并） */
  env?: Record<string, string>;
}

/** 输出怎么拿回来：管道直连，还是让沙盒自己写文件、结束后读 */
export type CaptureMode = "pipe" | "files";

export interface RunPaths {
  out: string;
  err: string;
  /** 启动器自用的小文件（例如 chcp 的输出），不进结果 */
  aux: string;
}

export interface IsolationBackend {
  id: IsolationBackendId;
  /** 是否真的提供进程/文件系统级隔离（false 表示只是策略层） */
  real: boolean;
  /** 一次性的人类可读描述 */
  label: string;
  availability(): IsolationAvailability;
  /** 准备阶段：建 profile、授权目录等；幂等 */
  prepare(workspace: string): Promise<void>;
  /** 输出捕获方式；AppContainer 用 files（见 appcontainer.ps1 顶部那段说明） */
  capture: CaptureMode;
  /** 把一条命令包装成要 spawn 的进程；capture=files 时必须用到 paths */
  plan(command: string, workspace: string, paths?: RunPaths): SpawnPlan;
  /** 真跑诱饵验证隔离生效 */
  selfTest(workspace: string, execInSandbox: ExecFn): Promise<SelfTestReport>;
  /** 清理：撤销授权、删除诱饵 */
  dispose(workspace: string): Promise<void>;
}

export const DECOY_PREFIX = ".feima-probe-";

export function decoyName(): string {
  return DECOY_PREFIX + Math.random().toString(36).slice(2, 10);
}
