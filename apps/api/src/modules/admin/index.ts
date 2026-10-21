import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../lib/context.js';
import { syncHotelContent } from '../catalog/index.js';
import { pollPendingBookings } from '../booking/index.js';
import { processOutboxOnce } from '../notify/index.js';

/**
 * Operations surface. Deliberately small: the MVP needs visibility and manual
 * levers, not a full back office.
 */
export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.post(
    '/api/v1/admin/sync/hotels',
    {
      schema: {
        tags: ['admin'],
        body: {
          type: 'object',
          properties: {
            hotelIds: { type: 'array', items: { type: 'string' } },
            limit: { type: 'integer', minimum: 1, maximum: 5000 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const body = (req.body ?? {}) as { hotelIds?: string[]; limit?: number };
      return syncHotelContent(ctx, { hotelIds: body.hotelIds, limit: body.limit });
    },
  );

  app.get(
    '/api/v1/admin/bookings',
    {
      schema: {
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const q = req.query as { status?: string; limit?: number };
      const bookings = await ctx.prisma.booking.findMany({
        where: q.status ? { status: q.status as never } : undefined,
        orderBy: { createdAt: 'desc' },
        take: q.limit ?? 50,
        select: {
          id: true,
          orderNo: true,
          status: true,
          supplierStatus: true,
          confirmationNumber: true,
          totalAmount: true,
          currency: true,
          checkIn: true,
          checkOut: true,
          createdAt: true,
        },
      });
      return { bookings };
    },
  );

  app.get(
    '/api/v1/admin/outbox',
    {
      schema: {
        tags: ['admin'],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const q = req.query as { status?: string; limit?: number };
      const events = await ctx.prisma.outboxEvent.findMany({
        where: q.status ? { status: q.status as never } : undefined,
        orderBy: { createdAt: 'desc' },
        take: q.limit ?? 50,
        include: { deliveries: true },
      });
      return { events };
    },
  );

  app.post(
    '/api/v1/admin/outbox/drain',
    { schema: { tags: ['admin'], description: 'Force-process pending outbox events now.' } },
    async () => processOutboxOnce(ctx),
  );

  app.post(
    '/api/v1/admin/bookings/poll',
    { schema: { tags: ['admin'], description: 'Poll supplier bookings that are still processing.' } },
    async () => pollPendingBookings(ctx),
  );
}
