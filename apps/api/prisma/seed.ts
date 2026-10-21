/**
 * Database seed.
 *
 * Pulls the supplier's static content into the local catalog using the very
 * same code path the API uses at runtime, so the seeded data and the data
 * produced by the sync job can never drift apart.
 *
 * Re-running the seed is safe: the catalog sync is idempotent (content hash).
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/lib/bootstrap.js';
import { syncHotelContent } from '../src/modules/catalog/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);

  ctx.logger.info('seeding catalog from supplier', { mode: config.AGODA_MODE });

  const summary = await syncHotelContent(ctx, { limit: 200 });

  const hotels = await ctx.prisma.hotel.count();
  const roomTypes = await ctx.prisma.roomType.count();
  const ratePlans = await ctx.prisma.ratePlan.count();

  ctx.logger.info('seed complete', {
    jobId: summary.jobId,
    total: summary.total,
    created: summary.created,
    updated: summary.updated,
    skipped: summary.skipped,
    failed: summary.failed,
    hotels,
    roomTypes,
    ratePlans,
  });

  // eslint-disable-next-line no-console
  console.log(
    `seed ok: hotels=${hotels} roomTypes=${roomTypes} ratePlans=${ratePlans} ` +
      `(total=${summary.total} created=${summary.created} updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed})`,
  );

  await ctx.prisma.$disconnect();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed failed', err);
  process.exit(1);
});
