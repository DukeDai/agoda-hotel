import type { AppContext } from '../../lib/context.js';
import { processOutboxOnce } from './pump.js';

/**
 * Background pump.
 *
 * The outbox table is the source of truth, so a plain interval is enough:
 * a restart never loses work. Two guards matter though — a cycle never
 * overlaps with the previous one, and a failing cycle is logged instead of
 * escaping into the timer.
 */

export type OutboxWorkerOptions = {
  /** How often the pump runs. */
  intervalMs?: number;
};

export type OutboxWorkerHandle = {
  /** Stops the timer and waits for an in-flight cycle to finish. */
  stop(): Promise<void>;
};

export const OUTBOX_WORKER_INTERVAL_MS = 5_000;

export function startOutboxWorker(
  ctx: AppContext,
  options: OutboxWorkerOptions = {},
): OutboxWorkerHandle {
  const intervalMs = options.intervalMs ?? OUTBOX_WORKER_INTERVAL_MS;

  let running = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const timer = setInterval(() => {
    // Overlap protection: never start a second cycle while one is running.
    if (stopped || running) return;
    running = true;
    inFlight = processOutboxOnce(ctx)
      .then((result) => {
        ctx.logger.debug('outbox cycle finished', { ...result });
      })
      .catch((err: unknown) => {
        ctx.logger.error('outbox cycle failed', { err });
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();

  return {
    stop: async (): Promise<void> => {
      stopped = true;
      clearInterval(timer);
      await inFlight.catch(() => undefined);
    },
  };
}
