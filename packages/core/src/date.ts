/**
 * Hotel stays are date-based, not instant-based. A booking covers NIGHTLY
 * segments: check-in 2026-10-20, check-out 2026-10-22 == 2 nights.
 *
 * All arithmetic is done in UTC to avoid DST / timezone drift, and a stay
 * date is never converted to an instant.
 *
 * The ONE exception is "what day is it at the hotel" — a cancellation
 * deadline is a date in the property's local timezone, not in UTC. That is
 * what `localDateInZone` is for.
 */

import { AppError } from './errors.js';

export type LocalDate = string; // YYYY-MM-DD

/** Used when a property does not tell us where it is. */
export const DEFAULT_TIME_ZONE = 'UTC';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLocalDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return false;
  if (d < 1 || d > 31) return false;
  // `Date.UTC` maps the years 0..99 onto 1900..1999, so the year is set
  // afterwards — otherwise every valid date before 0100 would be rejected.
  const dt = new Date(Date.UTC(2000, mo - 1, d));
  dt.setUTCFullYear(y);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function parseLocalDate(value: string): LocalDate {
  if (!isLocalDate(value)) {
    throw new TypeError(`Invalid local date (expected YYYY-MM-DD): ${value}`);
  }
  return value;
}

export function toLocalDate(instant: Date): LocalDate {
  return instant.toISOString().slice(0, 10);
}

export function today(now: Date = new Date()): LocalDate {
  return toLocalDate(now);
}

export function toUtcMillis(date: LocalDate): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function fromUtcMillis(ms: number): LocalDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromUtcMillis(toUtcMillis(date) + days * 86_400_000);
}

export function diffDays(from: LocalDate, to: LocalDate): number {
  return Math.round((toUtcMillis(to) - toUtcMillis(from)) / 86_400_000);
}

/** Number of nights in a stay. A same-day range is invalid. */
export function nights(checkIn: LocalDate, checkOut: LocalDate): number {
  const n = diffDays(checkIn, checkOut);
  if (n <= 0) {
    throw new RangeError(`Invalid stay range ${checkIn} -> ${checkOut}`);
  }
  return n;
}

export function isValidStay(checkIn: LocalDate, checkOut: LocalDate): boolean {
  try {
    return nights(checkIn, checkOut) > 0;
  } catch {
    return false;
  }
}

/** Every night segment of the stay, inclusive of check-in, exclusive of check-out. */
export function nightSegments(checkIn: LocalDate, checkOut: LocalDate): LocalDate[] {
  const count = nights(checkIn, checkOut);
  return Array.from({ length: count }, (_, i) => addDays(checkIn, i));
}

export function isPast(date: LocalDate, now: Date = new Date()): boolean {
  return toUtcMillis(date) < toUtcMillis(today(now));
}

export function formatDateCN(date: LocalDate): string {
  const [y, m, d] = date.split('-');
  return `${y}年${Number(m)}月${Number(d)}日`;
}

export function formatDateShort(date: LocalDate): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function formatDateRangeCN(checkIn: LocalDate, checkOut: LocalDate): string {
  return `${formatDateCN(checkIn)} - ${formatDateCN(checkOut)}`;
}

/* --------------------------------------------------------------------------
 * Property local time
 * ------------------------------------------------------------------------ */

/**
 * Is this an IANA timezone the runtime knows about?
 *
 * A bad timezone must not silently become UTC: the whole point of asking
 * for the property's timezone is to be right about "today" there.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date at a given instant, as seen in `timeZone`.
 *
 * `2026-10-20T23:30:00Z` is still 2026-10-20 in New York but already
 * 2026-10-21 in Bangkok. A free-cancellation deadline is a date on the
 * property's wall clock, so this is the only correct way to compute "today"
 * for a cancellation decision.
 */
export function localDateInZone(instant: Date, timeZone: string = DEFAULT_TIME_ZONE): LocalDate {
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new AppError('INTERNAL_ERROR', `无法在时区 ${timeZone} 计算当地日期`);
  }
  return `${year}-${month}-${day}`;
}
