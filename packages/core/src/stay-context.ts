import type { Currency } from './money.js';
import type { LocalDate } from './date.js';
import { nights } from './date.js';
import { fingerprint } from './ids.js';

/**
 * The Search → Precheck → Book context.
 *
 * Agoda requires that dates, occupancy, room count, currency and guest
 * country are IDENTICAL across those three calls, and rejects bookings
 * whose parameters drifted from the quoted ones. We therefore model the
 * context as a single immutable value, fingerprint it, and persist the
 * fingerprint on the order so we can prove the chain was consistent.
 */
export interface StayContext {
  /** Supplier-side hotel identifier (Agoda hotel id). */
  supplierHotelId: string;
  checkIn: LocalDate;
  checkOut: LocalDate;
  rooms: number;
  adults: number;
  /** Ages of children; Agoda requires the ages, not just the count. */
  childAges: number[];
  currency: Currency;
  /** ISO 3166-1 alpha-2 country of the guest's nationality. */
  nationality: string;
}

export function stayNights(ctx: StayContext): number {
  return nights(ctx.checkIn, ctx.checkOut);
}

export function stayGuests(ctx: StayContext): number {
  return ctx.adults + ctx.childAges.length;
}

/**
 * Stable fingerprint of the parameter set. Anything that would change the
 * price or the availability (dates, rooms, occupancy, currency, country)
 * MUST change this value.
 */
export function fingerprintStayContext(ctx: StayContext): string {
  return fingerprint({
    supplierHotelId: ctx.supplierHotelId,
    checkIn: ctx.checkIn,
    checkOut: ctx.checkOut,
    rooms: ctx.rooms,
    adults: ctx.adults,
    childAges: [...ctx.childAges].sort((a, b) => a - b),
    currency: ctx.currency,
    nationality: ctx.nationality.toUpperCase(),
  });
}

/** Two contexts are comparable only if their fingerprints match. */
export function isSameStayContext(a: StayContext, b: StayContext): boolean {
  return fingerprintStayContext(a) === fingerprintStayContext(b);
}
