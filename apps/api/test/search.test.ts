import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { AgodaMockAdapter } from '@ota/agoda-connectivity';
import type { SupplierAdapter } from '@ota/agoda-connectivity';
import { AppError, fingerprintStayContext, noopLogger } from '@ota/core';
import type { StayContext } from '@ota/core';
import type { PrismaClient } from '@prisma/client';
import type { AppContext } from '../src/lib/context.js';
import { createMemoryBundle } from '../src/lib/cache.js';
import type { PaymentProvider } from '../src/lib/payment-provider.js';
import type { Config } from '../src/config.js';
import {
  getAvailability,
  precheckQuote,
  searchHotels,
} from '../src/modules/search/index.js';
import { registerSearchRoutes } from '../src/modules/search/index.js';
import { registerCatalogRoutes } from '../src/modules/catalog/index.js';

/**
 * Search module tests.
 *
 * No database and no network: the supplier is the deterministic mock adapter
 * and the database is a small in-memory fake that implements exactly the
 * prisma calls the search module makes.
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
  readonly roomTypes: Row[] = [];
  readonly ratePlans: Row[] = [];
  readonly quotes: Row[] = [];
  private sequence = 0;

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(4, '0')}`;
  }

  readonly hotel = {
    findFirst: async (args: { where: Row }): Promise<Row | null> => {
      const row = this.hotels.find((hotel) => matches(hotel, args.where));
      return row ? { ...row, images: this.imagesOf(row.id) } : null;
    },
    findMany: async (args: { where?: Row }): Promise<Row[]> =>
      (args.where ? this.hotels.filter((hotel) => matches(hotel, args.where)) : [...this.hotels]).map(
        (row) => ({ ...row, images: this.imagesOf(row.id) }),
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
      this.quotes.find((quote) => matches(quote, args.where)) ?? null,
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
      const keep = this.quotes.filter((quote) => !matches(quote, args.where));
      const count = this.quotes.length - keep.length;
      this.quotes.splice(0, this.quotes.length, ...keep);
      return { count };
    },
  };

  private imagesOf(hotelId: unknown): Row[] {
    return this.images.filter((image) => image.hotelId === hotelId);
  }
}

/** Counts the supplier calls, so the tests can prove we do not hammer it. */
function countingSupplier(supplier: SupplierAdapter): { supplier: SupplierAdapter; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const proxy = new Proxy(supplier, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls[String(property)] = (calls[String(property)] ?? 0) + 1;
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { supplier: proxy, calls };
}

const NOW = new Date('2026-10-20T12:00:00.000Z');
const CHECK_IN = '2026-11-10';
const CHECK_OUT = '2026-11-12';

function buildContext(supplier: SupplierAdapter): { ctx: AppContext; prisma: FakePrisma } {
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
    now: () => NOW,
  };
  return { ctx, prisma };
}

function stayContext(supplierHotelId: string, childAges: number[] = []): StayContext {
  return {
    supplierHotelId,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    rooms: 1,
    adults: 2,
    childAges,
    currency: 'CNY',
    nationality: 'CN',
  };
}

describe('search', () => {
  it('returns hotels with their local id, slug and lowest price', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const result = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });

    expect(result.nights).toBe(2);
    expect(result.hotels.length).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThanOrEqual(result.hotels.length);

    for (const hotel of result.hotels) {
      // The local hotel exists, so the result can be booked right away.
      expect(prisma.hotels.some((row) => row.id === hotel.id)).toBe(true);
      expect(hotel.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(hotel.lowestNightlyTotal?.amount).toBeTypeOf('number');
      expect(Number.isInteger(hotel.lowestNightlyTotal?.amount)).toBe(true);
      expect(hotel.lowestStayTotal?.amount).toBeGreaterThan(0);
      expect(hotel.lowestNightlyTotal?.currency).toBe('CNY');
    }
  });

  it('serves the second identical search from the cache', async () => {
    const { supplier, calls } = countingSupplier(new AgodaMockAdapter({ seed: 20261020 }));
    const { ctx } = buildContext(supplier);

    const params = {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    };
    const first = await searchHotels(ctx, params);
    const second = await searchHotels(ctx, params);

    expect(second).toEqual(first);
    // The supplier is only asked once: the rate limit is a scarce resource.
    expect(calls.searchHotels).toBe(1);
    expect(calls.getAvailability).toBe(1);
  });

  it('stores the thumbnail of a search result as the first image', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const result = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = result.hotels[0];
    expect(hotel?.thumbnail).toBeTruthy();

    const images = prisma.images.filter((row) => row.hotelId === hotel?.id);
    expect(images.length).toBeGreaterThan(0);
    expect(images[0]?.url).toBe(hotel?.thumbnail);
    expect(images[0]?.position).toBe(0);
  });

  it('rejects an invalid stay', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    await expect(
      searchHotels(ctx, {
        destination: 'Phuket',
        checkIn: CHECK_OUT,
        checkOut: CHECK_IN,
        rooms: 1,
        adults: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('availability', () => {
  it('carries the right number of nights and integer minor units', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const first = search.hotels[0];
    expect(first).toBeDefined();

    const availability = await getAvailability(ctx, {
      hotelId: first?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });

    expect(availability.nights).toBe(2);
    expect(availability.quotes.length).toBeGreaterThan(0);

    for (const quote of availability.quotes) {
      expect(quote.nights).toBe(2);
      expect(Number.isInteger(quote.nightly.total.amount)).toBe(true);
      expect(Number.isInteger(quote.nightly.net.amount)).toBe(true);
      expect(Number.isInteger(quote.nightly.taxes.amount)).toBe(true);
      expect(Number.isInteger(quote.stayTotal.total.amount)).toBe(true);
      expect(quote.nightly.total.currency).toBe('CNY');
      // The stay total is the nightly price times the number of nights.
      expect(quote.stayTotal.net.amount).toBe(quote.nightly.net.amount * quote.nights);
      expect(quote.stayTotal.total.amount).toBeGreaterThan(quote.nightly.total.amount);
      // The ids the booking module resolves are local ones.
      expect(quote.roomTypeId).not.toBe('');
      expect(quote.ratePlanId).not.toBe('');
    }
  });

  it('stores the fingerprint of the stay context on the quote', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0];

    await getAvailability(ctx, {
      hotelId: hotel?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });

    const row = prisma.quotes[0];
    expect(row).toBeDefined();
    // The booking module recomputes this value from the same stay and
    // refuses to book when it differs.
    expect(row?.contextFingerprint).toBe(fingerprintStayContext(stayContext('90001')));
  });

  it('stores the same fingerprint whatever order the child ages come in', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
      childAges: [8, 5],
    });
    const hotel = search.hotels[0];

    await getAvailability(ctx, {
      hotelId: hotel?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
      childAges: [8, 5],
    });

    expect(prisma.quotes[0]?.contextFingerprint).toBe(
      fingerprintStayContext(stayContext('90001', [5, 8])),
    );
  });

  it('expires the quote after two minutes', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    await getAvailability(ctx, {
      hotelId: search.hotels[0]?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });

    const row = prisma.quotes[0];
    const expiresAt = row?.expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(2 * 60 * 1000);
  });

  it('does not create a second row for the same offer', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const params = {
      hotelId: search.hotels[0]?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    };

    await getAvailability(ctx, params);
    const afterFirst = prisma.quotes.length;
    await getAvailability(ctx, params);

    expect(prisma.quotes).toHaveLength(afterFirst);
  });
});

describe('precheck', () => {
  it('reports no price change when the supplier keeps the price', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020, priceDriftRate: 0 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0];

    const availability = await getAvailability(ctx, {
      hotelId: hotel?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const quote = availability.quotes[0];

    const result = await precheckQuote(ctx, {
      hotelId: hotel?.id ?? '',
      offerId: quote?.offerId ?? '',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });

    expect(result.available).toBe(true);
    expect(result.priceChanged).toBe(false);
    expect(result.total.amount).toBe(quote?.stayTotal.total.amount);
  });

  it('reports a price change when the supplier re-prices the offer', async () => {
    const { ctx, prisma } = buildContext(new AgodaMockAdapter({ seed: 20261020, priceDriftRate: 1 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0];

    const availability = await getAvailability(ctx, {
      hotelId: hotel?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const quote = availability.quotes[0];

    const result = await precheckQuote(ctx, {
      hotelId: hotel?.id ?? '',
      offerId: quote?.offerId ?? '',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });

    expect(result.available).toBe(true);
    expect(result.priceChanged).toBe(true);
    expect(result.total.amount).not.toBe(quote?.stayTotal.total.amount);

    // The cached quote carries the new price, so the booking uses it.
    const row = prisma.quotes.find((stored) => stored.offerId === quote?.offerId);
    expect(row?.totalAmount).toBe(result.total.amount);
  });

  it('rejects an offer that does not exist', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0];

    await expect(
      precheckQuote(ctx, {
        hotelId: hotel?.id ?? '',
        offerId: 'not-an-offer',
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        rooms: 1,
        adults: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a stay that drifted away from the quote', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0];

    const availability = await getAvailability(ctx, {
      hotelId: hotel?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const quote = availability.quotes[0];

    await expect(
      precheckQuote(ctx, {
        hotelId: hotel?.id ?? '',
        offerId: quote?.offerId ?? '',
        checkIn: CHECK_IN,
        checkOut: '2026-11-13',
        rooms: 1,
        adults: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('reports a sold out offer as ROOM_UNAVAILABLE', async () => {
    const supplier = new AgodaMockAdapter({ seed: 20261020, sellOutRate: 1 });
    const { ctx } = buildContext(supplier);

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0];

    const availability = await getAvailability(ctx, {
      hotelId: hotel?.id ?? '',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const quote = availability.quotes[0];

    await expect(
      precheckQuote(ctx, {
        hotelId: hotel?.id ?? '',
        offerId: quote?.offerId ?? '',
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        rooms: 1,
        adults: 2,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_UNAVAILABLE' });
  });
});

describe('routes', () => {
  it('registers the catalog and search routes without a conflict', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));
    const app = Fastify();
    await registerCatalogRoutes(app, ctx);
    await registerSearchRoutes(app, ctx);

    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/api/v1/hotels/search');
    expect(routes).toContain('/api/v1/hotels/:id');
    expect(routes).toContain('/api/v1/quotes/precheck');
    expect(routes).toContain('/api/v1/admin/sync/jobs');
    expect(routes).toContain('/api/v1/admin/sync/hotels/:supplierHotelId');

    // Fastify prints the nested availability route under its parent.
    expect(
      app.hasRoute({ method: 'GET', url: '/api/v1/hotels/:id/availability' }),
    ).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/hotels/search' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/hotels/:id' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/v1/quotes/precheck' })).toBe(true);

    await app.close();
  });
});

describe('validation', () => {
  it('rejects a stay that is longer than the maximum', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    await expect(
      searchHotels(ctx, {
        destination: 'Phuket',
        checkIn: CHECK_IN,
        checkOut: '2026-12-30',
        rooms: 1,
        adults: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects an unknown currency', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    await expect(
      searchHotels(ctx, {
        destination: 'Phuket',
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        rooms: 1,
        adults: 2,
        currency: 'XYZ',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a hotel that was never synced', async () => {
    const { ctx } = buildContext(new AgodaMockAdapter({ seed: 20261020 }));

    const error = await getAvailability(ctx, {
      hotelId: 'unknown-hotel',
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    }).catch((err: unknown) => err);

    expect(AppError.is(error)).toBe(true);
    expect((error as AppError).code).toBe('HOTEL_NOT_FOUND');
  });
});
