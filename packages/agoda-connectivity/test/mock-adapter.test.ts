import { describe, expect, it } from 'vitest';
import { AgodaMockAdapter } from '../src/mock/adapter.js';
import type { SupplierBookingInput, SupplierPrecheckInput, SupplierSearchQuery } from '../src/contract.js';

const query: SupplierSearchQuery = {
  destination: { cityId: '9398', name: 'Phuket', countryCode: 'TH' },
  checkIn: '2026-11-01',
  checkOut: '2026-11-03',
  rooms: 1,
  adults: 2,
  childAges: [],
  currency: 'USD',
  nationality: 'CN',
};

const FINGERPRINT = 'fp-stay-1';

function guest(overrides: { firstName?: string; lastName?: string } = {}) {
  return {
    firstName: overrides.firstName ?? 'Ann',
    lastName: overrides.lastName ?? 'Lee',
    email: 'ann@example.com',
    phone: '+66 2 000 0000',
    nationality: 'CN',
    isLead: true,
  };
}

function bookingInput(offerId: string, expectedTotal: number, idempotencyKey: string): SupplierBookingInput {
  return {
    supplierHotelId: '90001',
    offerId,
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    rooms: query.rooms,
    adults: query.adults,
    childAges: query.childAges,
    currency: query.currency,
    nationality: query.nationality,
    guests: [guest()],
    allowDuplication: true,
    idempotencyKey,
    contextFingerprint: FINGERPRINT,
    expectedTotal: { amount: expectedTotal, currency: 'USD' },
  };
}

async function firstOffer(mock: AgodaMockAdapter) {
  const availability = await mock.getAvailability({ ...query, hotelIds: ['90001'] });
  const quote = availability[0]?.quotes[0];
  if (!quote) throw new Error('no quote');
  return quote;
}

describe('AgodaMockAdapter - catalogue & search', () => {
  it('serves at least 8 hotels with room types, amenities and policies', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    const hotels = await mock.listHotels();

    expect(hotels.length).toBeGreaterThanOrEqual(8);
    const patong = hotels.find((hotel) => hotel.id === '90001');
    expect(patong?.name).toBe('Patong Bayview Resort');
    expect(patong?.starRating).toBe(5);
    expect(patong?.roomTypes.length).toBeGreaterThanOrEqual(2);
    expect(patong?.images.length).toBeGreaterThan(0);
    expect(patong?.amenities.length).toBeGreaterThan(0);
    expect(patong?.policies?.length).toBeGreaterThan(0);
    expect(patong?.checkInTime).toBe('14:00');
    expect(patong?.raw).toBeTypeOf('string');
  });

  it('filters the catalogue by destination and paginates', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });

    const phuket = await mock.listHotels({ destination: { cityId: '9398' } });
    expect(phuket).toHaveLength(2);

    const page = await mock.listHotels({ page: 1, pageSize: 3 });
    expect(page).toHaveLength(3);
  });

  it('returns hotel summaries with prices computed from the quote set', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    const result = await mock.searchHotels(query);

    expect(result.hotels.length).toBeGreaterThan(0);
    expect(result.currency).toBe('USD');

    const summary = result.hotels[0];
    expect(summary?.lowestNightlyTotal).toBeDefined();
    expect(summary?.lowestStayTotal).toBeDefined();
    expect(summary?.lowestStayTotal?.amount).toBeGreaterThan(summary?.lowestNightlyTotal?.amount ?? 0);

    // The summary price is the cheapest offer of the same quote set.
    const availability = await mock.getAvailability({ ...query, hotelIds: [summary?.id ?? ''] });
    const cheapest = availability[0]?.quotes.reduce(
      (min, quote) => (quote.stayTotal.total.amount < min ? quote.stayTotal.total.amount : min),
      Number.POSITIVE_INFINITY,
    );
    expect(summary?.lowestStayTotal?.amount).toBe(cheapest);
  });

  it('returns room level quotes with nightly, stay, tax and policy', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    const [availability] = await mock.getAvailability({ ...query, hotelIds: ['90001'] });

    expect(availability?.quotes.length).toBeGreaterThan(1);
    const quote = availability?.quotes[0];
    expect(quote?.nightly.total.amount).toBeGreaterThan(0);
    expect(quote?.stayTotal.total.amount).toBe(quote!.nightly.total.amount * quote!.nights);
    expect(quote?.stayTotal.taxes.amount).toBeGreaterThan(0);
    expect(quote?.cancellationPolicy.type).toBeDefined();
    expect(quote?.allotment).toBeGreaterThan(0);
  });
});

describe('AgodaMockAdapter - booking lifecycle', () => {
  it('walks search -> availability -> precheck -> book -> CONFIRMED', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });

    const search = await mock.searchHotels(query);
    expect(search.hotels.length).toBeGreaterThan(0);

    const availability = await mock.getAvailability({ ...query, hotelIds: ['90001'] });
    const quote = availability[0]?.quotes[0];
    expect(quote).toBeDefined();

    const precheckInput: SupplierPrecheckInput = {
      supplierHotelId: '90001',
      offerId: quote!.offerId,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      rooms: query.rooms,
      adults: query.adults,
      childAges: query.childAges,
      currency: query.currency,
      nationality: query.nationality,
      contextFingerprint: FINGERPRINT,
    };
    const precheck = await mock.precheck(precheckInput);
    expect(precheck.available).toBe(true);
    expect(precheck.priceChanged).toBe(false);

    const booked = await mock.book(
      bookingInput(quote!.offerId, precheck.quote.stayTotal.total.amount, 'idem-1'),
    );

    // Agoda reserves the allotment first: NOT confirmed yet.
    expect(booked.status).toBe('PROCESSING');
    expect(booked.processing).toBe(true);
    expect(booked.confirmationNumber).toBeUndefined();
    expect(booked.supplierBookingId).toBeTruthy();

    const first = await mock.getBooking(booked.supplierBookingId);
    expect(first.status).toBe('PROCESSING');
    expect(first.processing).toBe(true);

    const second = await mock.getBooking(booked.supplierBookingId);
    expect(second.status).toBe('PROCESSING');
    expect(second.processing).toBe(true);

    const third = await mock.getBooking(booked.supplierBookingId);
    expect(third.status).toBe('CONFIRMED');
    expect(third.processing).toBe(false);
    expect(third.confirmationNumber).toBeTruthy();
    expect(third.checkIn).toBe(query.checkIn);
    expect(third.checkOut).toBe(query.checkOut);
    expect(third.guests[0]?.email).toBe('ann@example.com');
    expect(third.total).toEqual(precheck.quote.stayTotal.total);
  });

  it('is idempotent for the same idempotency key', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    const quote = await firstOffer(mock);
    const total = quote.stayTotal.total.amount;

    const first = await mock.book(bookingInput(quote.offerId, total, 'idem-same'));
    const second = await mock.book(bookingInput(quote.offerId, total, 'idem-same'));

    expect(second.supplierBookingId).toBe(first.supplierBookingId);
    expect(mock.bookingCount).toBe(1);
  });

  it('rejects a duplicate booking even though allowDuplication is true', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    const quote = await firstOffer(mock);
    const total = quote.stayTotal.total.amount;

    await mock.book(bookingInput(quote.offerId, total, 'idem-a'));
    await expect(mock.book(bookingInput(quote.offerId, total, 'idem-b'))).rejects.toMatchObject({
      code: 'DUPLICATE_BOOKING',
    });
  });

  it('reports a price change when the expected total does not match', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    const quote = await firstOffer(mock);

    await expect(mock.book(bookingInput(quote.offerId, 1, 'idem-price'))).rejects.toMatchObject({
      code: 'PRICE_CHANGED',
    });
  });

  it('raises HOTEL_NOT_FOUND for an unknown hotel', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    await expect(mock.getHotel('does-not-exist')).rejects.toMatchObject({ code: 'HOTEL_NOT_FOUND' });
  });

  it('raises NOT_FOUND for an unknown booking', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    await expect(mock.getBooking('AGBK-nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('AgodaMockAdapter - failure modes', () => {
  it('detects a price drift at precheck', async () => {
    const mock = new AgodaMockAdapter({ seed: 42, priceDriftRate: 1 });
    const quote = await firstOffer(mock);

    const precheck = await mock.precheck({
      supplierHotelId: '90001',
      offerId: quote.offerId,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      rooms: query.rooms,
      adults: query.adults,
      childAges: query.childAges,
      currency: query.currency,
      nationality: query.nationality,
      contextFingerprint: FINGERPRINT,
    });

    expect(precheck.priceChanged).toBe(true);
    expect(precheck.quote.stayTotal.total.amount).toBeGreaterThan(quote.stayTotal.total.amount);
  });

  it('keeps the price stable when the drift rate is 0', async () => {
    const mock = new AgodaMockAdapter({ seed: 42, priceDriftRate: 0 });
    const quote = await firstOffer(mock);

    const precheck = await mock.precheck({
      supplierHotelId: '90001',
      offerId: quote.offerId,
      checkIn: query.checkIn,
      checkOut: query.checkOut,
      rooms: query.rooms,
      adults: query.adults,
      childAges: query.childAges,
      currency: query.currency,
      nationality: query.nationality,
      contextFingerprint: FINGERPRINT,
    });

    expect(precheck.priceChanged).toBe(false);
    expect(precheck.quote.stayTotal.total.amount).toBe(quote.stayTotal.total.amount);
  });

  it('raises ROOM_UNAVAILABLE when the offer sold out before precheck', async () => {
    const mock = new AgodaMockAdapter({ seed: 42, sellOutRate: 1 });
    const quote = await firstOffer(mock);

    await expect(
      mock.precheck({
        supplierHotelId: '90001',
        offerId: quote.offerId,
        checkIn: query.checkIn,
        checkOut: query.checkOut,
        rooms: query.rooms,
        adults: query.adults,
        childAges: query.childAges,
        currency: query.currency,
        nationality: query.nationality,
        contextFingerprint: FINGERPRINT,
      }),
    ).rejects.toMatchObject({ code: 'ROOM_UNAVAILABLE' });
  });

  it('raises SUPPLIER_RATE_LIMITED when the quota is exhausted', async () => {
    const mock = new AgodaMockAdapter({ seed: 42, rateLimitRpm: 1, rateLimitBurst: 1 });

    await mock.searchHotels(query);
    await expect(mock.searchHotels(query)).rejects.toMatchObject({ code: 'SUPPLIER_RATE_LIMITED' });
  });

  it('injects a timeout and a 5xx-like error', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });

    mock.failNext(1, 'timeout');
    await expect(mock.searchHotels(query)).rejects.toMatchObject({ code: 'SUPPLIER_TIMEOUT' });

    mock.failNext(1, 'error');
    await expect(mock.searchHotels(query)).rejects.toMatchObject({ code: 'SUPPLIER_ERROR' });

    // The injection is consumed: the next call succeeds.
    await expect(mock.searchHotels(query)).resolves.toBeDefined();
  });

  it('injects a supplier side rejection', async () => {
    const mock = new AgodaMockAdapter({ seed: 42 });
    mock.failNext(1, 'rejected');

    await expect(mock.searchHotels(query)).rejects.toMatchObject({
      code: 'BOOKING_REJECTED',
      details: { supplierCode: 'SUPPLIER_REJECTED' },
    });
  });
});

describe('AgodaMockAdapter - cancellation', () => {
  it('applies the cancellation policy of the rate and is idempotent', async () => {
    const mock = new AgodaMockAdapter({ seed: 42, now: () => new Date('2026-10-01T00:00:00Z') });
    const availability = await mock.getAvailability({ ...query, hotelIds: ['90001'] });
    const nonRefundable = availability[0]?.quotes.find((quote) =>
      quote.ratePlanName.includes('Non Refundable'),
    );
    expect(nonRefundable).toBeDefined();

    const booked = await mock.book(
      bookingInput(nonRefundable!.offerId, nonRefundable!.stayTotal.total.amount, 'idem-cancel'),
    );

    const cancelled = await mock.cancel({
      supplierBookingId: booked.supplierBookingId,
      reason: 'guest changed plans',
      idempotencyKey: 'cancel-1',
    });

    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.penaltyAmount?.amount).toBe(nonRefundable!.stayTotal.total.amount);
    expect(cancelled.refundAmount?.amount).toBe(0);

    // Cancelling twice must not charge a second penalty.
    const again = await mock.cancel({
      supplierBookingId: booked.supplierBookingId,
      idempotencyKey: 'cancel-2',
    });
    expect(again.cancelled).toBe(true);
    expect(again.penaltyAmount?.amount).toBe(cancelled.penaltyAmount?.amount);
    expect(again.refundAmount?.amount).toBe(cancelled.refundAmount?.amount);
  });

  it('refunds a flexible rate cancelled before the deadline', async () => {
    const mock = new AgodaMockAdapter({ seed: 42, now: () => new Date('2026-10-01T00:00:00Z') });
    const availability = await mock.getAvailability({ ...query, hotelIds: ['90001'] });
    const flexible = availability[0]?.quotes.find((quote) => quote.ratePlanName.includes('Flexible'));
    expect(flexible).toBeDefined();

    const booked = await mock.book(
      bookingInput(flexible!.offerId, flexible!.stayTotal.total.amount, 'idem-flex'),
    );
    const cancelled = await mock.cancel({
      supplierBookingId: booked.supplierBookingId,
      idempotencyKey: 'cancel-flex',
    });

    expect(cancelled.penaltyAmount?.amount).toBe(0);
    expect(cancelled.refundAmount?.amount).toBe(flexible!.stayTotal.total.amount);
  });
});

describe('AgodaMockAdapter - determinism', () => {
  it('produces identical quotes for two adapters with the same seed', async () => {
    const a = new AgodaMockAdapter({ seed: 20261020 });
    const b = new AgodaMockAdapter({ seed: 20261020 });

    const quotesA = await a.getAvailability({ ...query, hotelIds: ['90001', '90005'] });
    const quotesB = await b.getAvailability({ ...query, hotelIds: ['90001', '90005'] });

    expect(quotesB).toEqual(quotesA);
  });

  it('produces different quotes for a different seed', async () => {
    const a = new AgodaMockAdapter({ seed: 1 });
    const b = new AgodaMockAdapter({ seed: 2 });

    const quotesA = await a.getAvailability({ ...query, hotelIds: ['90001'] });
    const quotesB = await b.getAvailability({ ...query, hotelIds: ['90001'] });

    expect(quotesB[0]?.quotes[0]?.stayTotal.total.amount).not.toBe(
      quotesA[0]?.quotes[0]?.stayTotal.total.amount,
    );
  });
});
