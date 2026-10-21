import { describe, expect, it } from 'vitest';
import { AppError, toAppError, validationError } from '../src/errors.js';

/**
 * 保护错误分类真源（errors.ts）的规则：
 *  1. 每个错误都有稳定的机器可读 `code`，下游只认 code，不认文案。
 *  2. HTTP status 与 retryable 有默认映射，调用方可以显式覆盖。
 *  3. 任何 thrown 值都能被 toAppError 归一化成 AppError，不会漏成裸 Error。
 */

describe('AppError — 默认 status 映射', () => {
  it('输入类错误返回 4xx', () => {
    expect(new AppError('VALIDATION_ERROR', 'x').status).toBe(400);
    expect(new AppError('IDEMPOTENCY_CONFLICT', 'x').status).toBe(409);
    expect(new AppError('HOTEL_NOT_FOUND', 'x').status).toBe(404);
    expect(new AppError('ROOM_NOT_FOUND', 'x').status).toBe(404);
    expect(new AppError('RATE_PLAN_NOT_FOUND', 'x').status).toBe(404);
    expect(new AppError('NOT_FOUND', 'x').status).toBe(404);
    expect(new AppError('CONFLICT', 'x').status).toBe(409);
  });

  it('供应商错误返回 5xx / 429', () => {
    expect(new AppError('SUPPLIER_TIMEOUT', 'x').status).toBe(504);
    expect(new AppError('SUPPLIER_ERROR', 'x').status).toBe(502);
    expect(new AppError('SUPPLIER_AUTH_ERROR', 'x').status).toBe(502);
    expect(new AppError('SUPPLIER_RATE_LIMITED', 'x').status).toBe(429);
  });

  it('业务与支付错误的状态码', () => {
    expect(new AppError('ROOM_UNAVAILABLE', 'x').status).toBe(409);
    expect(new AppError('PRICE_CHANGED', 'x').status).toBe(409);
    expect(new AppError('DUPLICATE_BOOKING', 'x').status).toBe(409);
    expect(new AppError('BOOKING_REJECTED', 'x').status).toBe(409);
    expect(new AppError('INVALID_STATE', 'x').status).toBe(409);
    expect(new AppError('BOOKING_NOT_CONFIRMED', 'x').status).toBe(409);
    expect(new AppError('CANCEL_NOT_ALLOWED', 'x').status).toBe(409);
    expect(new AppError('PAYMENT_FAILED', 'x').status).toBe(402);
    expect(new AppError('PAYMENT_PENDING', 'x').status).toBe(202);
    expect(new AppError('INTERNAL_ERROR', 'x').status).toBe(500);
    expect(new AppError('CONFIG_ERROR', 'x').status).toBe(500);
    expect(new AppError('REFUND_FAILED', 'x').status).toBe(500);
  });
});

describe('AppError — 默认 retryable 映射', () => {
  it('只有瞬时故障可重试', () => {
    expect(new AppError('SUPPLIER_TIMEOUT', 'x').retryable).toBe(true);
    expect(new AppError('SUPPLIER_RATE_LIMITED', 'x').retryable).toBe(true);
    expect(new AppError('SUPPLIER_ERROR', 'x').retryable).toBe(true);
    expect(new AppError('REFUND_FAILED', 'x').retryable).toBe(true);
    expect(new AppError('INTERNAL_ERROR', 'x').retryable).toBe(true);
  });

  it('业务错误不可重试', () => {
    expect(new AppError('VALIDATION_ERROR', 'x').retryable).toBe(false);
    expect(new AppError('ROOM_UNAVAILABLE', 'x').retryable).toBe(false);
    expect(new AppError('PRICE_CHANGED', 'x').retryable).toBe(false);
    expect(new AppError('DUPLICATE_BOOKING', 'x').retryable).toBe(false);
    expect(new AppError('BOOKING_REJECTED', 'x').retryable).toBe(false);
    expect(new AppError('INVALID_STATE', 'x').retryable).toBe(false);
    expect(new AppError('BOOKING_NOT_CONFIRMED', 'x').retryable).toBe(false);
    expect(new AppError('CANCEL_NOT_ALLOWED', 'x').retryable).toBe(false);
    expect(new AppError('PAYMENT_FAILED', 'x').retryable).toBe(false);
    expect(new AppError('PAYMENT_PENDING', 'x').retryable).toBe(false);
    expect(new AppError('SUPPLIER_AUTH_ERROR', 'x').retryable).toBe(false);
    expect(new AppError('IDEMPOTENCY_CONFLICT', 'x').retryable).toBe(false);
    expect(new AppError('NOT_FOUND', 'x').retryable).toBe(false);
    expect(new AppError('CONFLICT', 'x').retryable).toBe(false);
  });
});

describe('AppError — 显式覆盖与元数据', () => {
  it('options 可以覆盖 status 与 retryable', () => {
    const e = new AppError('VALIDATION_ERROR', 'bad', { status: 422, retryable: true });
    expect(e.status).toBe(422);
    expect(e.retryable).toBe(true);
  });

  it('details 默认空对象', () => {
    expect(new AppError('VALIDATION_ERROR', 'x').details).toEqual({});
    expect(new AppError('VALIDATION_ERROR', 'x', { details: { field: 'email' } }).details).toEqual({
      field: 'email',
    });
  });

  it('name 与 code 稳定', () => {
    const e = new AppError('PRICE_CHANGED', 'price moved');
    expect(e.name).toBe('AppError');
    expect(e.code).toBe('PRICE_CHANGED');
    expect(e.message).toBe('price moved');
    expect(e instanceof Error).toBe(true);
  });

  it('cause 被保留', () => {
    const cause = new Error('root');
    expect(new AppError('INTERNAL_ERROR', 'x', { cause }).cause).toBe(cause);
  });
});

describe('AppError.toJSON()', () => {
  it('输出稳定的错误信封', () => {
    const e = new AppError('BOOKING_NOT_CONFIRMED', 'not confirmed yet', {
      details: { bookingId: 'b_1' },
    });
    expect(e.toJSON()).toEqual({
      error: {
        code: 'BOOKING_NOT_CONFIRMED',
        message: 'not confirmed yet',
        retryable: false,
        details: { bookingId: 'b_1' },
      },
    });
  });
});

describe('AppError.is()', () => {
  it('只认自家实例', () => {
    expect(AppError.is(new AppError('INTERNAL_ERROR', 'x'))).toBe(true);
    expect(AppError.is(new Error('x'))).toBe(false);
    expect(AppError.is('x')).toBe(false);
    expect(AppError.is(null)).toBe(false);
  });
});

describe('toAppError() — 归一化', () => {
  it('已经是 AppError 时原样返回同一实例', () => {
    const original = new AppError('PRICE_CHANGED', 'price moved');
    expect(toAppError(original)).toBe(original);
  });

  it('普通 Error 归一化为 INTERNAL_ERROR 并保留 message 与 cause', () => {
    const original = new Error('boom');
    const converted = toAppError(original);
    expect(converted).toBeInstanceOf(AppError);
    expect(converted.code).toBe('INTERNAL_ERROR');
    expect(converted.message).toBe('boom');
    expect(converted.status).toBe(500);
    expect(converted.retryable).toBe(true);
    expect(converted.cause).toBe(original);
  });

  it('非 Error 值用 String() 归一化', () => {
    expect(toAppError('boom').message).toBe('boom');
    expect(toAppError('boom').code).toBe('INTERNAL_ERROR');
    expect(toAppError(42).message).toBe('42');
    expect(toAppError(null).message).toBe('null');
    expect(toAppError(undefined).message).toBe('undefined');
    expect(toAppError({ a: 1 }).message).toBe('[object Object]');
  });

  it('归一化后始终是 AppError', () => {
    expect(toAppError('x')).toBeInstanceOf(AppError);
    expect(toAppError({})).toBeInstanceOf(AppError);
    expect(toAppError(new TypeError('nope'))).toBeInstanceOf(AppError);
  });
});

describe('validationError()', () => {
  it('构造 VALIDATION_ERROR 并带 details', () => {
    const e = validationError('email required', { field: 'email' });
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.status).toBe(400);
    expect(e.retryable).toBe(false);
    expect(e.message).toBe('email required');
    expect(e.details).toEqual({ field: 'email' });
  });

  it('details 可省略', () => {
    expect(validationError('bad').details).toEqual({});
  });
});
