/**
 * Money is always integer minor units (cents / yen / satang).
 * Never store or compare floating point money.
 */

export const CURRENCIES = [
  'USD', 'CNY', 'THB', 'JPY', 'EUR', 'GBP', 'SGD', 'MYR', 'HKD',
  'KRW', 'AUD', 'TWD', 'VND', 'IDR', 'PHP', 'INR', 'NZD', 'CHF',
] as const;

export type Currency = (typeof CURRENCIES)[number];

export interface Money {
  /** Minor units. 1234 USD == 12.34 USD, 1234 JPY == 1234 JPY. */
  readonly amount: number;
  readonly currency: Currency;
}

/** Currencies whose minor unit is the whole major unit. */
const ZERO_DECIMAL: ReadonlySet<Currency> = new Set<Currency>(['JPY', 'KRW', 'VND', 'IDR']);

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

export function decimalsFor(currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? 0 : 2;
}

export function money(amount: number, currency: Currency): Money {
  if (!Number.isInteger(amount)) {
    throw new TypeError(`Money amount must be an integer in minor units, got ${amount}`);
  }
  return { amount, currency };
}

/**
 * Round half away from zero.
 *
 * `Math.round` rounds half towards +Infinity and inherits the float noise
 * of the multiplication: 1.005 * 100 is 100.49999999999999, so a plain
 * `Math.round` would drop a cent. `toPrecision(15)` removes that
 * representation noise before the rounding.
 */
function roundHalfAwayFromZero(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const cleaned = Number(Math.abs(value).toPrecision(15));
  return sign * Math.round(cleaned);
}

/** Build from a major-unit number (12.34 USD). Rounds half-away-from-zero. */
export function moneyFromMajor(major: number, currency: Currency): Money {
  const factor = 10 ** decimalsFor(currency);
  return money(roundHalfAwayFromZero(major * factor), currency);
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function multiply(a: Money, factor: number): Money {
  if (!Number.isFinite(factor)) {
    throw new TypeError(`Cannot multiply money by ${factor}`);
  }
  return money(Math.round(a.amount * factor), a.currency);
}

/** Percentage of an amount, e.g. 12% tax. */
export function percentOf(a: Money, percent: number): Money {
  return multiply(a, percent / 100);
}

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, item) => add(acc, item), zero(currency));
}

export function equals(a: Money, b: Money): boolean {
  return a.amount === b.amount && a.currency === b.currency;
}

export function isZero(a: Money): boolean {
  return a.amount === 0;
}

export function isNegative(a: Money): boolean {
  return a.amount < 0;
}

export function toMajor(a: Money): number {
  return a.amount / 10 ** decimalsFor(a.currency);
}

export function formatMoney(a: Money, locale = 'zh-CN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: a.currency,
    minimumFractionDigits: decimalsFor(a.currency),
    maximumFractionDigits: decimalsFor(a.currency),
  }).format(toMajor(a));
}

/** Serialisable form used on the wire and in JSON payloads. */
export interface MoneyDTO {
  amount: number;
  currency: Currency;
  major: number;
}

export function toDTO(a: Money): MoneyDTO {
  return { amount: a.amount, currency: a.currency, major: toMajor(a) };
}

export function fromDTO(dto: MoneyDTO): Money {
  return money(dto.amount, dto.currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
