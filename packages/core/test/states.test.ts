import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  BOOKING_STATUS,
  BOOKING_STATUS_VALUES,
  DELIVERY_STATUS,
  DELIVERY_STATUS_VALUES,
  PAYMENT_STATUS,
  PAYMENT_STATUS_VALUES,
  REFUND_STATUS,
  REFUND_STATUS_VALUES,
  assertBookingTransition,
  canTransition,
  isEscalated,
  isTerminalBookingStatus,
} from '../src/states.js';
import type { BookingStatus } from '../src/states.js';

/**
 * 保护订单状态机（states.ts）的规则：
 *  1. 迁移必须显式声明。没写进白名单的迁移一律非法。
 *  2. 非 CONFIRMED 的订单绝不能被当成已确认——状态机是这条约束的唯一守卫。
 *  3. 非法迁移必须抛带稳定错误码（INVALID_STATE）的 AppError，而不是裸 Error。
 *  4. 终态（REFUNDED / CANCELLED / EXPIRED）不可再迁移；
 *     FAILED 不是终态——失败的订单仍要走自动退款。
 *  5. 通知通道重试耗尽后才升级到人工。
 */

describe('canTransition() — 合法迁移', () => {
  it('走通付款主链路', () => {
    expect(canTransition('PENDING_PAYMENT', 'PAID')).toBe(true);
    expect(canTransition('PAID', 'BOOKING_SUBMITTED')).toBe(true);
    expect(canTransition('BOOKING_SUBMITTED', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'CHECKED_IN')).toBe(true);
    expect(canTransition('CHECKED_IN', 'CHECKED_OUT')).toBe(true);
  });

  it('允许取消与退款分支', () => {
    expect(canTransition('PENDING_PAYMENT', 'CANCELLED')).toBe(true);
    expect(canTransition('CONFIRMED', 'CANCELLED')).toBe(true);
    expect(canTransition('CONFIRMED', 'REFUND_PENDING')).toBe(true);
    expect(canTransition('REFUND_PENDING', 'REFUNDED')).toBe(true);
  });

  it('供应商瞬时失败允许从 BOOKING_SUBMITTED 退回 PAID 重放同一幂等键', () => {
    expect(canTransition('BOOKING_SUBMITTED', 'PAID')).toBe(true);
  });

  it('失败的订单仍可进入退款流程', () => {
    expect(canTransition('FAILED', 'REFUNDED')).toBe(true);
  });
});

describe('canTransition() — 非法迁移', () => {
  it('未付款不能直接确认', () => {
    expect(canTransition('PENDING_PAYMENT', 'CONFIRMED')).toBe(false);
    expect(canTransition('PENDING_PAYMENT', 'BOOKING_SUBMITTED')).toBe(false);
  });

  it('不能回退到更早的状态', () => {
    expect(canTransition('CONFIRMED', 'PENDING_PAYMENT')).toBe(false);
    expect(canTransition('CONFIRMED', 'PAID')).toBe(false);
    expect(canTransition('CONFIRMED', 'BOOKING_SUBMITTED')).toBe(false);
  });

  it('不能跳过 BOOKING_SUBMITTED 直接确认', () => {
    expect(canTransition('PAID', 'CONFIRMED')).toBe(false);
  });

  it('不能从 CHECKED_OUT 回到 CHECKED_IN', () => {
    expect(canTransition('CHECKED_OUT', 'CHECKED_IN')).toBe(false);
  });
});

describe('assertBookingTransition() — 迁移断言', () => {
  it('合法迁移不抛错', () => {
    expect(() => assertBookingTransition('PENDING_PAYMENT', 'PAID')).not.toThrow();
  });

  it('非法迁移抛 INVALID_STATE 错误（稳定错误码，而不是裸 Error）', () => {
    let caught: unknown;
    try {
      assertBookingTransition('PENDING_PAYMENT', 'CONFIRMED');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AppError);
    const appError = caught as AppError;
    expect(appError.code).toBe('INVALID_STATE');
    expect(appError.status).toBe(409);
    expect(appError.retryable).toBe(false);
    expect(appError.details).toEqual({ from: 'PENDING_PAYMENT', to: 'CONFIRMED' });
    expect(appError.message).toContain('PENDING_PAYMENT');
    expect(appError.message).toContain('CONFIRMED');
  });
});

describe('isTerminalBookingStatus() — 终态判定', () => {
  it('终态为 true：钱已退、已取消、已过期', () => {
    expect(isTerminalBookingStatus('REFUNDED')).toBe(true);
    expect(isTerminalBookingStatus('CANCELLED')).toBe(true);
    expect(isTerminalBookingStatus('EXPIRED')).toBe(true);
  });

  it('FAILED 不是终态——失败的订单仍可退款', () => {
    expect(isTerminalBookingStatus('FAILED')).toBe(false);
    expect(canTransition('FAILED', 'REFUNDED')).toBe(true);
  });

  it('非终态为 false', () => {
    expect(isTerminalBookingStatus('PENDING_PAYMENT')).toBe(false);
    expect(isTerminalBookingStatus('PAID')).toBe(false);
    expect(isTerminalBookingStatus('BOOKING_SUBMITTED')).toBe(false);
    expect(isTerminalBookingStatus('CONFIRMED')).toBe(false);
    expect(isTerminalBookingStatus('CHECKED_IN')).toBe(false);
    expect(isTerminalBookingStatus('CHECKED_OUT')).toBe(false);
    expect(isTerminalBookingStatus('REFUND_PENDING')).toBe(false);
  });
});

describe('状态机整体不变量', () => {
  const TERMINAL: BookingStatus[] = ['REFUNDED', 'CANCELLED', 'EXPIRED'];

  it('终态不能迁出到任何状态', () => {
    for (const from of TERMINAL) {
      for (const to of BOOKING_STATUS_VALUES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('不能迁回自身', () => {
    for (const status of BOOKING_STATUS_VALUES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('除 CONFIRMED 外，没有任何状态可以直接到 CHECKED_IN', () => {
    const toCheckedIn = BOOKING_STATUS_VALUES.filter((s) => canTransition(s, 'CHECKED_IN'));
    expect(toCheckedIn).toEqual(['CONFIRMED']);
  });

  it('状态枚举与值列表一一对应', () => {
    expect(BOOKING_STATUS_VALUES.length).toBe(Object.keys(BOOKING_STATUS).length);
    expect(BOOKING_STATUS.PENDING_PAYMENT).toBe('PENDING_PAYMENT');
    expect(BOOKING_STATUS.BOOKING_SUBMITTED).toBe('BOOKING_SUBMITTED');
  });
});

describe('isEscalated() — 通知通道升级判定', () => {
  it('失败或死亡且达到阈值才升级', () => {
    expect(isEscalated('FAILED', 3, 2)).toBe(true);
    expect(isEscalated('DEAD', 2, 2)).toBe(true);
  });

  it('未达阈值不升级', () => {
    expect(isEscalated('FAILED', 1, 2)).toBe(false);
    expect(isEscalated('DEAD', 1, 3)).toBe(false);
  });

  it('成功或待发送的通道不升级', () => {
    expect(isEscalated('SENT', 5, 2)).toBe(false);
    expect(isEscalated('PENDING', 5, 2)).toBe(false);
  });
});

describe('状态枚举导出', () => {
  it('支付 / 退款 / 投递状态值完整', () => {
    expect(PAYMENT_STATUS_VALUES).toEqual(['PENDING', 'REQUIRES_ACTION', 'CAPTURED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
    expect(REFUND_STATUS_VALUES).toEqual(['PENDING', 'SUCCEEDED', 'FAILED']);
    expect(DELIVERY_STATUS_VALUES).toEqual(['PENDING', 'SENT', 'FAILED', 'DEAD']);
    expect(PAYMENT_STATUS.CAPTURED).toBe('CAPTURED');
    expect(REFUND_STATUS.SUCCEEDED).toBe('SUCCEEDED');
    expect(DELIVERY_STATUS.DEAD).toBe('DEAD');
  });
});
