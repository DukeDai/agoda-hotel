import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgodaMockAdapter } from '@ota/agoda-connectivity';
import { fingerprintStayContext, type StayContext } from '@ota/core';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/lib/logger.js';
import { getPrisma } from '../src/lib/prisma.js';
import { createCacheBundle } from '../src/lib/cache.js';
import { createPaymentProvider } from '../src/modules/payment/index.js';
import { createBooking, payBooking, pollPendingBookings } from '../src/modules/booking/service.js';
import type { AppContext } from '../src/lib/context.js';

/**
 * Failure-path tests for the booking engine.
 *
 * These are the scenarios that lose money when they are wrong:
 *  - the supplier rejects the booking AFTER the customer paid  -> refund
 *  - the supplier times out                                -> retry, no refund
 */

const HOTEL_ID = '90001';

function makeContext(adapter: AgodaMockAdapter): AppContext {
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
    now: () => new Date(),
  };
}

async function seedQuote(
  ctx: AppContext,
  adapter: AgodaMockAdapter,
  checkIn: string,
  checkOut: string,
): Promise<{ offerId: string; total: number }> {
  const hotel = await ctx.prisma.hotel.upsert({
    where: { supplier_supplierHotelId: { supplier: 'agoda', supplierHotelId: HOTEL_ID } },
    update: {},
    create: {
      supplier: 'agoda',
      supplierHotelId: HOTEL_ID,
      name: 'Patong Bayview Resort',
      slug: 'patong-bayview-resort',
      city: 'Phuket',
      country: 'Thailand',
      countryCode: 'TH',
      starRating: 4,
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
      freeCancellationUntil: new Date('2027-01-08T00:00:00.000Z'),
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

  // The quote MUST come from the supplier: the mock validates the amount we
  // expect to be charged, and a hand-written price would look like a price
  // change to the supplier.
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
      cancellationType: quote.cancellationPolicy.type,
      freeCancellationUntil: quote.cancellationPolicy.freeCancellationUntil
        ? new Date(`${quote.cancellationPolicy.freeCancellationUntil}T00:00:00.000Z`)
        : null,
      penaltyAmount: quote.cancellationPolicy.penaltyAmount?.amount ?? null,
      penaltyPercent: quote.cancellationPolicy.penaltyPercent ?? null,
      contextFingerprint: fingerprintStayContext(stay),
      expiresAt: new Date(Date.now() + 600_000),
    },
  });

  return { offerId: quote.offerId, total: quote.stayTotal.total.amount };
}

describe('booking failure handling', () => {
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

  it('refunds the customer in full when the supplier rejects the booking after payment', async () => {
    const adapter = new AgodaMockAdapter({ seed: 11, processingPolls: 0 });
    ctx = makeContext(adapter);
    const { offerId, total } = await seedQuote(ctx, adapter, '2027-01-10', '2027-01-12');

    const booking = await createBooking(ctx, {
      hotelId: (await ctx.prisma.hotel.findFirstOrThrow({ where: { supplierHotelId: HOTEL_ID } })).id,
      offerId,
      checkIn: '2027-01-10',
      checkOut: '2027-01-12',
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nationality: 'CN',
      guest: { firstName: '陈', lastName: '六', email: 'chenliu@example.com' },
      idempotencyKey: `key-${Date.now()}-reject`,
    });

    expect(booking.status).toBe('PENDING_PAYMENT');

    // The supplier rejects the booking right after we captured the money.
    adapter.failNext(1, 'rejected');

    const paid = await payBooking(ctx, booking.orderNo, {
      idempotencyKey: `pay-${Date.now()}-reject`,
      method: 'mock_card',
    });

    expect(['FAILED', 'REFUNDED']).toContain(paid.status);

    const refunds = await ctx.prisma.refund.findMany({ where: { bookingId: booking.id } });
    expect(refunds.length).toBe(1);
    expect(refunds[0]!.status).toBe('SUCCEEDED');
    expect(refunds[0]!.amount).toBe(total);

    const stored = await ctx.prisma.booking.findUnique({ where: { id: booking.id } });
    expect(stored!.refundedAmount).toBe(total);
    expect(stored!.paidAmount).toBe(total);
  });

  it('keeps the money and retries when the supplier fails transiently', async () => {
    const adapter = new AgodaMockAdapter({ seed: 12, processingPolls: 0 });
    ctx = makeContext(adapter);
    const { offerId } = await seedQuote(ctx, adapter, '2027-02-10', '2027-02-12');

    const booking = await createBooking(ctx, {
      hotelId: (await ctx.prisma.hotel.findFirstOrThrow({ where: { supplierHotelId: HOTEL_ID } })).id,
      offerId,
      checkIn: '2027-02-10',
      checkOut: '2027-02-12',
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nationality: 'CN',
      guest: { firstName: '周', lastName: '七', email: 'zhouqi@example.com' },
      idempotencyKey: `key-${Date.now()}-transient`,
    });

    // A transient upstream failure must NOT refund and must NOT lose the order.
    adapter.failNext(1, 'error');

    const paid = await payBooking(ctx, booking.orderNo, {
      idempotencyKey: `pay-${Date.now()}-transient`,
      method: 'mock_card',
    });
    expect(paid.status).toBe('PAID');

    const refunds = await ctx.prisma.refund.findMany({ where: { bookingId: booking.id } });
    expect(refunds.length).toBe(0);

    const degraded = await ctx.prisma.outboxEvent.findFirst({
      where: { topic: 'supplier.degraded', aggregateId: booking.id },
    });
    expect(degraded).not.toBeNull();

    // The background poller picks the order up and completes it.
    const result = await pollPendingBookings(ctx);
    expect(result.checked).toBeGreaterThan(0);

    const stored = await ctx.prisma.booking.findUnique({ where: { id: booking.id } });
    const events = await ctx.prisma.bookingEvent.findMany({
    where: { bookingId: booking.id },
    orderBy: { createdAt: 'asc' },
  });
  const trace = events.map((e) => `${e.type}:${JSON.stringify(e.data ?? {})}`).join(' | ');
  expect(stored!.status, `status=${stored!.status} failure=${stored!.failureReason} events=${trace}`).toBe(
    'CONFIRMED',
  );
  expect(stored!.confirmationNumber).toBeTruthy();
  });
});
