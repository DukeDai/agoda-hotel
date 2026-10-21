/**
 * Booking & payment state machines.
 *
 * Transitions are explicit and enforced. A booking that is not CONFIRMED
 * must never be reported to the customer as confirmed — Agoda returns
 * `processing: true` for a while, and only then a terminal status.
 */

import { AppError } from './errors.js';

export const BOOKING_STATUS = {
  /** Order created, waiting for the customer to pay. */
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  /** Money captured on our side; not yet sent to the supplier. */
  PAID: 'PAID',
  /** Booking request in flight towards the supplier. */
  BOOKING_SUBMITTED: 'BOOKING_SUBMITTED',
  /** Supplier confirmed. Safe to tell the customer the room is secured. */
  CONFIRMED: 'CONFIRMED',
  /** Guest checked in. */
  CHECKED_IN: 'CHECKED_IN',
  /** Guest checked out. */
  CHECKED_OUT: 'CHECKED_OUT',
  /** Cancellation accepted, refund pending. */
  REFUND_PENDING: 'REFUND_PENDING',
  /** Money returned to the customer. Terminal. */
  REFUNDED: 'REFUNDED',
  /** Cancelled before any money moved. Terminal. */
  CANCELLED: 'CANCELLED',
  /** Payment expired / abandoned. Terminal. */
  EXPIRED: 'EXPIRED',
  /** Booking attempt failed terminally (sold out, rejected...). Terminal. */
  FAILED: 'FAILED',
} as const;

export type BookingStatus = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];

const BOOKING_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  PENDING_PAYMENT: ['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'],
  PAID: ['BOOKING_SUBMITTED', 'FAILED', 'REFUND_PENDING'],
  // A transient supplier failure sends the order back to PAID: the money is
  // still ours, the poller replays the same idempotency key.
  BOOKING_SUBMITTED: ['CONFIRMED', 'FAILED', 'REFUND_PENDING', 'PAID'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'REFUND_PENDING'],
  CHECKED_IN: ['CHECKED_OUT', 'REFUND_PENDING'],
  CHECKED_OUT: ['REFUND_PENDING'],
  REFUND_PENDING: ['REFUNDED', 'FAILED'],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: [],
  // A failed booking can still be refunded — that is exactly what the
  // automatic refund does.
  FAILED: ['REFUNDED'],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalBookingStatus(status: BookingStatus): boolean {
  return (BOOKING_TRANSITIONS[status]?.length ?? 0) === 0;
}

export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransition(from, to)) {
    // A stable error code, not a bare Error: the API turns this into a 409
    // with a machine-readable body instead of a 500.
    throw new AppError('INVALID_STATE', `订单状态不能从 ${from} 变更为 ${to}`, {
      details: { from, to },
    });
  }
}

export const BOOKING_STATUS_VALUES = Object.values(BOOKING_STATUS) as BookingStatus[];

// --- Payment ---------------------------------------------------------------

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  REQUIRES_ACTION: 'REQUIRES_ACTION',
  CAPTURED: 'CAPTURED',
  FAILED: 'FAILED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const PAYMENT_STATUS_VALUES = Object.values(PAYMENT_STATUS) as PaymentStatus[];

// --- Refund ----------------------------------------------------------------

export const REFUND_STATUS = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
} as const;

export type RefundStatus = (typeof REFUND_STATUS)[keyof typeof REFUND_STATUS];

export const REFUND_STATUS_VALUES = Object.values(REFUND_STATUS) as RefundStatus[];

// --- Notification delivery -------------------------------------------------

export const DELIVERY_STATUS = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  DEAD: 'DEAD',
} as const;

export type DeliveryStatus = (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

export const DELIVERY_STATUS_VALUES = Object.values(DELIVERY_STATUS) as DeliveryStatus[];

/** A channel that already exhausted its attempts is escalated to ops. */
export function isEscalated(status: DeliveryStatus, attempts: number, threshold: number): boolean {
  return (status === 'FAILED' || status === 'DEAD') && attempts >= threshold;
}
