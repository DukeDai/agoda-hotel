/**
 * Retry with exponential backoff + full jitter, plus a circuit breaker.
 *
 * Rules that matter for the Agoda adapter:
 *  - 429 and 5xx and network timeouts are retryable; 4xx business errors are not.
 *  - A booking call must NOT be blindly retried by the transport layer —
 *    the caller decides, because a retried Book may double-book.
 *    Use `retryable: false` for the booking call and drive retries from the
 *    job layer where idempotency is known.
 */

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  // Full jitter: uniform random in [0, capped].
  return Math.floor(Math.random() * capped);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const isRetryable = options.isRetryable ?? (() => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const canRetry = attempt < attempts && isRetryable(err);
      if (!canRetry) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      options.onRetry?.(err, attempt, delay);
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}

// --- Circuit breaker -------------------------------------------------------

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  halfOpenMaxCalls?: number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

/**
 * Minimal circuit breaker. When Agoda is unhealthy we fail fast instead of
 * burning the customer's latency budget on doomed calls.
 */
export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private halfOpenCalls = 0;

  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly halfOpenMaxCalls: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
    this.onStateChange = options.onStateChange;
  }

  get currentState(): CircuitState {
    return this.state;
  }

  private transition(to: CircuitState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.onStateChange?.(from, to);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt < this.openMs) {
        throw new Error('Circuit breaker is OPEN');
      }
      this.transition('HALF_OPEN');
      this.halfOpenCalls = 0;
    }

    if (this.state === 'HALF_OPEN' && this.halfOpenCalls >= this.halfOpenMaxCalls) {
      throw new Error('Circuit breaker is HALF_OPEN and saturated');
    }

    this.halfOpenCalls += 1;
    try {
      const result = await fn();
      this.failures = 0;
      if (this.state !== 'CLOSED') this.transition('CLOSED');
      return result;
    } catch (err) {
      this.failures += 1;
      if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
        this.openedAt = Date.now();
        this.transition('OPEN');
      }
      throw err;
    }
  }
}
