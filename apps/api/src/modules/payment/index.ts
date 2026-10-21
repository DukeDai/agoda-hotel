import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { AppContext } from '../../lib/context.js';
import type { PaymentProvider } from '../../lib/payment-provider.js';
import { AppError, toAppError } from '@ota/core';
import { MockPaymentProvider } from './providers/mock.js';
import { StripePaymentProvider } from './providers/stripe.js';
import { getPaymentHooks } from '../../lib/hooks.js';

export { MockPaymentProvider } from './providers/mock.js';
export { StripePaymentProvider } from './providers/stripe.js';

export function createPaymentProvider(config: Config, logger?: AppContext['logger']): PaymentProvider {
  if (config.PAYMENT_PROVIDER === 'stripe') {
    const secretKey = process.env.STRIPE_SECRET_KEY ?? '';
    if (!secretKey) {
      throw new AppError('CONFIG_ERROR', 'PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY', {
        details: { env: 'STRIPE_SECRET_KEY' },
      });
    }
    return new StripePaymentProvider({
      secretKey,
      webhookSecret: config.PAYMENT_WEBHOOK_SECRET,
      logger,
    });
  }
  return new MockPaymentProvider({
    secret: config.PAYMENT_WEBHOOK_SECRET,
    logger,
  });
}

/**
 * Payment gateway callbacks.
 *
 * The handler is idempotent: a replayed webhook for an already-settled
 * payment is acknowledged without changing state.
 */
export async function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    '/api/v1/payments/webhook',
    {
      schema: {
        tags: ['payment'],
        description: 'Payment gateway callback. Signature-verified by the provider.',
      },
    },
    async (req, reply) => {
      const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      const signature = req.headers['x-ota-signature'] ?? req.headers['stripe-signature'];

      let event;
      try {
        event = await ctx.payment.parseWebhook(rawBody, typeof signature === 'string' ? signature : undefined);
      } catch (err) {
        throw new AppError('VALIDATION_ERROR', 'Webhook signature verification failed', {
          details: { reason: toAppError(err).message },
        });
      }

      if (!event.providerPaymentId) {
        throw new AppError('VALIDATION_ERROR', 'Webhook payload has no providerPaymentId');
      }

      if (event.type === 'refund.succeeded' || event.type === 'refund.failed') {
        const refund = await ctx.prisma.refund.findFirst({
          where: { providerRefundId: event.providerRefundId ?? undefined },
        });
        if (!refund) {
          // Unknown refund: acknowledge, do not retry forever.
          return reply.status(202).send({ received: true, applied: false });
        }
        if (refund.status === 'SUCCEEDED' || refund.status === 'FAILED') {
          return reply.status(200).send({ received: true, applied: false, replay: true });
        }
        const outcome = event.type === 'refund.succeeded' ? 'succeeded' : 'failed';
        await ctx.prisma.refund.update({
          where: { id: refund.id },
          data: {
            status: outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
            succeededAt: outcome === 'succeeded' ? ctx.now() : null,
            lastError: outcome === 'failed' ? (event.failureMessage ?? 'refund_failed') : null,
          },
        });
        await getPaymentHooks().onRefundSettled?.(
          refund.id,
          outcome,
          event.failureMessage,
        );
        return reply.status(200).send({ received: true, applied: true });
      }

      const payment = await ctx.prisma.payment.findFirst({
        where: { providerPaymentId: event.providerPaymentId },
      });
      if (!payment) {
        return reply.status(202).send({ received: true, applied: false });
      }
      if (payment.status === 'CAPTURED' || payment.status === 'REFUNDED') {
        return reply.status(200).send({ received: true, applied: false, replay: true });
      }

      const succeeded = event.type === 'payment.succeeded';
      await ctx.prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: succeeded ? 'CAPTURED' : 'FAILED',
          capturedAmount: succeeded ? payment.amount : 0,
          paidAt: succeeded ? ctx.now() : null,
          failureCode: succeeded ? null : 'gateway_failure',
          failureMessage: succeeded ? null : (event.failureMessage ?? 'payment_failed'),
        },
      });
      await getPaymentHooks().onPaymentSettled?.(
        payment.id,
        succeeded ? 'succeeded' : 'failed',
        event.failureMessage,
      );
      return reply.status(200).send({ received: true, applied: true });
    },
  );
}
