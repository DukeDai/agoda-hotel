import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@ota/core';
import type {
  CapturePaymentInput,
  CapturePaymentResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
  PaymentWebhookEvent,
  RefundInput,
  RefundResult,
} from '../../../lib/payment-provider.js';

export interface StripePaymentOptions {
  secretKey: string;
  webhookSecret: string;
  logger?: Logger;
  timeoutMs?: number;
}

/**
 * Stripe-shaped implementation using the REST API directly (no SDK).
 *
 * It is intentionally not wired into the default configuration: the MVP
 * ships with the mock gateway. This exists so that switching to real
 * payments is a configuration change, not a rewrite.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe' as const;

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly logger: Logger | undefined;
  private readonly timeoutMs: number;

  constructor(options: StripePaymentOptions) {
    this.secretKey = options.secretKey;
    this.webhookSecret = options.webhookSecret;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const body = new URLSearchParams({
      amount: String(input.amount.amount),
      currency: input.amount.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': 'true',
      description: input.description,
      'metadata[orderNo]': input.orderNo,
      'metadata[bookingId]': input.bookingId,
      'receipt_email': input.guestEmail,
    });
    const intent = await this.request('POST', '/v1/payment_intents', body, input.idempotencyKey);
    return {
      providerPaymentId: String(intent.id),
      status: intent.status === 'succeeded' ? 'SUCCEEDED' : 'REQUIRES_ACTION',
      clientSecret: typeof intent.client_secret === 'string' ? intent.client_secret : undefined,
    };
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentResult> {
    const body = new URLSearchParams({ amount_to_capture: String(input.amount.amount) });
    const intent = await this.request(
      'POST',
      `/v1/payment_intents/${encodeURIComponent(input.providerPaymentId)}/capture`,
      body,
      input.idempotencyKey,
    );
    const status = String(intent.status);
    return {
      providerPaymentId: String(intent.id),
      status: status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
      capturedAmount: status === 'succeeded' ? input.amount : undefined,
      failureCode: status === 'succeeded' ? undefined : 'stripe_' + status,
      failureMessage: intent.last_payment_error
        ? String((intent.last_payment_error as { message?: string }).message ?? status)
        : undefined,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const body = new URLSearchParams({
      payment_intent: input.providerPaymentId,
      amount: String(input.amount.amount),
      reason: 'requested_by_customer',
    });
    if (input.reason) body.set('metadata[reason]', input.reason);
    const refund = await this.request('POST', '/v1/refunds', body, input.idempotencyKey);
    const status = String(refund.status);
    return {
      providerRefundId: String(refund.id),
      status: status === 'succeeded' ? 'SUCCEEDED' : status === 'failed' ? 'FAILED' : 'PENDING',
      amount: input.amount,
      failureMessage:
        status === 'failed'
          ? String((refund.failure_reason as string | undefined) ?? 'refund_failed')
          : undefined,
    };
  }

  async parseWebhook(rawBody: string, signature: string | undefined): Promise<PaymentWebhookEvent> {
    if (!signature) throw new Error('stripe webhook: missing stripe-signature header');
    this.verifyStripeSignature(rawBody, signature);

    const event = JSON.parse(rawBody) as {
      type?: string;
      data?: { object?: Record<string, unknown> };
    };
    const obj = event.data?.object ?? {};
    const providerPaymentId = String(obj.payment_intent ?? obj.id ?? '');

    switch (event.type) {
      case 'payment_intent.succeeded':
        return { providerPaymentId, type: 'payment.succeeded', raw: event };
      case 'payment_intent.payment_failed':
        return {
          providerPaymentId,
          type: 'payment.failed',
          failureMessage: String(
            (obj.last_payment_error as { message?: string } | undefined)?.message ?? 'payment_failed',
          ),
          raw: event,
        };
      case 'charge.refunded':
        return { providerPaymentId, type: 'refund.succeeded', raw: event };
      case 'refund.failed':
        return { providerPaymentId, type: 'refund.failed', raw: event };
      default:
        throw new Error(`stripe webhook: unsupported type ${String(event.type)}`);
    }
  }

  /** Stripe scheme: `t=<ts>,v1=<hmac>` over `${timestamp}.${payload}`. */
  verifyStripeSignature(rawBody: string, signatureHeader: string): boolean {
    const parts = signatureHeader.split(',');
    let timestamp = '';
    const v1: string[] = [];
    for (const part of parts) {
      const [k, v] = part.split('=');
      if (k === 't') timestamp = v ?? '';
      if (k === 'v1' && v) v1.push(v);
    }
    if (!timestamp || v1.length === 0) return false;

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    return v1.some((candidate) => {
      const a = Buffer.from(expected);
      const b = Buffer.from(candidate);
      return a.length === b.length && timingSafeEqual(a, b);
    });
  }

  private async request(
    method: 'POST' | 'GET',
    path: string,
    body: URLSearchParams | undefined,
    idempotencyKey: string,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`https://api.stripe.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: body?.toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      this.logger?.error('stripe request failed', { status: res.status, path });
      throw new Error(`stripe request failed with status ${res.status}: ${text.slice(0, 200)}`);
    }
    return json;
  }
}
