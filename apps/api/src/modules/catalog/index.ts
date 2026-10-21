import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../lib/context.js';
import { syncHotelContent, type SyncSummary } from './sync.js';
import { getHotelDetail, type HotelDetailView } from './detail.js';

export type { SyncSummary } from './sync.js';
export { syncHotelContent } from './sync.js';
export { computeContentHash } from './hash.js';
export { slugify, uniqueSlug } from './slug.js';
export {
  dateOnly,
  hotelContentData,
  replaceHotelChildren,
  upsertHotelContent,
  upsertHotelFromSummary,
  upsertRatePlan,
  upsertRoomType,
} from './persist.js';
export type { HotelDetailView } from './detail.js';
export { getHotelDetail } from './detail.js';

/**
 * Catalog routes: the operations surface of the content sync plus the static
 * hotel document the C-end renders.
 */
export async function registerCatalogRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/admin/sync/jobs',
    {
      schema: {
        tags: ['admin'],
        description: '最近的静态资源同步任务。',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      const q = req.query as { limit?: number };
      const jobs = await ctx.prisma.syncJob.findMany({
        orderBy: { startedAt: 'desc' },
        take: q.limit ?? 50,
        select: {
          id: true,
          type: true,
          status: true,
          total: true,
          processed: true,
          failed: true,
          error: true,
          startedAt: true,
          finishedAt: true,
        },
      });
      return { jobs };
    },
  );

  app.post(
    '/api/v1/admin/sync/hotels/:supplierHotelId',
    {
      schema: {
        tags: ['admin'],
        description: '同步单个酒店的静态资源。',
        params: {
          type: 'object',
          properties: { supplierHotelId: { type: 'string', minLength: 1 } },
          required: ['supplierHotelId'],
        },
      },
    },
    async (req) => {
      const { supplierHotelId } = req.params as { supplierHotelId: string };
      return syncHotelContent(ctx, { hotelIds: [supplierHotelId] });
    },
  );

  app.get(
    '/api/v1/hotels/:id',
    {
      schema: {
        tags: ['catalog'],
        description: '酒店详情（静态资源）。:id 为本地酒店 ID 或 slug。',
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const detail: HotelDetailView = await getHotelDetail(ctx, id);
      return detail;
    },
  );
}
