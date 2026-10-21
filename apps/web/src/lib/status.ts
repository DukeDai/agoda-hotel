/**
 * Order status vocabulary (SPEC §3.4) shared by the badge and the tracker.
 *
 * `BOOKING_SUBMITTED` is the supplier-processing state: the customer must see
 * 「供应商确认中」 — never 「预订成功」. Only `CONFIRMED` may claim a booking.
 */

import type { OrderStatus } from './api';

export interface StatusMeta {
  label: string;
  /** Short explanation shown next to the badge. */
  hint: string;
  tone: 'pending' | 'processing' | 'success' | 'neutral' | 'danger';
}

export const ORDER_STATUS_META: Record<OrderStatus, StatusMeta> = {
  PENDING_PAYMENT: {
    label: '待支付',
    hint: '订单已创建，请尽快完成支付以锁定价格与房量。',
    tone: 'pending',
  },
  PAID: {
    label: '已付款，等待确认',
    hint: '已收到款项，正在向供应商提交订单。',
    tone: 'processing',
  },
  BOOKING_SUBMITTED: {
    label: '供应商确认中',
    hint: '供应商正在确认房量，确认成功前暂不可视为预订成功。',
    tone: 'processing',
  },
  CONFIRMED: {
    label: '预订成功',
    hint: '供应商已确认订单，请出示确认号办理入住。',
    tone: 'success',
  },
  CHECKED_IN: {
    label: '已入住',
    hint: '客人已办理入住。',
    tone: 'success',
  },
  CHECKED_OUT: {
    label: '已离店',
    hint: '本次行程已结束。',
    tone: 'neutral',
  },
  REFUND_PENDING: {
    label: '退款处理中',
    hint: '退款已发起，到账时间以支付渠道为准。',
    tone: 'pending',
  },
  REFUNDED: {
    label: '已退款',
    hint: '款项已按取消政策退回。',
    tone: 'neutral',
  },
  CANCELLED: {
    label: '已取消',
    hint: '订单已取消。',
    tone: 'neutral',
  },
  EXPIRED: {
    label: '已过期',
    hint: '订单超时未支付，已自动关闭。',
    tone: 'danger',
  },
  FAILED: {
    label: '预订失败',
    hint: '订单未能完成，如已扣款将自动原路退回。',
    tone: 'danger',
  },
};

/** Statuses where the supplier still owes us an answer → keep polling. */
export const POLLING_STATUSES: OrderStatus[] = ['PAID', 'BOOKING_SUBMITTED'];

/** Statuses after which no further update is expected → stop polling. */
export const TERMINAL_STATUSES: OrderStatus[] = [
  'CONFIRMED',
  'CHECKED_IN',
  'CHECKED_OUT',
  'REFUND_PENDING',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
];

/** Statuses for which a cancellation request still makes sense. */
export const CANCELLABLE_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PAID',
  'BOOKING_SUBMITTED',
  'CONFIRMED',
];

export function isPollingStatus(status: OrderStatus | null | undefined): boolean {
  return status ? POLLING_STATUSES.includes(status) : false;
}

export function isTerminalStatus(status: OrderStatus | null | undefined): boolean {
  return status ? TERMINAL_STATUSES.includes(status) : false;
}

export function isCancellableStatus(status: OrderStatus | null | undefined): boolean {
  return status ? CANCELLABLE_STATUSES.includes(status) : false;
}

export function statusMeta(status: OrderStatus | null | undefined): StatusMeta {
  if (status && ORDER_STATUS_META[status]) return ORDER_STATUS_META[status];
  return {
    label: status ?? '未知状态',
    hint: '订单状态未知，请稍后刷新。',
    tone: 'neutral',
  };
}
