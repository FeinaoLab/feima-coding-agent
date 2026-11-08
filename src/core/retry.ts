/**
 * 重试策略。
 *
 * 只有一条核心约束，但它决定了一切：**没产生副作用才允许重试**。
 *
 * 429 和 5xx 该退避重试，但如果上一次尝试已经往外吐过东西——
 * 哪怕只是一个 text_delta，或者半截工具参数——重试就会把同一段话输出两遍，
 * 或者把只拼了一半的命令再执行一次。所以判断依据不是「错误码是几」，
 * 而是「这次尝试有没有对外界做过事」。这条判断由调用方通过 hasSideEffect 提供，
 * 因为它只有在那里才看得见。
 *
 * 另一条：重试次数用尽后必须把原始错误抛出去，不能包装成「重试失败」。
 * 用户拿到的是 429 的原文才能自己判断该改配置还是该等一会儿。
 */

export interface RetryPolicy {
  /** 总尝试次数，含首次。1 = 不重试 */
  attempts: number;
  /** 首次失败后的等待基数 */
  baseMs: number;
  /** 单次等待上限 */
  maxMs: number;
  /** 抖动比例：0.3 表示实际等待在 ±30% 之间浮动，避免多进程同时重试打爆上游 */
  jitter: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseMs: 700, maxMs: 8000, jitter: 0.3 };

/** 关闭重试 */
export const NO_RETRY: RetryPolicy = { attempts: 1, baseMs: 0, maxMs: 0, jitter: 0 };

/**
 * 第 failed 次失败后该等多久：base * 2^(failed-1)，指数封顶，再按比例抖动。
 * random 可注入，否则抖动让用例没法断言。
 */
export function backoffDelay(failedTimes: number, policy: RetryPolicy, random: () => number = Math.random): number {
  if (policy.attempts <= 1) return 0;
  const exp = policy.baseMs * Math.pow(2, Math.max(0, failedTimes - 1));
  const capped = Math.min(policy.maxMs, exp);
  if (policy.jitter <= 0) return Math.round(capped);
  const span = capped * policy.jitter;
  return Math.round(capped - span + random() * span * 2);
}

/** 可被中止打断的等待。中止后立即返回，让上层的 abort 检查接手 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface RetryInfo {
  /** 第几次尝试失败（从 1 开始） */
  attempt: number;
  delayMs: number;
  message: string;
}

export interface RetryOptions {
  policy: RetryPolicy;
  /** 错误本身值不值得重试（429/5xx/连接失败为真，400 为假） */
  isRetryable: (err: unknown) => boolean;
  /** 本次尝试是否已经对外界产生副作用；为真时无论错误多可重试都不重试 */
  hasSideEffect: () => boolean;
  /** 决定要重试时回调，用来给用户一个「在等」的反馈 */
  onRetry?: (info: RetryInfo) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  random?: () => number;
}

/**
 * 执行 run，按策略重试。
 *
 * 不吞错误：重试用尽或不该重试时抛原错误。
 * 副作用一旦发生就立刻放弃重试——这一条比「多试几次更可靠」重要得多。
 */
export async function withRetry<T>(run: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const policy = opts.policy;
  const total = Math.max(1, policy.attempts);
  const wait = opts.sleep ?? sleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await run(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= total) throw err;
      if (opts.signal?.aborted) throw err;
      if (!opts.isRetryable(err)) throw err;

      // 已经做过事就不许重试：重试等于把副作用再放一遍
      if (opts.hasSideEffect()) throw err;

      const delayMs = backoffDelay(attempt, policy, opts.random);
      opts.onRetry?.({
        attempt,
        delayMs,
        message: err instanceof Error ? err.message : String(err),
      });
      await wait(delayMs, opts.signal);
      if (opts.signal?.aborted) throw err;
    }
  }
  throw lastError;
}
