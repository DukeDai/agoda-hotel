import type { FastifyInstance } from 'fastify';
import { AppError } from '@ota/core';
import type { AppContext } from '../../lib/context.js';

/**
 * Operations surface for notifications.
 *
 * Three levers: look at the deliveries, look at what was escalated, and
 * replay a dead delivery by hand. The replay is the manual counterpart of the
 * automatic re-report.
 */

const DELIVERY_SELECT = {
  outbox: {
    select: {
      id: true,
      topic: true,
      aggregateType: true,
      aggregateId: true,
      status: true,
    },
  },
} as const;

export async function registerNotifyRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/notifications/deliveries',
    {
      schema: {
        tags: ['notify'],
        description: 'Notification deliveries, newest first.',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            channel: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const q = req.query as { status?: string; channel?: string; limit?: number };
      const deliveries = await ctx.prisma.notificationDelivery.findMany({
        where: {
          ...(q.status ? { status: q.status as never } : {}),
          ...(q.channel ? { channel: q.channel } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit ?? 50,
        include: DELIVERY_SELECT,
      });
      return { deliveries };
    },
  );

  app.get(
    '/api/v1/notifications/escalations',
    {
      schema: {
        tags: ['notify'],
        description: 'Deliveries that were automatically reported to ops.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const q = req.query as { limit?: number };
      const escalations = await ctx.prisma.notificationDelivery.findMany({
        where: { escalatedAt: { not: null } },
        orderBy: { escalatedAt: 'desc' },
        take: q.limit ?? 50,
        include: DELIVERY_SELECT,
      });
      return { escalations };
    },
  );

  app.post(
    '/api/v1/notifications/replay',
    {
      schema: {
        tags: ['notify'],
        description: 'Requeue a dead or failed delivery.',
        body: {
          type: 'object',
          properties: {
            deliveryId: { type: 'string' },
            outboxId: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const body = (req.body ?? {}) as { deliveryId?: string; outboxId?: string };
      if (!body.deliveryId && !body.outboxId) {
        throw new AppError('VALIDATION_ERROR', 'deliveryId or outboxId is required');
      }

      const now = ctx.now();
      const reset = {
        status: 'PENDING' as const,
        attempts: 0,
        escalatedAt: null,
        nextAttemptAt: now,
        lastError: null,
      };

      if (body.deliveryId) {
        const delivery = await ctx.prisma.notificationDelivery.findUnique({
          where: { id: body.deliveryId },
        });
        if (!delivery) {
          throw new AppError('NOT_FOUND', `delivery ${body.deliveryId} not found`);
        }
        if (delivery.status === 'SENT') {
          throw new AppError('CONFLICT', `delivery ${body.deliveryId} is already sent`);
        }
        const updated = await ctx.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: reset,
        });
        await requeueEvent(ctx, delivery.outboxId, now);
        return { replayed: 1, deliveries: [updated] };
      }

      const outboxId = body.outboxId as string;
      const event = await ctx.prisma.outboxEvent.findUnique({ where: { id: outboxId } });
      if (!event) {
        throw new AppError('NOT_FOUND', `outbox event ${outboxId} not found`);
      }
      const replayed = await ctx.prisma.notificationDelivery.updateMany({
        where: { outboxId, status: { in: ['DEAD', 'FAILED'] } },
        data: reset,
      });
      await requeueEvent(ctx, outboxId, now);
      return { replayed: replayed.count, deliveries: [] };
    },
  );
}

/** Put the parent event back in the queue so the pump picks the delivery up. */
async function requeueEvent(ctx: AppContext, outboxId: string, now: Date): Promise<void> {
  await ctx.prisma.outboxEvent.updateMany({
    where: { id: outboxId },
    data: { status: 'PENDING', availableAt: now, lastError: null },
  });
}
