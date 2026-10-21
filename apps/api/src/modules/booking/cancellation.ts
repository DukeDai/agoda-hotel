import type { Currency, LocalDate, Money } from '@ota/core';
import { money } from '@ota/core';

/**
 * Cancellation policy evaluation.
 *
 * Pure functions on purpose: the rules are the part of the booking engine
 * that is easiest to get subtly wrong, so they must be unit-testable
 * without a database or a supplier.
 */

export type PolicyType = 'FULL_REFUND' | 'PARTIAL_REFUND' | 'NON_REFUNDABLE';

export interface CancellationInput {
  policyType: PolicyType;
  /** Last day (property local) on which a free cancellation is allowed. */
  freeCancellationUntil?: LocalDate | null;
  /** Flat amount kept by the supplier, in minor units. */
  penaltyAmount?: number | null;
  /** Percentage of the stay price kept by the supplier. */
  penaltyPercent?: number | null;
  /** Total paid for the stay, in minor units. */
  totalAmount: number;
  currency: Currency;
  /** Today, in property local time. */
  today: LocalDate;
  checkIn: LocalDate;
  policyDescription?: string | null;
}

export interface CancellationOutcome {
  allowed: boolean;
  policyType: PolicyType;
  penaltyAmount: Money;
  refundAmount: Money;
  /** Machine-readable reason when `allowed` is false. */
  reason?:
    | 'ALREADY_CHECKED_IN'
    | 'NON_REFUNDABLE'
    | 'FREE_CANCELLATION_WINDOW_PASSED'
    | 'NO_REFUND_LEFT';
  message: string;
}

function isBeforeOrEqual(a: LocalDate, b: LocalDate): boolean {
  return a <= b;
}

export function evaluateCancellation(input: CancellationInput): CancellationOutcome {
  const total = money(input.totalAmount, input.currency);
  const zero = money(0, input.currency);
  const description = input.policyDescription ?? '';

  // The guest is already in the house: nothing to cancel.
  if (!isBeforeOrEqual(input.today, input.checkIn)) {
    return {
      allowed: false,
      policyType: input.policyType,
      penaltyAmount: total,
      refundAmount: zero,
      reason: 'ALREADY_CHECKED_IN',
      message: '入住已开始，无法取消该订单。',
    };
  }

  if (input.policyType === 'NON_REFUNDABLE') {
    return {
      allowed: false,
      policyType: input.policyType,
      penaltyAmount: total,
      refundAmount: zero,
      reason: 'NON_REFUNDABLE',
      message: description || '该价格方案不可取消。',
    };
  }

  if (input.policyType === 'FULL_REFUND') {
    const deadline = input.freeCancellationUntil;
    if (deadline && isBeforeOrEqual(input.today, deadline)) {
      return {
        allowed: true,
        policyType: input.policyType,
        penaltyAmount: zero,
        refundAmount: total,
        message: `可在 ${deadline} 前免费取消，全额退款。`,
      };
    }
    return {
      allowed: false,
      policyType: input.policyType,
      penaltyAmount: total,
      refundAmount: zero,
      reason: 'FREE_CANCELLATION_WINDOW_PASSED',
      message: deadline
        ? `免费取消截止日期 ${deadline} 已过，无法取消。`
        : '该价格方案已不可取消。',
    };
  }

  // PARTIAL_REFUND: a penalty always applies, and the remainder is refunded.
  const penaltyFromPercent =
    input.penaltyPercent !== null && input.penaltyPercent !== undefined
      ? Math.round((input.totalAmount * input.penaltyPercent) / 100)
      : undefined;
  const penalty = input.penaltyAmount ?? penaltyFromPercent ?? 0;
  const refund = Math.max(0, input.totalAmount - penalty);

  if (refund <= 0) {
    return {
      allowed: false,
      policyType: input.policyType,
      penaltyAmount: total,
      refundAmount: zero,
      reason: 'NO_REFUND_LEFT',
      message: description || '取消该订单不产生退款。',
    };
  }

  return {
    allowed: true,
    policyType: input.policyType,
    penaltyAmount: money(penalty, input.currency),
    refundAmount: money(refund, input.currency),
    message: description
      ? `取消将收取罚金，退还部分房费。${description}`
      : '取消将收取罚金，其余房费退还。',
  };
}
