import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, backoffDelay, sleep, withRetry } from '../src/retry.js';

/**
 * 保护重试与熔断（retry.ts）的规则：
 *  1. 重试次数有上限，耗尽后必须把最后一次错误原样抛出去，不能吞掉。
 *  2. 「能不能重试」由调用方决定（4xx 业务错误不重试，Book 调用不盲目重试）。
 *  3. 熔断打开后要快速失败，不能继续烧客人的延迟预算。
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backoffDelay() — 指数退避 + full jitter', () => {
  it('第 1 次退避落在 [0, baseDelayMs) 内', () => {
    for (let i = 0; i < 50; i += 1) {
      const d = backoffDelay(1, 100, 1000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(100);
      expect(Number.isInteger(d)).toBe(true);
    }
  });

  it('第 2 次退避落在 [0, baseDelayMs * 2) 内', () => {
    for (let i = 0; i < 50; i += 1) {
      const d = backoffDelay(2, 100, 1000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(200);
    }
  });

  it('退避被 maxDelayMs 截断', () => {
    for (let i = 0; i < 50; i += 1) {
      const d = backoffDelay(20, 100, 1000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1000);
    }
  });
});

describe('withRetry() — 成功路径', () => {
  it('第一次就成功时只调用一次', async () => {
    let calls = 0;
    const result = await withRetry(async (attempt) => {
      calls += 1;
      return `ok-${attempt}`;
    });
    expect(result).toBe('ok-1');
    expect(calls).toBe(1);
  });

  it('失败后重试直至成功，attempt 序号从 1 递增', async () => {
    const attempts: number[] = [];
    const retryLog: Array<{ attempt: number; delay: number }> = [];
    let calls = 0;

    const result = await withRetry(
      async (attempt) => {
        calls += 1;
        attempts.push(attempt);
        if (attempt < 3) throw new Error(`fail-${attempt}`);
        return 'ok';
      },
      {
        attempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        onRetry: (_err, attempt, delay) => retryLog.push({ attempt, delay }),
      },
    );

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(attempts).toEqual([1, 2, 3]);
    expect(retryLog.map((r) => r.attempt)).toEqual([1, 2]);
    expect(retryLog[0]?.delay).toBeGreaterThanOrEqual(0);
    expect(retryLog[0]?.delay).toBeLessThanOrEqual(1);
  });
});

describe('withRetry() — 失败路径', () => {
  it('重试次数用尽后抛出最后一次错误', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`boom-${calls}`);
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toThrow('boom-3');
    expect(calls).toBe(3);
  });

  it('不可重试的错误只尝试一次', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('boom');
        },
        { attempts: 5, baseDelayMs: 1, maxDelayMs: 1, isRetryable: () => false },
      ),
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });

  it('isRetryable 拿到的是原始错误对象', async () => {
    const seen: unknown[] = [];
    await expect(
      withRetry(
        async () => {
          throw new Error('boom');
        },
        {
          attempts: 2,
          baseDelayMs: 1,
          maxDelayMs: 1,
          isRetryable: (err) => {
            seen.push(err);
            return false;
          },
        },
      ),
    ).rejects.toThrow('boom');
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('boom');
  });

  it('非 Error 的抛出值被原样抛回', async () => {
    const thrown = { code: 'weird' };
    await expect(
      withRetry(
        async () => {
          throw thrown;
        },
        { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toBe(thrown);
  });
});

describe('withRetry() — 中断', () => {
  it('已中止的 signal 会让重试以 abort reason 结束', async () => {
    const controller = new AbortController();
    const reason = new Error('aborted by test');
    controller.abort(reason);

    await expect(
      withRetry(
        async () => {
          throw new Error('boom');
        },
        { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, signal: controller.signal },
      ),
    ).rejects.toBe(reason);
  });
});

describe('sleep()', () => {
  it('正常 resolve', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it('signal 已中止时 reject', async () => {
    const controller = new AbortController();
    controller.abort(new Error('nope'));
    await expect(sleep(1000, controller.signal)).rejects.toThrow('nope');
  });
});

describe('CircuitBreaker — 熔断', () => {
  it('默认是 CLOSED 状态', () => {
    expect(new CircuitBreaker().currentState).toBe('CLOSED');
  });

  it('失败未达阈值时保持 CLOSED', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 });
    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.currentState).toBe('CLOSED');
  });

  it('达到阈值后转 OPEN 并快速失败', async () => {
    const transitions: string[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      openMs: 1000,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(breaker.currentState).toBe('OPEN');
    expect(transitions).toEqual(['CLOSED->OPEN']);

    await expect(breaker.execute(async () => 'never')).rejects.toThrow(
      'Circuit breaker is OPEN',
    );
  });

  it('熔断窗口过后进入 HALF_OPEN，成功则回到 CLOSED', async () => {
    const t0 = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const transitions: string[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      openMs: 1000,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.currentState).toBe('OPEN');

    now.mockReturnValue(t0 + 1001);
    await expect(breaker.execute(async () => 'ok')).resolves.toBe('ok');

    expect(breaker.currentState).toBe('CLOSED');
    expect(transitions).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });

  it('HALF_OPEN 下再失败会重新打开熔断', async () => {
    const t0 = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1000 });

    await expect(
      breaker.execute(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.currentState).toBe('OPEN');

    now.mockReturnValue(t0 + 1001);
    await expect(
      breaker.execute(async () => {
        throw new Error('boom again');
      }),
    ).rejects.toThrow('boom again');

    expect(breaker.currentState).toBe('OPEN');
  });
});
