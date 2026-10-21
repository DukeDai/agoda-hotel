import { AppError } from '@ota/core';

/**
 * Client side quota limiter (token bucket), ONE BUCKET PER ENDPOINT.
 *
 * Agoda's RPM quota is only disclosed during onboarding, so the threshold
 * is configurable. The limiter protects us from being throttled (HTTP 429)
 * in the first place, and — when the upstream still throttles us — the
 * caller sees a clear `SUPPLIER_RATE_LIMITED` error instead of a raw 429.
 *
 * Why one bucket per endpoint: the quotas are granted per API family. A
 * bulk content sync (a dozen `getHotel` calls) must NOT eat the budget of
 * the booking path — otherwise a background job can make the customer-facing
 * "search / book / cancel" chain fail with a 429 that has nothing to do with
 * the customer's request. Content is a bulk, low-value traffic class, so it
 * gets its own (looser) allowance.
 *
 * It lives under live/ because that is where the real quota applies, but
 * the mock reuses the very same implementation so both sides behave
 * identically under load.
 */

export interface RateLimiterOptions {
  /** Requests per minute for the dynamic endpoints. */
  rpm?: number;
  /** Maximum burst size for the dynamic endpoints. */
  burst?: number;
  /** Requests per minute for the content endpoints (bulk, lower value). */
  contentRpm?: number;
  /** Maximum burst size for the content endpoints. */
  contentBurst?: number;
  /** Per endpoint overrides, e.g. `{ booking: { rpm: 10, burst: 2 } }`. */
  perEndpoint?: Record<string, { rpm?: number; burst?: number }>;
  /** Clock injection point (tests). */
  now?: () => number;
}

export const DEFAULT_RATE_LIMIT_RPM = 60;
export const DEFAULT_RATE_LIMIT_BURST = 10;
export const DEFAULT_CONTENT_RATE_LIMIT_RPM = 120;
export const DEFAULT_CONTENT_RATE_LIMIT_BURST = 30;

interface Bucket {
  tokens: number;
  lastRefill: number;
  rpm: number;
  burst: number;
}

export class TokenBucketRateLimiter {
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly defaults: { rpm: number; burst: number };
  private readonly content: { rpm: number; burst: number };
  private readonly perEndpoint: Record<string, { rpm?: number; burst?: number }>;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.defaults = {
      rpm: Math.max(1, options.rpm ?? DEFAULT_RATE_LIMIT_RPM),
      burst: Math.max(1, options.burst ?? DEFAULT_RATE_LIMIT_BURST),
    };
    this.content = {
      rpm: Math.max(1, options.contentRpm ?? DEFAULT_CONTENT_RATE_LIMIT_RPM),
      burst: Math.max(1, options.contentBurst ?? DEFAULT_CONTENT_RATE_LIMIT_BURST),
    };
    this.perEndpoint = options.perEndpoint ?? {};
  }

  get requestsPerMinute(): number {
    return this.defaults.rpm;
  }

  get burstSize(): number {
    return this.defaults.burst;
  }

  get contentRequestsPerMinute(): number {
    return this.content.rpm;
  }

  get contentBurstSize(): number {
    return this.content.burst;
  }

  /** Take a token if one is available. */
  tryAcquire(endpoint?: string): boolean {
    const bucket = this.bucketFor(endpoint);
    this.refill(bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Take a token or fail loudly.
   * @throws AppError with code SUPPLIER_RATE_LIMITED
   */
  acquire(endpoint?: string): void {
    if (this.tryAcquire(endpoint)) return;
    const bucket = this.bucketFor(endpoint);
    throw new AppError(
      'SUPPLIER_RATE_LIMITED',
      `Agoda rate limit exceeded (${bucket.rpm} requests/minute, burst ${bucket.burst})`,
      { details: { rpm: bucket.rpm, burst: bucket.burst, ...(endpoint ? { endpoint } : {}) } },
    );
  }

  /** Tokens currently available (after refill) for the given endpoint. */
  available(endpoint?: string): number {
    const bucket = this.bucketFor(endpoint);
    this.refill(bucket);
    return bucket.tokens;
  }

  private bucketFor(endpoint?: string): Bucket {
    const key = endpoint ?? 'default';
    const existing = this.buckets.get(key);
    if (existing) return existing;

    const isContent = key === 'content';
    const override = this.perEndpoint[key] ?? {};
    const base = isContent ? this.content : this.defaults;
    const bucket: Bucket = {
      rpm: Math.max(1, override.rpm ?? base.rpm),
      burst: Math.max(1, override.burst ?? base.burst),
      tokens: 0,
      lastRefill: this.now(),
    };
    bucket.tokens = bucket.burst;
    this.buckets.set(key, bucket);
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const now = this.now();
    const elapsed = Math.max(0, now - bucket.lastRefill);
    if (elapsed === 0) return;
    bucket.lastRefill = now;
    const refill = (elapsed / 60_000) * bucket.rpm;
    bucket.tokens = Math.min(bucket.burst, bucket.tokens + refill);
  }
}
