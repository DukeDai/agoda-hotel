import { AppError, fingerprintStayContext, isCurrency, isLocalDate, isValidStay, nights } from '@ota/core';
import type { Currency, StayContext } from '@ota/core';

/**
 * Parameter normalisation for the search module.
 *
 * Everything that reaches the supplier goes through here first, so the three
 * calls of the chain (Search → Precheck → Book) always carry the very same
 * normalised values. That is what makes the stay fingerprint reproducible.
 */

export const MAX_NIGHTS = 30;
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_CURRENCY: Currency = 'CNY';
export const DEFAULT_NATIONALITY = 'CN';
export const MAX_CHILD_AGES = 6;
export const MAX_ROOMS = 9;
export const MAX_ADULTS = 16;

export interface StayInput {
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges?: number[];
  currency?: string;
  nationality?: string;
}

export interface NormalizedStay {
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: Currency;
  nationality: string;
}

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION_ERROR', message, { details });
}

function integerInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`${field} 必须是 ${min}~${max} 之间的整数`, { field, value });
  }
  return parsed;
}

/**
 * Currency.
 *
 * The value is NOT case-folded: the booking module stores the currency string
 * the client sent and derives its fingerprint from it, so folding the case
 * here would make the fingerprint of a quote and of an order differ. An
 * unknown currency is rejected instead.
 */
export function normalizeCurrency(value?: string): Currency {
  if (value === undefined || value === null || value === '') return DEFAULT_CURRENCY;
  if (!isCurrency(value)) {
    throw invalid('币种必须是 ISO 4217 三字母大写代码，例如 CNY', { currency: value });
  }
  return value;
}

/** Nationality: ISO 3166-1 alpha-2, upper case. */
export function normalizeNationality(value?: string): string {
  if (value === undefined || value === null || value === '') return DEFAULT_NATIONALITY;
  const upper = String(value).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) {
    throw invalid('国籍必须是 ISO 3166-1 alpha-2 两位代码，例如 CN', { nationality: value });
  }
  return upper;
}

/** Children are priced by their age, so the ages have to be explicit. */
export function normalizeChildAges(value?: number[]): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw invalid('childAges 必须是儿童年龄数组', { childAges: value });
  }
  if (value.length > MAX_CHILD_AGES) {
    throw invalid(`儿童人数不能超过 ${MAX_CHILD_AGES}`, { childAges: value });
  }
  return value.map((age) => {
    if (!Number.isInteger(age) || age < 0 || age > 17) {
      throw invalid('儿童年龄必须是 0~17 之间的整数', { childAges: value });
    }
    return age;
  });
}

/**
 * Validate and normalise the stay parameters.
 *
 * The result is the ONLY thing that is allowed to reach the supplier.
 */
export function normalizeStay(input: StayInput): NormalizedStay {
  const checkIn = typeof input.checkIn === 'string' ? input.checkIn.trim() : '';
  const checkOut = typeof input.checkOut === 'string' ? input.checkOut.trim() : '';

  if (!isLocalDate(checkIn) || !isLocalDate(checkOut)) {
    throw invalid('入住/离店日期格式必须为 YYYY-MM-DD', { checkIn: input.checkIn, checkOut: input.checkOut });
  }
  if (!isValidStay(checkIn, checkOut)) {
    throw invalid('离店日期必须晚于入住日期', { checkIn, checkOut });
  }

  const stayNights = nights(checkIn, checkOut);
  if (stayNights > MAX_NIGHTS) {
    throw invalid(`单次入住最多 ${MAX_NIGHTS} 晚`, { nights: stayNights });
  }

  return {
    checkIn,
    checkOut,
    nights: stayNights,
    rooms: integerInRange(input.rooms, 'rooms', 1, MAX_ROOMS, 1),
    adults: integerInRange(input.adults, 'adults', 1, MAX_ADULTS, 2),
    childAges: normalizeChildAges(input.childAges),
    currency: normalizeCurrency(input.currency),
    nationality: normalizeNationality(input.nationality),
  };
}

/**
 * Build the stay context of a request.
 *
 * This is the object the booking module rebuilds when it places the order.
 * The two MUST be identical, otherwise Agoda sees parameter drift and
 * rejects the booking.
 */
export function buildStayContext(supplierHotelId: string, stay: NormalizedStay): StayContext {
  return {
    supplierHotelId,
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms: stay.rooms,
    adults: stay.adults,
    childAges: [...stay.childAges],
    currency: stay.currency,
    nationality: stay.nationality.toUpperCase(),
  };
}

/**
 * The fingerprint stored on every quote.
 *
 * It is the value of @ota/core's `fingerprintStayContext`, i.e. exactly what
 * the booking module computes for the same stay. Do not re-implement it.
 */
export function stayFingerprint(stayContext: StayContext): string {
  return fingerprintStayContext(stayContext);
}
