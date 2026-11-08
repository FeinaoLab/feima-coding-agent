/**
 * 空转检测：模型围着同一个坑反复撞的时候，把它拽出来。
 *
 * 这个需求不是想出来的，是真机上数出来的：
 *   - v0.2.1：8B 模型某一轮推理 4000+ delta 却一个工具都不调，思考发散
 *   - v0.5 端到端：确认闸门拒绝之后，模型换了五种写法重试同一件事
 *     （write_file → bash write_file → echo 重定向 → powershell Set-Content ×3），
 *     六次撞的是同一句话，最后还给用户出了「用管理员身份运行」的主意
 *
 * 为什么不直接降 maxRounds：那是总量闸，撞墙六次离上限还远；而且它分不清
 * 「在推进」和「在原地踏步」——真干活的任务需要几十轮，空转的任务三轮就够了。
 *
 * 判据只用两样东西，都是模型自己给的：
 *   1. 同一个失败原因反复出现（跨工具、跨写法都算）——说明它没换思路
 *   2. 完全相同的调用反复出现（名字 + 参数一模一样）——说明它没改输入
 * 两者都只做「提醒」，越过上限才中止；中止是这一轮结束，不是进程退出。
 */

export interface RepeatVerdict {
  kind: "warn" | "stop";
  message: string;
}

export interface RepeatGuardOptions {
  /** 同一个失败原因出现多少次提醒；0 表示不检查这一项 */
  sameFailureWarn: number;
  /** 同一个失败原因出现多少次中止 */
  sameFailureStop: number;
  /** 同一个工具的连续失败多少次提醒 */
  sameToolWarn: number;
  /** 同一个工具的连续失败多少次中止 */
  sameToolStop: number;
  /** 完全相同的调用出现多少次提醒 */
  sameCallWarn: number;
  /** 完全相同的调用出现多少次中止 */
  sameCallStop: number;
  /** 只看最近多少次调用 */
  window: number;
}

export const DEFAULT_REPEAT_GUARD: RepeatGuardOptions = {
  sameFailureWarn: 3,
  sameFailureStop: 5,
  sameToolWarn: 3,
  sameToolStop: 5,
  sameCallWarn: 4,
  sameCallStop: 8,
  window: 10,
};

interface Entry {
  name: string;
  sig: string;
  failure: string | null;
}

/** 参数只要顺序不同就算不同调用，但 JSON.stringify 对键序敏感，这里排一下 */
export function callSignature(name: string, argsJson: string): string {
  let normalized = argsJson.trim();
  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      normalized = JSON.stringify(Object.keys(parsed).sort().map((k) => [k, (parsed as Record<string, unknown>)[k]]));
    }
  } catch {
    /* 参数不是合法 JSON 时按原样比较——反正它本来就会被判成参数错误 */
  }
  return `${name}|${normalized}`;
}

/**
 * 失败原因归一：只取第一行，去掉行号/耗时这类每次都变的部分。
 * 不这么做的话「同一堵墙」会被当成不同的墙，因为报错里带着不同的时间戳。
 */
export function failureReason(content: string): string | null {
  if (!content.startsWith("错误：")) return null;
  return content
    .split("\n")[0]
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

export class RepeatGuard {
  private readonly opts: RepeatGuardOptions;
  private readonly history: Entry[] = [];

  constructor(opts: Partial<RepeatGuardOptions> = {}) {
    this.opts = { ...DEFAULT_REPEAT_GUARD, ...opts };
  }

  /** 记录一次调用，返回要不要提醒/中止；不触发时返回 null */
  observe(name: string, sig: string, content: string): RepeatVerdict | null {
    const failure = failureReason(content);
    this.history.push({ name, sig, failure });
    if (this.history.length > this.opts.window) this.history.shift();

    const sameCall = this.history.filter((e) => e.sig === sig).length;
    const sameFailure = failure ? this.history.filter((e) => e.failure && e.failure === failure).length : 0;
    // 同一个工具连着失败：即使每次写法都不同（换命令、换路径），也说明它没找到门
    let sameTool = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const e = this.history[i];
      if (e.name !== name || !e.failure) break;
      sameTool++;
    }

    if (this.opts.sameFailureStop > 0 && sameFailure >= this.opts.sameFailureStop) {
      return {
        kind: "stop",
        message:
          `已中止：同一个失败原因已经出现 ${sameFailure} 次（第 ${this.history.length} 次附近），` +
          `换写法没有改变结果。停下来向用户说明卡在哪一步、需要什么，比继续重试有用。`,
      };
    }
    if (this.opts.sameToolStop > 0 && sameTool >= this.opts.sameToolStop) {
      return {
        kind: "stop",
        message:
          `已中止：${name} 已经连续失败 ${sameTool} 次，每次换的写法都没解决问题。` +
          `停下来向用户说明卡在哪里，别再试了。`,
      };
    }
    if (this.opts.sameCallStop > 0 && sameCall >= this.opts.sameCallStop) {
      return {
        kind: "stop",
        message: `已中止：完全相同的调用已经重复 ${sameCall} 次，结果不会变。停下来向用户说明卡在哪里。`,
      };
    }
    if (this.opts.sameFailureWarn > 0 && sameFailure === this.opts.sameFailureWarn) {
      return {
        kind: "warn",
        message:
          `提醒：这已经是第 ${sameFailure} 次同样的失败原因了。重复同样的操作不会改变结果，` +
          `换一种做法；如果做不到，直接告诉用户卡在哪。`,
      };
    }
    if (this.opts.sameToolWarn > 0 && sameTool === this.opts.sameToolWarn) {
      return {
        kind: "warn",
        message:
          `提醒：${name} 已经连续失败 ${sameTool} 次，换写法也没绕过去。` +
          `先想清楚为什么失败，或者直接告诉用户卡在哪。`,
      };
    }
    if (this.opts.sameCallWarn > 0 && sameCall === this.opts.sameCallWarn) {
      return {
        kind: "warn",
        message: `提醒：第 ${sameCall} 次用完全相同的参数调用同一个工具，结果不会变，换个做法。`,
      };
    }
    return null;
  }

  reset(): void {
    this.history.length = 0;
  }
}
