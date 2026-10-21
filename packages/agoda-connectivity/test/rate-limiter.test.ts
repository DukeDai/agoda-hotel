import { describe, expect, it } from 'vitest';
import { AppError } from '@ota/core';
import { TokenBucketRateLimiter } from '../src/live/rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  it('limits each endpoint independently', () => {
    let now = 1_000_000;
    const limiter = new TokenBucketRateLimiter({
      rpm: 60,
      burst: 2,
      contentRpm: 120,
      contentBurst: 10,
      now: () => now,
    });

    // The dynamic endpoint is exhausted after its burst.
    expect(limiter.tryAcquire('booking')).toBe(true);
    expect(limiter.tryAcquire('booking')).toBe(true);
    expect(limiter.tryAcquire('booking')).toBe(false);

    // A bulk content sync must NOT be able to starve the booking path, and
    // the booking path must not be able to starve the content path.
    expect(limiter.tryAcquire('content')).toBe(true);
    expect(limiter.tryAcquire('content')).toBe(true);
    expect(limiter.tryAcquire('content')).toBe(true);
    expect(limiter.tryAcquire('booking')).toBe(false);
    expect(limiter.tryAcquire('content')).toBe(true);
  });

  it('refills over time', () => {
    let now = 1_000_000;
    const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 1, now: () => now });

    expect(limiter.tryAcquire('search')).toBe(true);
    expect(limiter.tryAcquire('search')).toBe(false);

    now += 1_000; // one second → one token at 60 rpm
    expect(limiter.tryAcquire('search')).toBe(true);
  });

  it('throws SUPPLIER_RATE_LIMITED when exhausted', () => {
    const limiter = new TokenBucketRateLimiter({ rpm: 60, burst: 1 });
    limiter.acquire('precheck');
    expect(() => limiter.acquire('precheck')).toThrowError(AppError);
    try {
      limiter.acquire('precheck');
    } catch (err) {
      expect((err as AppError).code).toBe('SUPPLIER_RATE_LIMITED');
      expect((err as AppError).retryable).toBe(true);
      expect((err as AppError).details.endpoint).toBe('precheck');
    }
  });
});
