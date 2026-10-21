/**
 * Retry backoff for notification deliveries.
 *
 * Exponential with equal jitter: the delay is uniformly distributed in
 * `[capped/2, capped]`, so a fleet of deliveries that failed at the same time
 * does not retry in lockstep, while the delay still grows predictably.
 *
 * Pure and clock-injected on purpose — the whole point is to be unit testable
 * without a database.
 */

/** First retry happens roughly five seconds after the first failure. */
export const RETRY_BASE_MS = 5_000;

/** Never wait longer than half an hour between two attempts. */
export const RETRY_MAX_MS = 30 * 60 * 1000;

/**
 * The moment the next attempt should happen.
 *
 * @param attempts how many attempts have been made already (1 = first retry)
 * @param now      the current instant
 * @param baseMs   first backoff step
 * @param maxMs    upper bound of a single wait
 */
export function nextAttemptAt(
  attempts: number,
  now: Date,
  baseMs: number = RETRY_BASE_MS,
  maxMs: number = RETRY_MAX_MS,
): Date {
  const attempt = Math.max(1, Math.floor(attempts));
  const capped = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const floor = Math.floor(capped / 2);
  const jitter = Math.floor(Math.random() * (capped - floor + 1));
  return new Date(now.getTime() + floor + jitter);
}

/** The raw delay (ms) behind {@link nextAttemptAt}. */
export function backoffDelayMs(
  attempts: number,
  baseMs: number = RETRY_BASE_MS,
  maxMs: number = RETRY_MAX_MS,
): number {
  return nextAttemptAt(attempts, new Date(0), baseMs, maxMs).getTime();
}
