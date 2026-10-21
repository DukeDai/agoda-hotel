import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/lib/bootstrap.js';
import { buildServer } from '../src/server.js';
import { processOutboxOnce } from '../src/modules/notify/index.js';
import type { AppContext } from '../src/lib/context.js';

/**
 * End-to-end test of the whole customer journey against a REAL Postgres and
 * the high-fidelity mock supplier.
 *
 * The assertions map 1:1 onto the acceptance criteria in SPEC.md §8.
 */

const CHECK_IN = '2026-12-01';
const CHECK_OUT = '2026-12-03';
const DESTINATION = 'Phuket';

const TABLES = [
  'NotificationDelivery',
  'WebhookDelivery',
  'WebhookEndpoint',
  'OutboxEvent',
  'AuditLog',
  'Refund',
  'Payment',
  'BookingEvent',
  'BookingGuest',
  'BookingItem',
  'Booking',
  'AvailabilityQuote',
  'RatePlan',
  'RoomType',
  'HotelAmenity',
  'HotelImage',
  'Hotel',
  'IdempotencyRecord',
  'SyncJob',
];

async function truncateAll(ctx: AppContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE;`,
  );
}

function uuid(): string {
  return `test-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

describe('OTA booking lifecycle', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let hotelId = '';
  let offerId = '';
  let orderNo = '';

  beforeAll(async () => {
    const config = loadConfig();
    ctx = createContext(config);
    await truncateAll(ctx);
    app = await buildServer({ config });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.prisma.$disconnect();
  });

  it('M1: syncs the supplier catalog and is idempotent on re-run', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/sync/hotels',
      payload: { limit: 50 },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { total: number; created: number };
    expect(firstBody.total).toBeGreaterThan(0);
    expect(firstBody.created).toBeGreaterThan(0);

    const hotelsAfterFirst = await ctx.prisma.hotel.count();
    expect(hotelsAfterFirst).toBeGreaterThan(0);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/sync/hotels',
      payload: { limit: 50 },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { created: number; skipped: number };
    // The second run must not create anything new.
    expect(secondBody.created).toBe(0);
    expect(secondBody.skipped).toBeGreaterThan(0);

    const hotelsAfterSecond = await ctx.prisma.hotel.count();
    expect(hotelsAfterSecond).toBe(hotelsAfterFirst);
  });

  it('M2: searches hotels and returns prices for the requested stay', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/hotels/search?destination=${encodeURIComponent(DESTINATION)}&checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&rooms=1&adults=2&currency=CNY&nationality=CN`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      hotels: Array<{ id: string; name: string; lowestStayTotal: { amount: number } | null }>;
      nights: number;
      total: number;
    };
    expect(body.nights).toBe(2);
    expect(body.hotels.length).toBeGreaterThan(0);
    const priced = body.hotels.find((h) => h.lowestStayTotal && h.lowestStayTotal.amount > 0);
    expect(priced).toBeDefined();
    hotelId = body.hotels[0]!.id;
  });

  it('M2: exposes room-level availability with integer minor-unit money', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/hotels/${hotelId}/availability?checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&rooms=1&adults=2&currency=CNY&nationality=CN`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      quotes: Array<{
        offerId: string;
        nights: number;
        nightly: { total: { amount: number } };
        stayTotal: { total: { amount: number } };
        cancellationPolicy: { type: string };
        contextFingerprint?: string;
      }>;
    };
    expect(body.quotes.length).toBeGreaterThan(0);
    const quote = body.quotes[0]!;
    expect(quote.nights).toBe(2);
    expect(Number.isInteger(quote.nightly.total.amount)).toBe(true);
    // The tax is recomputed on the stay total, so rounding may differ by one
    // minor unit from "nightly total x nights".
    expect(
      Math.abs(quote.stayTotal.total.amount - quote.nightly.total.amount * quote.nights),
    ).toBeLessThanOrEqual(1);
    expect(['FULL_REFUND', 'PARTIAL_REFUND', 'NON_REFUNDABLE']).toContain(quote.cancellationPolicy.type);
    offerId = quote.offerId;

    // The quote must be persisted with a fingerprint the booking module can
    // reproduce, otherwise the order would be rejected as parameter drift.
    const stored = await ctx.prisma.availabilityQuote.findFirst({ where: { offerId } });
    expect(stored).not.toBeNull();
    expect(stored!.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('M2: precheck re-validates the quote and reports no price change by default', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/quotes/precheck',
      payload: {
        hotelId,
        offerId,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        rooms: 1,
        adults: 2,
        childAges: [],
        currency: 'CNY',
        nationality: 'CN',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { priceChanged: boolean; available: boolean; total: { amount: number } };
    expect(body.available).toBe(true);
    expect(body.priceChanged).toBe(false);
    expect(body.total.amount).toBeGreaterThan(0);
  });

  it('M3: creates an order and replays it on the same Idempotency-Key', async () => {
    const key = uuid();
    const payload = {
      hotelId,
      offerId,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nationality: 'CN',
      guest: {
        firstName: '张',
        lastName: '三',
        email: 'zhangsan@example.com',
        phone: '+8613800000000',
      },
      specialRequests: ['延迟退房'],
    };

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { orderNo: string; status: string; price: { total: { amount: number } } };
    expect(body.status).toBe('PENDING_PAYMENT');
    expect(body.price.total.amount).toBeGreaterThan(0);
    orderNo = body.orderNo;

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { orderNo: string }).orderNo).toBe(orderNo);

    const bookings = await ctx.prisma.booking.count();
    expect(bookings).toBe(1);
  });

  it('M3: rejects the same Idempotency-Key with a different payload', async () => {
    const key = uuid();
    const payload = {
      hotelId,
      offerId,
      checkIn: CHECK_IN,
      checkOut: CHECK_OUT,
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nationality: 'CN',
      guest: { firstName: '李', lastName: '四', email: 'lisi@example.com' },
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { 'idempotency-key': key },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { 'idempotency-key': key },
      payload: { ...payload, guest: { ...payload.guest, email: 'other@example.com' } },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('M4: does NOT report the booking as confirmed while the supplier is processing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${orderNo}/pay`,
      headers: { 'idempotency-key': uuid() },
      payload: { method: 'mock_card' },
    });
    expect(res.statusCode).toBe(200);
    // The payment response is the contract shape: the order lives in
    // `booking` (docs/api-contract.md §6).
    const body = res.json() as {
      orderNo: string;
      status: string;
      payment: { status: string } | null;
      booking: { status: string; confirmationNumber: string | null; supplierStatus: string | null };
    };
    expect(body.orderNo).toBe(orderNo);
    expect(body.status).toBe(body.booking.status);
    expect(body.payment?.status).toBe('CAPTURED');

    // The mock supplier answers `processing: true`, so the order MUST NOT be
    // CONFIRMED yet. Reporting success here is the classic Agoda integration
    // failure this whole design is built to prevent.
    expect(body.status).not.toBe('CONFIRMED');
    expect(['BOOKING_SUBMITTED', 'PAID']).toContain(body.status);
    expect(body.booking.confirmationNumber).toBeNull();

    const stored = await ctx.prisma.booking.findUnique({ where: { orderNo } });
    expect(stored!.status).toBe('BOOKING_SUBMITTED');
  });

  it('M4: confirms the booking once the supplier settles it', async () => {
    let body: { status: string; confirmationNumber: string | null } | undefined;
    for (let i = 0; i < 5; i += 1) {
      await app.inject({ method: 'POST', url: '/api/v1/admin/bookings/poll' });
      const res = await app.inject({ method: 'GET', url: `/api/v1/bookings/${orderNo}` });
      body = res.json() as { status: string; confirmationNumber: string | null };
      if (body.status === 'CONFIRMED') break;
    }
    expect(body!.status).toBe('CONFIRMED');
    expect(body!.confirmationNumber).toBeTruthy();
  });

  it('M5: cancels within the free-cancellation window and refunds the full amount', async () => {
    const before = await ctx.prisma.refund.count();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${orderNo}/cancel`,
      headers: { 'idempotency-key': uuid() },
      payload: { reason: '行程变更' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      booking: { status: string; price: { total: { amount: number }; refunded: { amount: number } } };
      cancellation: { penaltyAmount: { amount: number }; refundAmount: { amount: number } };
    };
    expect(body.cancellation.penaltyAmount.amount).toBe(0);
    expect(body.cancellation.refundAmount.amount).toBeGreaterThan(0);
    expect(body.booking.price.refunded.amount).toBe(body.cancellation.refundAmount.amount);
    expect(['REFUNDED', 'REFUND_PENDING']).toContain(body.booking.status);

    const refunds = await ctx.prisma.refund.count();
    expect(refunds).toBe(before + 1);
  });

  it('M5: a second cancellation does not refund twice', async () => {
    const refundsBefore = await ctx.prisma.refund.count();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${orderNo}/cancel`,
      headers: { 'idempotency-key': uuid() },
      payload: { reason: '再改一次' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('CANCEL_NOT_ALLOWED');
    const refundsAfter = await ctx.prisma.refund.count();
    expect(refundsAfter).toBe(refundsBefore);
  });

  it('M3: a declined payment leaves the order unpaid and never books', async () => {
    const key = uuid();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/bookings',
      headers: { 'idempotency-key': key },
      payload: {
        hotelId,
        offerId,
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        rooms: 1,
        adults: 2,
        childAges: [],
        currency: 'CNY',
        nationality: 'CN',
        guest: { firstName: '王', lastName: '五', email: 'wangwu@example.com' },
      },
    });
    expect(created.statusCode).toBe(201);
    const declinedOrder = (created.json() as { orderNo: string }).orderNo;

    const paid = await app.inject({
      method: 'POST',
      url: `/api/v1/bookings/${declinedOrder}/pay`,
      headers: { 'idempotency-key': uuid() },
      payload: { method: 'mock_card_decline' },
    });
    expect(paid.statusCode).toBe(402);
    expect((paid.json() as { error: { code: string } }).error.code).toBe('PAYMENT_FAILED');

    const stored = await ctx.prisma.booking.findUnique({ where: { orderNo: declinedOrder } });
    expect(stored!.status).toBe('PENDING_PAYMENT');
    expect(stored!.supplierBookingId).toBeNull();
  });

  it('M6: writes domain events to the transactional outbox', async () => {
    const events = await ctx.prisma.outboxEvent.findMany({ select: { topic: true } });
    const topics = events.map((e) => e.topic);
    expect(topics).toContain('booking.created');
    expect(topics).toContain('booking.paid');
    expect(topics).toContain('booking.confirmed');
  });

  it('M6: actually delivers the customer notification over the email channel', async () => {
    // The outbox events must carry a destination, otherwise the customer
    // channels silently have nothing to deliver to.
    const events = await ctx.prisma.outboxEvent.findMany({
      where: { topic: 'booking.confirmed' },
      select: { payload: true },
    });
    expect(events.length).toBeGreaterThan(0);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.guestEmail).toBe('zhangsan@example.com');

    await processOutboxOnce(ctx);

    const deliveries = await ctx.prisma.notificationDelivery.findMany({
      where: { channel: 'email' },
      orderBy: { createdAt: 'asc' },
    });
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[0]!.status).toBe('SENT');
    expect(deliveries[0]!.destination).toBe('zhangsan@example.com');
  });
});
