import { describe, expect, it } from 'vitest';
import { AgodaMockAdapter } from '@ota/agoda-connectivity';
import type { SupplierHotel } from '@ota/agoda-connectivity';
import { noopLogger } from '@ota/core';
import type { PrismaClient } from '@prisma/client';
import type { AppContext } from '../src/lib/context.js';
import { createMemoryBundle } from '../src/lib/cache.js';
import type { PaymentProvider } from '../src/lib/payment-provider.js';
import type { Config } from '../src/config.js';
import {
  computeContentHash,
  slugify,
  syncHotelContent,
  uniqueSlug,
} from '../src/modules/catalog/index.js';

/**
 * Catalog tests.
 *
 * No database and no network: the supplier is the deterministic mock adapter
 * and the database is a small in-memory fake that implements exactly the
 * prisma calls the catalog makes.
 */

type Row = Record<string, unknown>;

/** Minimal `where` matcher: equality, `OR`, `in` and `lt`. */
function matches(row: Row, where: Row): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      const branches = condition as Row[];
      if (!branches.some((branch) => matches(row, branch))) return false;
      continue;
    }
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      const nested = condition as Row;
      if ('in' in nested) {
        const values = nested.in as unknown[];
        if (!values.includes(row[key])) return false;
        continue;
      }
      if ('lt' in nested) {
        const value = row[key];
        if (!(value instanceof Date) || value >= (nested.lt as Date)) return false;
        continue;
      }
    }
    if (row[key] !== condition) return false;
  }
  return true;
}

class FakePrisma {
  readonly hotels: Row[] = [];
  readonly images: Row[] = [];
  readonly amenities: Row[] = [];
  readonly roomTypes: Row[] = [];
  readonly ratePlans: Row[] = [];
  readonly quotes: Row[] = [];
  readonly syncJobs: Row[] = [];
  private sequence = 0;

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(4, '0')}`;
  }

  readonly hotel = {
    findFirst: async (args: { where: Row }): Promise<Row | null> =>
      this.hotels.find((row) => matches(row, args.where)) ?? null,
    findMany: async (args: { where?: Row }): Promise<Row[]> =>
      (args.where ? this.hotels.filter((row) => matches(row, args.where)) : [...this.hotels]).map(
        (row) => ({ ...row, images: this.images.filter((image) => image.hotelId === row.id) }),
      ),
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: this.id('hotel'), ...args.data };
      this.hotels.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }): Promise<Row> => {
      const row = this.hotels.find((hotel) => hotel.id === args.where.id);
      if (!row) throw new Error(`hotel ${String(args.where.id)} not found`);
      Object.assign(row, args.data);
      return row;
    },
  };

  readonly hotelImage = {
    findFirst: async (args: { where: Row }): Promise<Row | null> =>
      this.images.find((row) => matches(row, args.where)) ?? null,
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: this.id('img'), ...args.data };
      this.images.push(row);
      return row;
    },
    deleteMany: async (args: { where: Row }): Promise<{ count: number }> => {
      const keep = this.images.filter((row) => !matches(row, args.where));
      const count = this.images.length - keep.length;
      this.images.splice(0, this.images.length, ...keep);
      return { count };
    },
    createMany: async (args: { data: Row[] }): Promise<{ count: number }> => {
      for (const data of args.data) this.images.push({ id: this.id('img'), ...data });
      return { count: args.data.length };
    },
  };

  readonly hotelAmenity = {
    deleteMany: async (args: { where: Row }): Promise<{ count: number }> => {
      const keep = this.amenities.filter((row) => !matches(row, args.where));
      const count = this.amenities.length - keep.length;
      this.amenities.splice(0, this.amenities.length, ...keep);
      return { count };
    },
    createMany: async (args: { data: Row[] }): Promise<{ count: number }> => {
      for (const data of args.data) this.amenities.push({ id: this.id('amen'), ...data });
      return { count: args.data.length };
    },
  };

  readonly roomType = {
    upsert: async (args: {
      where: { hotelId_supplierRoomTypeId: { hotelId: string; supplierRoomTypeId: string } };
      create: Row;
      update: Row;
    }): Promise<Row> => {
      const key = args.where.hotelId_supplierRoomTypeId;
      const existing = this.roomTypes.find(
        (row) => row.hotelId === key.hotelId && row.supplierRoomTypeId === key.supplierRoomTypeId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: Row = { id: this.id('rt'), ...args.create };
      this.roomTypes.push(row);
      return row;
    },
    findMany: async (args: { where: Row }): Promise<Row[]> =>
      this.roomTypes.filter((row) => matches(row, args.where)),
  };

  readonly ratePlan = {
    upsert: async (args: {
      where: { roomTypeId_supplierRatePlanId: { roomTypeId: string; supplierRatePlanId: string } };
      create: Row;
      update: Row;
    }): Promise<Row> => {
      const key = args.where.roomTypeId_supplierRatePlanId;
      const existing = this.ratePlans.find(
        (row) => row.roomTypeId === key.roomTypeId && row.supplierRatePlanId === key.supplierRatePlanId,
      );
      if (existing) {
        Object.assign(existing, args.update);
        return existing;
      }
      const row: Row = { id: this.id('rp'), ...args.create };
      this.ratePlans.push(row);
      return row;
    },
  };

  readonly availabilityQuote = {
    findFirst: async (args: { where: Row }): Promise<Row | null> =>
      this.quotes.find((row) => matches(row, args.where)) ?? null,
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: this.id('q'), ...args.data };
      this.quotes.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }): Promise<Row> => {
      const row = this.quotes.find((quote) => quote.id === args.where.id);
      if (!row) throw new Error(`quote ${String(args.where.id)} not found`);
      Object.assign(row, args.data);
      return row;
    },
    deleteMany: async (args: { where: Row }): Promise<{ count: number }> => {
      const keep = this.quotes.filter((row) => !matches(row, args.where));
      const count = this.quotes.length - keep.length;
      this.quotes.splice(0, this.quotes.length, ...keep);
      return { count };
    },
  };

  readonly syncJob = {
    create: async (args: { data: Row }): Promise<Row> => {
      const row: Row = { id: this.id('job'), ...args.data };
      this.syncJobs.push(row);
      return row;
    },
    update: async (args: { where: Row; data: Row }): Promise<Row> => {
      const row = this.syncJobs.find((job) => job.id === args.where.id);
      if (!row) throw new Error(`job ${String(args.where.id)} not found`);
      Object.assign(row, args.data);
      return row;
    },
    findMany: async (): Promise<Row[]> => [...this.syncJobs],
  };
}

function buildContext(supplier: AgodaMockAdapter): { ctx: AppContext; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const { cache, lock } = createMemoryBundle();
  const ctx: AppContext = {
    config: {} as Config,
    logger: noopLogger,
    prisma: prisma as unknown as PrismaClient,
    cache,
    lock,
    supplier,
    payment: {} as unknown as PaymentProvider,
    now: () => new Date('2026-10-20T12:00:00.000Z'),
  };
  return { ctx, prisma };
}

function sampleHotel(): SupplierHotel {
  return {
    id: '90001',
    name: 'Patong Bayview Resort',
    starRating: 5,
    category: 'RESORT',
    description: 'Beachfront resort.',
    address: {
      street: '28/5 Thaweewong Road',
      city: 'Phuket',
      state: 'Phuket',
      country: 'Thailand',
      countryCode: 'TH',
      postalCode: '83150',
    },
    geo: { latitude: 7.8924, longitude: 98.2961 },
    images: [{ url: 'https://img/1.jpg', caption: 'pool', order: 1 }],
    amenities: [{ group: 'General', name: 'Free WiFi' }],
    roomTypes: [
      {
        id: '90001-1',
        name: 'Deluxe King Room',
        maxOccupancy: 2,
        bedType: 'King bed',
        sizeSqm: 34,
        images: [{ url: 'https://img/room.jpg' }],
        amenities: [{ name: 'Safe' }],
      },
    ],
    checkInTime: '14:00',
    checkOutTime: '12:00',
    policies: ['No pets allowed'],
  };
}

describe('catalog content hash', () => {
  it('is stable for unchanged content', () => {
    const hotel = sampleHotel();
    expect(computeContentHash(hotel)).toBe(computeContentHash(sampleHotel()));
  });

  it('changes when the content changes', () => {
    const base = computeContentHash(sampleHotel());

    const renamed = sampleHotel();
    renamed.name = 'Patong Bayview Resort & Spa';
    expect(computeContentHash(renamed)).not.toBe(base);

    const redescribed = sampleHotel();
    redescribed.description = 'Beachfront resort, now with a kids club.';
    expect(computeContentHash(redescribed)).not.toBe(base);

    const regeocoded = sampleHotel();
    regeocoded.geo = { latitude: 7.9, longitude: 98.3 };
    expect(computeContentHash(regeocoded)).not.toBe(base);

    const rephotographed = sampleHotel();
    rephotographed.images = [{ url: 'https://img/2.jpg', caption: 'pool', order: 1 }];
    expect(computeContentHash(rephotographed)).not.toBe(base);

    const rerated = sampleHotel();
    rerated.starRating = 4;
    expect(computeContentHash(rerated)).not.toBe(base);

    const reroomed = sampleHotel();
    reroomed.roomTypes = [];
    expect(computeContentHash(reroomed)).not.toBe(base);
  });
});

describe('catalog slug', () => {
  it('is stable, lower case and URL safe', () => {
    const slug = slugify('Banyan Tree Phuket', '10884');
    expect(slug).toBe('banyan-tree-phuket');
    expect(slug).toBe(slugify('Banyan Tree Phuket', '10884'));
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('falls back to the supplier id when the name has no usable characters', () => {
    expect(slugify('北京饭店', '10884')).toBe('10884');
    expect(slugify('   ', '90001')).toBe('90001');
    expect(slugify('北京饭店', '90001')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('is unique without becoming unstable', async () => {
    const taken = new Set(['banyan-tree-phuket']);
    const isTaken = async (candidate: string) => taken.has(candidate);

    // The base slug is taken: the supplier id makes it unique.
    await expect(uniqueSlug('banyan-tree-phuket', '10884', isTaken)).resolves.toBe(
      'banyan-tree-phuket-10884',
    );
    await expect(uniqueSlug('banyan-tree-phuket', '10884', async () => false)).resolves.toBe(
      'banyan-tree-phuket',
    );

    // Even the scoped slug is taken: the result stays deterministic.
    taken.add('banyan-tree-phuket-10884');
    const resolved = await uniqueSlug('banyan-tree-phuket', '10884', isTaken);
    expect(resolved).not.toBe('banyan-tree-phuket');
    expect(resolved.startsWith('banyan-tree-phuket-10884')).toBe(true);
    // The same hotel always resolves to the same slug.
    await expect(uniqueSlug('banyan-tree-phuket', '10884', isTaken)).resolves.toBe(resolved);
  });
});

describe('catalog sync', () => {
  it('stores every hotel once and a second run changes nothing', async () => {
    const supplier = new AgodaMockAdapter({ seed: 20261020 });
    const { ctx, prisma } = buildContext(supplier);

    const first = await syncHotelContent(ctx, { limit: 100 });
    expect(first.total).toBeGreaterThan(0);
    expect(first.created).toBe(first.total);
    expect(first.failed).toBe(0);
    expect(prisma.hotels).toHaveLength(first.total);

    const second = await syncHotelContent(ctx, { limit: 100 });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(first.total);
    // The second run must not have created a duplicate.
    expect(prisma.hotels).toHaveLength(first.total);
  });

  it('never creates two hotels for the same supplier id', async () => {
    const supplier = new AgodaMockAdapter({ seed: 20261020 });
    const { ctx, prisma } = buildContext(supplier);

    await syncHotelContent(ctx, { hotelIds: ['90001'] });
    await syncHotelContent(ctx, { hotelIds: ['90001'] });

    const hotels = prisma.hotels.filter((row) => row.supplierHotelId === '90001');
    expect(hotels).toHaveLength(1);
    expect(hotels[0]?.slug).toBe('patong-bayview-resort');
    expect(hotels[0]?.contentHash).toEqual(expect.any(String));
    expect(hotels[0]?.contentSyncedAt).toBeInstanceOf(Date);
  });

  it('records the sync job', async () => {
    const supplier = new AgodaMockAdapter({ seed: 20261020 });
    const { ctx, prisma } = buildContext(supplier);

    const summary = await syncHotelContent(ctx, { hotelIds: ['90001'] });
    const job = prisma.syncJobs.find((row) => row.id === summary.jobId);

    expect(job?.type).toBe('HOTEL_CONTENT');
    expect(job?.status).toBe('SUCCEEDED');
    expect(job?.total).toBe(1);
    expect(job?.failed).toBe(0);
    expect(job?.finishedAt).toBeInstanceOf(Date);
  });

  it('stores the images, amenities and room types of a hotel', async () => {
    const supplier = new AgodaMockAdapter({ seed: 20261020 });
    const { ctx, prisma } = buildContext(supplier);

    await syncHotelContent(ctx, { hotelIds: ['90001'] });

    const hotel = prisma.hotels.find((row) => row.supplierHotelId === '90001');
    expect(hotel).toBeDefined();
    expect(prisma.images.filter((row) => row.hotelId === hotel?.id).length).toBeGreaterThan(0);
    expect(prisma.amenities.filter((row) => row.hotelId === hotel?.id).length).toBeGreaterThan(0);
    expect(prisma.roomTypes.filter((row) => row.hotelId === hotel?.id).length).toBeGreaterThan(0);
  });

  it('counts a hotel that cannot be fetched as a failure', async () => {
    const supplier = new AgodaMockAdapter({ seed: 20261020 });
    const { ctx } = buildContext(supplier);

    const summary = await syncHotelContent(ctx, { hotelIds: ['does-not-exist'] });
    expect(summary.failed).toBe(1);
    expect(summary.created).toBe(0);
  });
});
