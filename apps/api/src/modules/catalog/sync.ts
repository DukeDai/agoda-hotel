import { toAppError } from '@ota/core';
import type { SupplierHotel } from '@ota/agoda-connectivity';
import type { AppContext } from '../../lib/context.js';
import { computeContentHash } from './hash.js';
import { replaceHotelChildren, upsertHotelContent, upsertRatePlan } from './persist.js';

/**
 * Static content sync.
 *
 * The job pulls the supplier's catalogue and stores it locally, incrementally:
 * a hotel whose content hash did not change is skipped entirely, so a
 * periodic sync does not rewrite the whole database (SPEC §4.8).
 */

export interface SyncSummary {
  jobId: string;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

const DEFAULT_LIMIT = 100;
const MAX_ERROR_LENGTH = 500;

/**
 * Collect the hotels to sync.
 *
 * With explicit ids we ask the supplier for those hotels one by one, without
 * them we list the catalogue. A hotel that cannot be fetched is counted as a
 * failure, not as a fatal error: the rest of the batch still goes through.
 */
async function collectHotels(
  ctx: AppContext,
  options: { hotelIds?: string[]; limit?: number } | undefined,
): Promise<{ hotels: SupplierHotel[]; failed: number }> {
  const limit = options?.limit && options.limit > 0 ? options.limit : DEFAULT_LIMIT;

  if (options?.hotelIds && options.hotelIds.length > 0) {
    const ids = options.hotelIds.slice(0, limit);
    const hotels: SupplierHotel[] = [];
    let failed = 0;
    for (const supplierHotelId of ids) {
      try {
        hotels.push(await ctx.supplier.getHotel(supplierHotelId));
      } catch (err) {
        failed += 1;
        const error = toAppError(err);
        ctx.logger.warn('catalog hotel fetch failed', {
          supplierHotelId,
          code: error.code,
          message: error.message,
        });
      }
    }
    return { hotels, failed };
  }

  const hotels = await ctx.supplier.listHotels({ page: 1, pageSize: limit });
  return { hotels, failed: 0 };
}

/** Sync one hotel. Returns what happened, so the summary can be built. */
async function syncHotel(
  ctx: AppContext,
  supplier: string,
  hotel: SupplierHotel,
): Promise<'created' | 'updated' | 'skipped'> {
  const contentHash = computeContentHash(hotel);

  const existing = await ctx.prisma.hotel.findFirst({
    where: { supplier, supplierHotelId: hotel.id },
  });
  if (existing && existing.contentHash === contentHash) {
    // Nothing drifted: do not touch the row, and do not touch the children.
    return 'skipped';
  }

  const { id, created } = await upsertHotelContent(ctx.prisma, {
    supplier,
    hotel,
    contentHash,
    syncedAt: ctx.now(),
  });

  await replaceHotelChildren(ctx.prisma, id, hotel);
  await syncRatePlans(ctx, id, hotel);

  return created ? 'created' : 'updated';
}

/**
 * Static content from Agoda does not carry rate plans (they only show up in
 * the availability feed), so this is a no-op for the current supplier. The
 * hook exists so a supplier that does publish rate plans gets them stored
 * with the same keys the quotes use.
 */
async function syncRatePlans(
  ctx: AppContext,
  hotelId: string,
  hotel: SupplierHotel,
): Promise<void> {
  const plans = (hotel as { ratePlans?: unknown }).ratePlans;
  if (!Array.isArray(plans)) return;

  const roomTypes = await ctx.prisma.roomType.findMany({ where: { hotelId } });
  for (const plan of plans as {
    id?: string;
    roomTypeId?: string;
    name?: string;
    cancellationType?: string;
    freeCancellationUntil?: string;
    penaltyAmount?: number;
    penaltyPercent?: number;
    noShowPenalty?: number;
    cancellationText?: string;
    mealPlan?: string;
    payAtHotel?: boolean;
    instantConfirmation?: boolean;
    inclusions?: string[];
  }[]) {
    if (!plan?.id || !plan?.name) continue;
    const roomType =
      roomTypes.find((candidate) => candidate.supplierRoomTypeId === plan.roomTypeId) ?? roomTypes[0];
    if (!roomType) continue;
    await upsertRatePlan(ctx.prisma, roomType.id, {
      supplierRatePlanId: plan.id,
      name: plan.name,
      cancellationType: plan.cancellationType ?? 'NON_REFUNDABLE',
      freeCancellationUntil: plan.freeCancellationUntil ?? null,
      penaltyAmount: plan.penaltyAmount ?? null,
      penaltyPercent: plan.penaltyPercent ?? null,
      noShowPenalty: plan.noShowPenalty ?? null,
      cancellationText: plan.cancellationText ?? null,
      mealPlan: plan.mealPlan,
      payAtHotel: plan.payAtHotel,
      instantConfirmation: plan.instantConfirmation,
      inclusions: plan.inclusions,
    });
  }
}

/**
 * Sync the static content of the supplier into the local catalog.
 *
 * Idempotent: running it twice over unchanged content creates nothing.
 */
export async function syncHotelContent(
  ctx: AppContext,
  options?: { hotelIds?: string[]; limit?: number },
): Promise<SyncSummary> {
  const supplier = ctx.supplier.name;
  const job = await ctx.prisma.syncJob.create({
    data: { type: 'HOTEL_CONTENT', status: 'RUNNING', startedAt: ctx.now() },
  });

  const summary: SyncSummary = {
    jobId: job.id,
    total: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    const { hotels, failed } = await collectHotels(ctx, options);
    summary.total = hotels.length + failed;
    summary.failed = failed;

    for (const hotel of hotels) {
      try {
        const outcome = await syncHotel(ctx, supplier, hotel);
        if (outcome === 'created') summary.created += 1;
        else if (outcome === 'updated') summary.updated += 1;
        else summary.skipped += 1;
      } catch (err) {
        summary.failed += 1;
        const error = toAppError(err);
        ctx.logger.warn('catalog sync failed for hotel', {
          supplierHotelId: hotel.id,
          code: error.code,
          message: error.message,
        });
      }
    }

    await ctx.prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'SUCCEEDED',
        total: summary.total,
        processed: summary.created + summary.updated + summary.skipped,
        failed: summary.failed,
        finishedAt: ctx.now(),
      },
    });

    ctx.logger.info('catalog sync finished', {
      jobId: job.id,
      total: summary.total,
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
      failed: summary.failed,
    });

    return summary;
  } catch (err) {
    const error = toAppError(err);
    await ctx.prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        total: summary.total,
        processed: summary.created + summary.updated + summary.skipped,
        failed: summary.failed + 1,
        error: error.message.slice(0, MAX_ERROR_LENGTH),
        finishedAt: ctx.now(),
      },
    });
    ctx.logger.error('catalog sync failed', { jobId: job.id, code: error.code, message: error.message });
    throw err;
  }
}
