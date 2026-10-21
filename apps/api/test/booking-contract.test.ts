import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgodaMockAdapter } from '@ota/agoda-connectivity';
import type { SupplierAdapter } from '@ota/agoda-connectivity';
import { AppError, fingerprintStayContext, type StayContext } from '@ota/core';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';
import { getPrisma } from '../src/lib/prisma.js';
import { createCacheBundle } from '../src/lib/cache.js';
import { createPaymentProvider } from '../src/modules/payment/index.js';
import {
  cancelBooking,
  createBooking,
  payBooking,
  pollPendingBookings,
} from '../src/modules/booking/service.js';
import { getAvailability, precheckQuote, searchHotels } from '../src/modules/search/index.js';
import type { AppContext } from '../src/lib/context.js';

/**
 * The contract tests of the booking engine.
 *
 * Every case here corresponds to a rule that is easy to break silently and
 * expensive when it breaks:
 *
 *  - a cancellation that is retried must not refund twice (AC 9);
 *  - a payment retried with a different body must be a conflict, not a
 *    cheerful "already paid";
 *  - a price increase must be confirmed BY THE CUSTOMER, on the server;
 *  - a terminal order must never be resurrected by a late poller;
 *  - the customer notification and the state change must share a
 *    transaction;
 *  - a cancellation deadline is a date in the PROPERTY's timezone;
 *  - a failure that costs the customer a room must leave an operations
 *    record.
 */

const HOTEL_ID = '90001';
const CHECK_IN = '2027-03-10';
const CHECK_OUT = '2027-03-12';

function makeContext(adapter: SupplierAdapter, now: () => Date = () => new Date()): AppContext {
  const config = loadConfig();
  const { cache, lock } = createCacheBundle(undefined);
  return {
    config,
    logger: createLogger(config),
    prisma: getPrisma(config),
    cache,
    lock,
    supplier: adapter,
    payment: createPaymentProvider(config),
    now,
  };
}

function key(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

interface SeedOptions {
  checkIn?: string;
  checkOut?: string;
  /** IANA timezone of the property. */
  timeZone?: string;
  /** Last day a free cancellation is allowed (property local time). */
  freeCancellationUntil?: string;
  now: Date;
}

interface SeededStay {
  hotelId: string;
  offerId: string;
  total: number;
  nights: number;
}

/**
 * Put a hotel, a room type, a rate plan and a live quote into the database.
 *
 * The quote MUST come from the supplier: the mock validates the amount we
 * expect to be charged, and a hand-written price would look like a price
 * change to the supplier.
 */
async function seedStay(ctx: AppContext, adapter: SupplierAdapter, options: SeedOptions): Promise<SeededStay> {
  const checkIn = options.checkIn ?? CHECK_IN;
  const checkOut = options.checkOut ?? CHECK_OUT;

  const hotel = await ctx.prisma.hotel.upsert({
    where: { supplier_supplierHotelId: { supplier: 'agoda', supplierHotelId: HOTEL_ID } },
    update: options.timeZone ? { timeZone: options.timeZone } : {},
    create: {
      supplier: 'agoda',
      supplierHotelId: HOTEL_ID,
      name: 'Patong Bayview Resort',
      slug: 'patong-bayview-resort',
      city: 'Phuket',
      country: 'Thailand',
      countryCode: 'TH',
      starRating: 4,
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    },
  });

  const roomType = await ctx.prisma.roomType.upsert({
    where: { hotelId_supplierRoomTypeId: { hotelId: hotel.id, supplierRoomTypeId: '90001-1' } },
    update: {},
    create: {
      hotelId: hotel.id,
      supplierRoomTypeId: '90001-1',
      name: 'Deluxe King Room',
      maxOccupancy: 2,
      bedType: 'King bed',
    },
  });

  const ratePlan = await ctx.prisma.ratePlan.upsert({
    where: { roomTypeId_supplierRatePlanId: { roomTypeId: roomType.id, supplierRatePlanId: '90001-1-FLEX' } },
    update: {},
    create: {
      roomTypeId: roomType.id,
      supplierRatePlanId: '90001-1-FLEX',
      name: 'Free cancellation',
      cancellationType: 'FULL_REFUND',
      freeCancellationUntil: new Date('2027-12-31T00:00:00.000Z'),
    },
  });

  const stay: StayContext = {
    supplierHotelId: HOTEL_ID,
    checkIn,
    checkOut,
    rooms: 1,
    adults: 2,
    childAges: [],
    currency: 'CNY',
    nationality: 'CN',
  };

  const availability = await adapter.getAvailability({
    destination: { name: 'Phuket', countryCode: 'TH' },
    checkIn,
    checkOut,
    rooms: 1,
    adults: 2,
    childAges: [],
    currency: 'CNY',
    nationality: 'CN',
    hotelIds: [HOTEL_ID],
  });
  const quote = availability.flatMap((a) => a.quotes)[0];
  if (!quote) throw new Error('the mock produced no quote for the test stay');

  await ctx.prisma.availabilityQuote.create({
    data: {
      hotelId: hotel.id,
      roomTypeId: roomType.id,
      ratePlanId: ratePlan.id,
      offerId: quote.offerId,
      checkIn: new Date(`${checkIn}T00:00:00.000Z`),
      checkOut: new Date(`${checkOut}T00:00:00.000Z`),
      nights: 2,
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nightlyNet: quote.nightly.net.amount,
      nightlyTax: quote.nightly.taxes.amount,
      nightlyTotal: quote.nightly.total.amount,
      netAmount: quote.stayTotal.net.amount,
      taxAmount: quote.stayTotal.taxes.amount,
      totalAmount: quote.stayTotal.total.amount,
      quotedTotalAmount: quote.stayTotal.total.amount,
      pendingTotalAmount: null,
      cancellationType: 'FULL_REFUND',
      freeCancellationUntil: options.freeCancellationUntil
        ? new Date(`${options.freeCancellationUntil}T00:00:00.000Z`)
        : new Date('2027-12-31T00:00:00.000Z'),
      contextFingerprint: fingerprintStayContext(stay),
      expiresAt: new Date(options.now.getTime() + 600_000),
    },
  });

  return {
    hotelId: hotel.id,
    offerId: quote.offerId,
    total: quote.stayTotal.total.amount,
    nights: 2,
  };
}

async function orderStay(ctx: AppContext, seeded: SeededStay, idempotencyKey: string) {
  return createBooking(ctx, {
    hotelId: seeded.hotelId,
    offerId: seeded.offerId,
    checkIn: CHECK_IN,
    checkOut: CHECK_OUT,
    rooms: 1,
    adults: 2,
    childAges: [],
    currency: 'CNY',
    nationality: 'CN',
    guest: { firstName: '测', lastName: '试', email: 'test@example.com' },
    idempotencyKey,
  });
}

/** Pay and wait until the supplier confirms the booking. */
async function payAndConfirm(ctx: AppContext, orderNo: string): Promise<void> {
  await payBooking(ctx, orderNo, { idempotencyKey: key('pay'), method: 'mock_card' });
  for (let i = 0; i < 5; i += 1) {
    await pollPendingBookings(ctx);
    const stored = await ctx.prisma.booking.findUnique({ where: { orderNo } });
    if (stored?.status === 'CONFIRMED') return;
  }
}

describe('booking contract', () => {
  let ctx: AppContext;

  beforeAll(async () => {
    const config = loadConfig();
    const prisma = getPrisma(config);
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE "NotificationDelivery","WebhookDelivery","WebhookEndpoint","OutboxEvent","AuditLog","Refund","Payment","BookingEvent","BookingGuest","BookingItem","Booking","AvailabilityQuote","RatePlan","RoomType","HotelAmenity","HotelImage","Hotel","IdempotencyRecord","SyncJob" RESTART IDENTITY CASCADE;`,
    );
  });

  afterAll(async () => {
    await ctx?.prisma.$disconnect();
  });

  it('replays the first cancellation answer instead of refusing a retry', async () => {
    const adapter = new AgodaMockAdapter({ seed: 31, processingPolls: 0 });
    ctx = makeContext(adapter);
    const seeded = await seedStay(ctx, adapter, { now: ctx.now() });
    const order = await orderStay(ctx, seeded, key('book'));
    await payAndConfirm(ctx, order.orderNo);

    const cancelKey = key('cancel');
    const first = await cancelBooking(ctx, order.orderNo, { idempotencyKey: cancelKey, reason: '行程变更' });
    expect(first.cancellation.cancelled).toBe(true);
    expect(first.cancellation.refundAmount.amount).toBeGreaterThan(0);

    // The client retries the very same request (a lost response, a double
    // click). It must get the FIRST answer back, not "you cannot cancel an
    // already cancelled booking".
    const replay = await cancelBooking(ctx, order.orderNo, { idempotencyKey: cancelKey, reason: '行程变更' });
    expect(replay.booking.id).toBe(first.booking.id);
    expect(replay.cancellation.refundAmount.amount).toBe(first.cancellation.refundAmount.amount);
    expect(replay.cancellation.policyType).toBe(first.cancellation.policyType);

    // And the money moved exactly once.
    const refunds = await ctx.prisma.refund.findMany({ where: { bookingId: order.id } });
    expect(refunds.length).toBe(1);

    // A DIFFERENT key on an already cancelled order is still a conflict.
    await expect(
      cancelBooking(ctx, order.orderNo, { idempotencyKey: key('cancel-2'), reason: '再改一次' }),
    ).rejects.toMatchObject({ code: 'CANCEL_NOT_ALLOWED' });
  });

  it('rejects the same payment key with a different body', async () => {
    const adapter = new AgodaMockAdapter({ seed: 32, processingPolls: 0 });
    ctx = makeContext(adapter);
    const seeded = await seedStay(ctx, adapter, { now: ctx.now() });
    const order = await orderStay(ctx, seeded, key('book'));

    const payKey = key('pay');
    const paid = await payBooking(ctx, order.orderNo, { idempotencyKey: payKey, method: 'mock_card' });
    expect(['PAID', 'BOOKING_SUBMITTED', 'CONFIRMED']).toContain(paid.status);

    // Same key, different body: the client reused a key by mistake. It must
    // be a conflict, not a silent "already paid".
    await expect(
      payBooking(ctx, order.orderNo, { idempotencyKey: payKey, method: 'mock_card_decline' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    // Only one payment was ever created.
    const payments = await ctx.prisma.payment.findMany({ where: { bookingId: order.id } });
    expect(payments.length).toBe(1);
  });

  it('answers a payment with the contract shape', async () => {
    const adapter = new AgodaMockAdapter({ seed: 33, processingPolls: 0 });
    ctx = makeContext(adapter);
    const seeded = await seedStay(ctx, adapter, { now: ctx.now() });
    const order = await orderStay(ctx, seeded, key('book'));

    const paid = await payBooking(ctx, order.orderNo, { idempotencyKey: key('pay'), method: 'mock_card' });
    expect(Object.keys(paid).sort()).toEqual(['booking', 'orderNo', 'payment', 'status']);
    expect(paid.orderNo).toBe(order.orderNo);
    expect(paid.status).toBe(paid.booking.status);
    expect(paid.payment?.status).toBe('CAPTURED');
    expect(paid.booking.payment).not.toBeNull();
  });

  it('never resurrects a terminal order when a late confirmation arrives', async () => {
    const base = new AgodaMockAdapter({ seed: 34, processingPolls: 2 });
    ctx = makeContext(base);
    const seeded = await seedStay(ctx, base, { now: ctx.now() });
    const order = await orderStay(ctx, seeded, key('book'));
    await payBooking(ctx, order.orderNo, { idempotencyKey: key('pay'), method: 'mock_card' });

    const submitted = await ctx.prisma.booking.findUnique({ where: { id: order.id } });
    expect(submitted!.status).toBe('BOOKING_SUBMITTED');
    expect(submitted!.supplierBookingId).toBeTruthy();

    // Another writer (the refund worker, an operator) finished the order
    // while the supplier was still thinking about the confirmation. The
    // poller must not drag a REFUNDED order back to CONFIRMED.
    const racing = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'getBooking') {
          return async (supplierBookingId: string) => {
            await ctx.prisma.booking.update({
              where: { id: order.id },
              data: { status: 'REFUNDED', refundedAmount: seeded.total },
            });
            return target.getBooking(supplierBookingId);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as SupplierAdapter;

    const racingCtx = makeContext(racing);
    const result = await pollPendingBookings(racingCtx);
    expect(result.confirmed).toBe(0);

    const stored = await ctx.prisma.booking.findUnique({ where: { id: order.id } });
    expect(stored!.status).toBe('REFUNDED');
    expect(stored!.confirmationNumber).toBeNull();

    const confirmed = await ctx.prisma.outboxEvent.findFirst({
      where: { topic: 'booking.confirmed', aggregateId: order.id },
    });
    expect(confirmed).toBeNull();
  });

  it('refuses to book a price the customer never accepted', async () => {
    const adapter = new AgodaMockAdapter({ seed: 35, priceDriftRate: 1, processingPolls: 0 });
    ctx = makeContext(adapter);

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0]!;

    const availability = await getAvailability(ctx, {
      hotelId: hotel.id,
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const quote = availability.quotes[0]!;

    const precheck = await precheckQuote(ctx, {
      hotelId: hotel.id,
      offerId: quote.offerId,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    expect(precheck.priceChanged).toBe(true);
    expect(precheck.total.amount).toBeGreaterThan(quote.stayTotal.total.amount);

    // The customer did NOT confirm the new price: the server refuses.
    let refused: AppError | null = null;
    try {
      await createBooking(ctx, {
        hotelId: hotel.id,
        offerId: quote.offerId,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        rooms: 1,
        adults: 2,
        childAges: [],
        currency: 'CNY',
        nationality: 'CN',
        guest: { firstName: '测', lastName: '试', email: 'test@example.com' },
        idempotencyKey: key('book'),
      });
    } catch (err) {
      refused = err as AppError;
    }
    expect(refused).not.toBeNull();
    expect(refused!.code).toBe('PRICE_CHANGED');
    expect(refused!.details.expected).toBe(precheck.total.amount);

    // With the customer's explicit acceptance the order goes through, and it
    // is priced at the accepted amount.
    const created = await createBooking(ctx, {
      hotelId: hotel.id,
      offerId: quote.offerId,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nationality: 'CN',
      guest: { firstName: '测', lastName: '试', email: 'test@example.com' },
      acceptedTotal: precheck.total.amount,
      idempotencyKey: key('book'),
    });
    expect(created.price.total.amount).toBe(precheck.total.amount);

    const stored = await ctx.prisma.booking.findUnique({ where: { id: created.id } });
    expect(stored!.acceptedTotalAmount).toBe(precheck.total.amount);
  });

  it('leaves an operations record when a paid booking fails and is refunded', async () => {
    const adapter = new AgodaMockAdapter({ seed: 36, processingPolls: 0 });
    ctx = makeContext(adapter);
    const seeded = await seedStay(ctx, adapter, { now: ctx.now() });
    const order = await orderStay(ctx, seeded, key('book'));

    adapter.failNext(1, 'rejected');
    await payBooking(ctx, order.orderNo, { idempotencyKey: key('pay'), method: 'mock_card' });

    const audit = await ctx.prisma.auditLog.findMany({ where: { entityId: order.id } });
    const actions = audit.map((row) => row.action);
    // SPEC §6.3 — a failure that costs the customer a room must be visible
    // to operations, not only in the log file.
    expect(actions).toContain('booking.failed');
    expect(actions).toContain('booking.auto_refund');

    const refunds = await ctx.prisma.refund.findMany({ where: { bookingId: order.id } });
    expect(refunds.length).toBe(1);
    expect(refunds[0]!.status).toBe('SUCCEEDED');
    expect(refunds[0]!.amount).toBe(seeded.total);
  });

  it('commits the notification event in the same transaction as the status change', async () => {
    const prisma = ctx.prisma;

    // Postgres knows the transaction id of every statement. A trigger that
    // records it proves — instead of asserting — that the status change and
    // the event were committed together.
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "TxProbe"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ota_tx_probe()`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "TxProbe" (id serial primary key, tag text, rowid text, txid bigint, status text)`,
    );
    await prisma.$executeRawUnsafe(`CREATE FUNCTION ota_tx_probe() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "TxProbe"(tag, rowid, txid, status)
        VALUES (TG_TABLE_NAME, NEW.id::text, txid_current(), to_jsonb(NEW)->>'status');
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "ota_tx_probe_booking" AFTER INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION ota_tx_probe()`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "ota_tx_probe_outbox" AFTER INSERT OR UPDATE ON "OutboxEvent" FOR EACH ROW EXECUTE FUNCTION ota_tx_probe()`,
    );

    try {
      const adapter = new AgodaMockAdapter({ seed: 39, processingPolls: 0 });
      ctx = makeContext(adapter);
      const seeded = await seedStay(ctx, adapter, { now: ctx.now() });
      const order = await orderStay(ctx, seeded, key('book'));
      await payBooking(ctx, order.orderNo, { idempotencyKey: key('pay'), method: 'mock_card' });

      const paidEvent = await prisma.outboxEvent.findFirst({
        where: { topic: 'booking.paid', aggregateId: order.id },
      });
      expect(paidEvent).not.toBeNull();

      const probes = await prisma.$queryRawUnsafe<
        Array<{ tag: string; rowid: string; txid: string; status: string | null }>
      >(
        `SELECT tag, rowid, txid::text AS txid, status FROM "TxProbe" WHERE rowid = $1 OR rowid = $2`,
        order.id,
        paidEvent!.id,
      );

      const statusTx = probes.filter((p) => p.tag === 'Booking' && p.status === 'PAID').map((p) => p.txid);
      const eventTx = probes.filter((p) => p.tag === 'OutboxEvent' && p.rowid === paidEvent!.id).map((p) => p.txid);
      expect(statusTx.length).toBeGreaterThan(0);
      expect(eventTx.length).toBeGreaterThan(0);
      // Same transaction id => one commit, no window in between.
      expect(statusTx.some((tx) => eventTx.includes(tx))).toBe(true);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ota_tx_probe_booking" ON "Booking"`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "ota_tx_probe_outbox" ON "OutboxEvent"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ota_tx_probe()`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "TxProbe"`);
    }
  });

  it('replays a repeated precheck instead of hitting the supplier twice', async () => {
    const adapter = new AgodaMockAdapter({ seed: 40, processingPolls: 0 });
    ctx = makeContext(adapter);

    const search = await searchHotels(ctx, {
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const hotel = search.hotels[0]!;
    const availability = await getAvailability(ctx, {
      hotelId: hotel.id,
      destination: 'Phuket',
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
    });
    const quote = availability.quotes[0]!;

    const request = {
      hotelId: hotel.id,
      offerId: quote.offerId,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
      idempotencyKey: key('precheck'),
    };

    const first = await precheckQuote(ctx, request);
    const replay = await precheckQuote(ctx, request);
    expect(replay).toEqual(first);

    // Same key, different body: the client reused a key by mistake.
    await expect(
      precheckQuote(ctx, { ...request, offerId: availability.quotes[1]!.offerId }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('evaluates the cancellation deadline in the property timezone', async () => {
    // 2027-03-10T17:00Z is still 2027-03-10 in UTC but already 2027-03-11
    // in Bangkok (UTC+7).
    const instant = new Date('2027-03-10T17:00:00.000Z');
    const deadline = '2027-03-10';

    const adapter = new AgodaMockAdapter({ seed: 37, processingPolls: 0 });
    ctx = makeContext(adapter, () => instant);
    const bangkok = await seedStay(ctx, adapter, {
      now: instant,
      timeZone: 'Asia/Bangkok',
      freeCancellationUntil: deadline,
    });
    const order = await orderStay(ctx, bangkok, key('book'));
    await payAndConfirm(ctx, order.orderNo);

    // In Bangkok the deadline has already passed, so the cancellation is
    // refused. Deciding this in UTC would have refunded a customer who was
    // still entitled to a free cancellation.
    await expect(
      cancelBooking(ctx, order.orderNo, { idempotencyKey: key('cancel'), reason: '行程变更' }),
    ).rejects.toMatchObject({ code: 'CANCEL_NOT_ALLOWED' });

    // The same instant, the same deadline, but the property is in UTC: the
    // customer is still on time and gets the money back.
    const adapterUtc = new AgodaMockAdapter({ seed: 38, processingPolls: 0 });
    const ctxUtc = makeContext(adapterUtc, () => instant);
    const utcStay = await seedStay(ctxUtc, adapterUtc, {
      now: instant,
      timeZone: 'UTC',
      freeCancellationUntil: deadline,
    });
    const utcOrder = await orderStay(ctxUtc, utcStay, key('book'));
    await payAndConfirm(ctxUtc, utcOrder.orderNo);

    const cancelled = await cancelBooking(ctxUtc, utcOrder.orderNo, {
      idempotencyKey: key('cancel'),
      reason: '行程变更',
    });
    expect(cancelled.cancellation.cancelled).toBe(true);
    expect(cancelled.cancellation.refundAmount.amount).toBeGreaterThan(0);
  });
});
