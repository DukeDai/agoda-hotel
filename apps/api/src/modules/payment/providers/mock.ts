import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

export interface MockPaymentOptions {
  secret: string;
  logger?: Logger;
  /** Simulated gateway latency. */
  delayMs?: number;
}

/**
 * In-process payment gateway used in development and in the MVP demo.
 *
 * It behaves like a real gateway in the ways that matter for the business
 * layer: intents are created first, capture is a separate call, refunds are
 * independent records, and every inbound webhook is signature-verified.
 *
 * `mock_card_decline` as the payment method makes the capture fail, so the
 * "payment failed" path can be demonstrated end to end.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  private readonly secret: string;
  private readonly logger: Logger | undefined;
  private readonly delayMs: number;
  /** Intents that should decline on capture, keyed by provider payment id. */
  private readonly declining = new Set<string>();

  constructor(options: MockPaymentOptions) {
    this.secret = options.secret;
    this.logger = options.logger;
    this.delayMs = options.delayMs ?? 0;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    await this.wait();
    const id = `mock_pi_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    if (input.method === 'mock_card_decline') {
      this.declining.add(id);
    }
    this.logger?.info('mock payment intent created', { providerPaymentId: id, amount: input.amount.amount });
    return {
      providerPaymentId: id,
      status: 'REQUIRES_ACTION',
      clientSecret: `${id}_secret_${randomUUID().slice(0, 8)}`,
    };
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentResult> {
    await this.wait();
    if (this.declining.has(input.providerPaymentId)) {
      this.declining.delete(input.providerPaymentId);
      return {
        providerPaymentId: input.providerPaymentId,
        status: 'FAILED',
        failureCode: 'card_declined',
        failureMessage: '测试支付：卡片被拒绝',
      };
    }
    this.logger?.info('mock payment captured', {
      providerPaymentId: input.providerPaymentId,
      amount: input.amount.amount,
    });
    return {
      providerPaymentId: input.providerPaymentId,
      status: 'SUCCEEDED',
      capturedAmount: input.amount,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    await this.wait();
    this.logger?.info('mock refund succeeded', {
      providerPaymentId: input.providerPaymentId,
      amount: input.amount.amount,
    });
    return {
      providerRefundId: `mock_re_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      status: 'SUCCEEDED',
      amount: input.amount,
    };
  }

  async parseWebhook(rawBody: string, signature: string | undefined): Promise<PaymentWebhookEvent> {
    if (!signature || !this.verifySignature(rawBody, signature)) {
      throw new Error('mock webhook signature verification failed');
    }
    const parsed = JSON.parse(rawBody) as {
      type?: string;
      providerPaymentId?: string;
      providerRefundId?: string;
      amount?: { amount: number; currency: string };
      failureMessage?: string;
    };
    const type = parsed.type;
    if (
      type !== 'payment.succeeded' &&
      type !== 'payment.failed' &&
      type !== 'refund.succeeded' &&
      type !== 'refund.failed'
    ) {
      throw new Error(`mock webhook: unsupported type ${String(type)}`);
    }
    return {
      providerPaymentId: parsed.providerPaymentId ?? '',
      type,
      providerRefundId: parsed.providerRefundId,
      amount: parsed.amount
        ? { amount: parsed.amount.amount, currency: parsed.amount.currency as never }
        : undefined,
      failureMessage: parsed.failureMessage,
      raw: parsed,
    };
  }

  /** Build the signature a caller must present for a given body. */
  sign(rawBody: string): string {
    return `sha256=${createHmac('sha256', this.secret).update(rawBody).digest('hex')}`;
  }

  verifySignature(rawBody: string, signature: string): boolean {
    const expected = this.sign(rawBody);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private wait(): Promise<void> {
    if (this.delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }
}
