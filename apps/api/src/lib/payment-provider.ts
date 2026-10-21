import type { Currency, Money } from '@ota/core';

/**
 * Payment provider port.
 *
 * The business layer never talks to a concrete PSP directly. MVP ships a
 * `mock` implementation that behaves like a real gateway (async settlement,
 * webhooks, failures, timeouts) plus a `stripe`-shaped implementation slot.
 */
export type PaymentProviderName = 'mock' | 'stripe';

export type PaymentIntentStatus = 'REQUIRES_ACTION' | 'SUCCEEDED' | 'FAILED';

export interface CreatePaymentInput {
  bookingId: string;
  orderNo: string;
  amount: Money;
  currency: Currency;
  /** Idempotency key that must be forwarded to the PSP verbatim. */
  idempotencyKey: string;
  guestEmail: string;
  description: string;
  /** Payment method token, e.g. `mock_card` / `mock_card_decline`. */
  method?: string;
  metadata?: Record<string, string>;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  status: PaymentIntentStatus;
  /** Present when the provider needs a redirect/SDK step. */
  clientSecret?: string;
  /** Where the customer should go to pay, for redirect flows. */
  redirectUrl?: string;
}

export interface CapturePaymentInput {
  providerPaymentId: string;
  amount: Money;
  idempotencyKey: string;
}

export interface CapturePaymentResult {
  providerPaymentId: string;
  status: PaymentIntentStatus;
  capturedAmount?: Money;
  failureCode?: string;
  failureMessage?: string;
}

export interface RefundInput {
  providerPaymentId: string;
  amount: Money;
  reason?: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'PENDING';
  amount: Money;
  failureMessage?: string;
}

export interface PaymentWebhookEvent {
  providerPaymentId: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed';
  amount?: Money;
  providerRefundId?: string;
  failureMessage?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: PaymentProviderName;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  capturePayment(input: CapturePaymentInput): Promise<CapturePaymentResult>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Verify the webhook signature and normalise the event. */
  parseWebhook(rawBody: string, signature: string | undefined): Promise<PaymentWebhookEvent>;
}
