/**
 * Display helpers.
 *
 * Dates arrive as `YYYY-MM-DD` strings and are *never* turned into timestamps
 * with `new Date('YYYY-MM-DD')` — that parses as UTC midnight and shifts the
 * day in negative-offset timezones. We split the parts and format manually.
 */

import type { CancellationPolicy, MealPlan, Money } from './api';

/* ---------------------------------- dates --------------------------------- */

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export function parseDateParts(value: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function isValidDate(value: string): boolean {
  return parseDateParts(value) !== null;
}

/** `2026-11-10` → `2026年11月10日` */
export function formatDate(value: string | null | undefined): string {
  const parts = parseDateParts(value ?? '');
  if (!parts) return value ?? '—';
  return `${parts.year}年${parts.month}月${parts.day}日`;
}

/** `2026-11-10` → `11月10日` */
export function formatDateShort(value: string | null | undefined): string {
  const parts = parseDateParts(value ?? '');
  if (!parts) return value ?? '—';
  return `${parts.month}月${parts.day}日`;
}

/** Weekday computed from the parts, so it never shifts across timezones. */
export function formatWeekday(value: string | null | undefined): string {
  const parts = parseDateParts(value ?? '');
  if (!parts) return '';
  const weekday = new Date(parts.year, parts.month - 1, parts.day).getDay();
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] ?? '';
}

/** `2026-11-10` → `11月10日 周二` */
export function formatDateWithWeekday(value: string | null | undefined): string {
  const weekday = formatWeekday(value);
  const label = formatDateShort(value);
  return weekday ? `${label} ${weekday}` : label;
}

/** Nights between two local dates, computed in UTC to dodge DST drift. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const start = parseDateParts(checkIn);
  const end = parseDateParts(checkOut);
  if (!start || !end) return 0;
  const from = Date.UTC(start.year, start.month - 1, start.day);
  const to = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((to - from) / 86_400_000);
}

/** Today in the *browser's* timezone, as `YYYY-MM-DD`. */
export function todayIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Add whole days to a `YYYY-MM-DD` string and return `YYYY-MM-DD`. */
export function addDays(value: string, days: number): string {
  const parts = parseDateParts(value);
  if (!parts) return value;
  const base = Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86_400_000;
  const date = new Date(base);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** `2026年11月10日 — 2026年11月12日` */
export function formatDateRange(checkIn: string, checkOut: string): string {
  return `${formatDate(checkIn)} — ${formatDate(checkOut)}`;
}

/** ISO timestamp → `2026-10-20 20:00` (local) */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/* ---------------------------------- money --------------------------------- */

/**
 * Format a money amount using the API-provided `major` value.
 * We never do arithmetic on `amount` (integer minor units).
 */
export function formatMoney(value: Money | null | undefined, locale = 'zh-CN'): string {
  if (!value) return '—';
  const currency = value.currency || 'CNY';
  const major = Number(value.major);
  if (!Number.isFinite(major)) return '—';

  try {
    const base = new Intl.NumberFormat(locale, { style: 'currency', currency });
    const digits = base.resolvedOptions().maximumFractionDigits ?? 2;
    const hasFraction = Math.abs(major % 1) > 0;
    // Whole amounts stay clean ("¥1,080"); fractional ones keep two decimals.
    const minimumFractionDigits = hasFraction ? 2 : 0;
    const maximumFractionDigits = hasFraction ? Math.max(2, digits) : digits;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits,
      maximumFractionDigits,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(0)}`;
  }
}

/** Bare number with the currency symbol, for large headline prices. */
export function formatAmount(value: Money | null | undefined, locale = 'zh-CN'): string {
  return formatMoney(value, locale);
}

/** Currencies without a fractional part. */
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK']);

/** Currencies with three fractional digits. */
const THREE_DECIMAL_CURRENCIES = new Set(['KWD', 'BHD', 'OMR', 'JOD', 'TND']);

/** Number of fractional digits of a currency code. */
function currencyDigits(currency: string): number {
  const code = (currency || 'CNY').toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Build a display `Money` from integer minor units.
 *
 * The API usually sends `amount` and `major` together, but a price-change
 * rejection only tells us the minor amount (`error.details.expected`). The
 * `major` value derived here is for **display only** — it is never sent back
 * to the API, which always works with integer minor units.
 */
export function moneyFromMinorUnits(amount: number, currency = 'CNY'): Money {
  const minor = Math.trunc(amount);
  const digits = currencyDigits(currency);
  const major = Number((minor / 10 ** digits).toFixed(digits));
  return { amount: minor, currency, major };
}

/* ---------------------------------- labels -------------------------------- */

export const MEAL_PLAN_LABEL: Record<MealPlan, string> = {
  NO_BREAKFAST: '不含早餐',
  BREAKFAST_AVAILABLE: '早餐可选',
  BREAKFAST_INCLUDED: '含早餐',
  HALF_BOARD: '半食宿',
  FULL_BOARD: '全食宿',
  ALL_INCLUSIVE: '全包式',
};

export function mealPlanLabel(mealPlan: MealPlan | null | undefined): string {
  if (!mealPlan) return '餐食以酒店确认为准';
  return MEAL_PLAN_LABEL[mealPlan] ?? mealPlan;
}

/** Human readable cancellation policy text. */
export function cancellationLabel(
  policy: CancellationPolicy | null | undefined,
): string {
  if (!policy) return '取消政策以最终确认为准';
  if (policy.description) return policy.description;

  switch (policy.type) {
    case 'FULL_REFUND': {
      return policy.freeCancellationUntil
        ? `${formatDate(policy.freeCancellationUntil)} 前可免费取消`
        : '入住前可免费取消';
    }
    case 'PARTIAL_REFUND': {
      if (policy.penaltyAmount) {
        return `取消收取罚金 ${formatMoney(policy.penaltyAmount)}`;
      }
      if (typeof policy.penaltyPercent === 'number') {
        return `取消收取 ${policy.penaltyPercent}% 罚金`;
      }
      return '取消将收取部分罚金';
    }
    case 'NON_REFUNDABLE':
      return '该价格不可取消';
    default:
      return '取消政策以最终确认为准';
  }
}

/** `普吉 · 泰国` */
export function formatAddress(address: {
  city?: string | null;
  country?: string | null;
  street?: string | null;
} | null | undefined): string {
  if (!address) return '';
  return [address.city, address.country].filter(Boolean).join(' · ');
}

/** Full one-line address for the detail page. */
export function formatFullAddress(address: {
  street?: string | null;
  city?: string | null;
  country?: string | null;
  postalCode?: string | null;
} | null | undefined): string {
  if (!address) return '';
  return [address.street, address.city, address.country, address.postalCode]
    .filter(Boolean)
    .join(' ');
}
