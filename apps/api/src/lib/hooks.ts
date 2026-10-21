/**
 * Cross-module callbacks.
 *
 * Modules must not import each other's internals. When the payment gateway
 * confirms a payment out-of-band, the booking module registers a callback
 * here instead of the payment module importing booking code (which would
 * create an import cycle).
 */
export interface PaymentHooks {
  /** Called after a payment is captured, successfully or not. */
  onPaymentSettled?(paymentId: string, outcome: 'succeeded' | 'failed', message?: string): Promise<void>;
  /** Called after a refund reaches a terminal state. */
  onRefundSettled?(refundId: string, outcome: 'succeeded' | 'failed', message?: string): Promise<void>;
}

const hooks: PaymentHooks = {};

export function registerPaymentHooks(next: PaymentHooks): void {
  hooks.onPaymentSettled = next.onPaymentSettled;
  hooks.onRefundSettled = next.onRefundSettled;
}

export function getPaymentHooks(): PaymentHooks {
  return hooks;
}
