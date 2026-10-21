import { XMLParser } from 'fast-xml-parser';
import { decimalsFor, isLocalDate, money } from '@ota/core';
import type { Currency, LocalDate, Money } from '@ota/core';

/**
 * Defensive XML parsing helpers.
 *
 * Contract of this module: it NEVER throws and NEVER produces `NaN`.
 * A supplier that returns a truncated body, a renamed element or a
 * malformed amount must degrade into `undefined` (missing data), never into
 * a wrong number that would later be charged to a customer.
 *
 * The parser is configured so that NOTHING is coerced:
 *   - `parseTagValue: false`  -> "12.50" stays the string "12.50"
 *   - `parseAttributeValue: false` -> attributes stay strings
 * Money is then converted with integer arithmetic (see `decimalToMinor`),
 * so we never round-trip currency through a float.
 */

export function createParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
    removeNSPrefix: true,
  });
}

/** Parse a document. Never throws: a broken document yields an empty object. */
export function parseXml(xml: string): Record<string, unknown> {
  if (typeof xml !== 'string' || xml.trim() === '') return {};
  try {
    const parsed = createParser().parse(xml) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalise a value to an array (XMLParser collapses single elements). */
export function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * The root element of a parsed document.
 *
 * `XMLParser.parse()` returns the DOCUMENT (`{ "?xml": ..., "OTA_...": {...} }`),
 * so every traversal has to descend into the root element first.
 */
export function rootElement(doc: Record<string, unknown>): unknown {
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('?')) continue; // the XML declaration
    return value;
  }
  return undefined;
}

/** Direct child element by name. */
export function child(node: unknown, name: string): unknown {
  if (!isRecord(node)) return undefined;
  return node[name];
}

/** Direct child elements by name, always as an array. */
export function children(node: unknown, name: string): unknown[] {
  return asArray(child(node, name));
}

/**
 * Reduce a parsed node to its scalar text.
 * Handles `text`, `number`, `boolean` and the `{ '#text': ... }` shape.
 */
export function scalar(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === 'boolean') return String(value);
  if (isRecord(value)) {
    const text = value['#text'];
    if (text !== undefined) return scalar(text);
  }
  return undefined;
}

/** Text of a direct child element. */
export function text(node: unknown, name: string): string | undefined {
  return scalar(child(node, name));
}

/** Text of the node itself. */
export function ownText(node: unknown): string | undefined {
  return scalar(node);
}

/** Attribute value of a node. */
export function attr(node: unknown, name: string): string | undefined {
  if (!isRecord(node)) return undefined;
  return scalar(node[`@_${name}`]);
}

/** Numeric value of a child element. `NaN` / `Infinity` become `undefined`. */
export function num(node: unknown, name: string): number | undefined {
  const raw = text(node, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Integer value of a child element. */
export function int(node: unknown, name: string): number | undefined {
  const parsed = num(node, name);
  if (parsed === undefined) return undefined;
  return Number.isInteger(parsed) ? parsed : Math.trunc(parsed);
}

/** Boolean value of a child element. Accepts true/false, 1/0, yes/no. */
export function bool(node: unknown, name: string): boolean | undefined {
  const raw = text(node, name)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return undefined;
}

/**
 * A stay date. Only `YYYY-MM-DD` is accepted; anything else (a timestamp,
 * a localised date, garbage) is rejected and becomes `undefined`.
 */
export function date(node: unknown, name: string): LocalDate | undefined {
  const raw = text(node, name);
  if (raw === undefined) return undefined;
  const candidate = raw.includes('T') ? raw.slice(0, 10) : raw;
  return isLocalDate(candidate) ? candidate : undefined;
}

/**
 * Convert a decimal string to integer minor units without ever using a
 * float. `decimalToMinor('12.50', 2) === 1250`.
 *
 * Returns `undefined` for anything that is not a plain decimal number, so a
 * malformed amount can never become `NaN` money.
 */
export function decimalToMinor(value: string, decimals: number): number | undefined {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  // Guard against precision loss: anything beyond 15 digits is not money.
  if (whole.length + fraction.length > 15) return undefined;

  if (fraction.length <= decimals) {
    const padded = fraction.padEnd(decimals, '0');
    const digits = `${whole}${padded}`;
    const amount = Number(digits);
    if (!Number.isFinite(amount)) return undefined;
    return sign * amount;
  }

  // More fractional digits than the currency supports: round half-up.
  const kept = fraction.slice(0, decimals);
  const rest = fraction.slice(decimals);
  const keptPadded = kept.padEnd(decimals, '0');
  const roundUp = (rest[0] ?? '0') >= '5';
  const base = Number(`${whole}${keptPadded}`);
  if (!Number.isFinite(base)) return undefined;
  return sign * (base + (roundUp ? 1 : 0));
}

/** Render integer minor units as a decimal string for the wire. */
export function minorToDecimalString(amount: number, currency: Currency): string {
  const decimals = decimalsFor(currency);
  if (decimals === 0) return String(Math.trunc(amount));
  const sign = amount < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(amount));
  const divisor = 10 ** decimals;
  const whole = Math.floor(absolute / divisor);
  const fraction = String(absolute % divisor).padStart(decimals, '0');
  return `${sign}${whole}.${fraction}`;
}

/** Money of a child element, or `undefined` when absent / malformed. */
export function parseMoney(node: unknown, name: string, currency: Currency): Money | undefined {
  const raw = text(node, name);
  if (raw === undefined) return undefined;
  return moneyFromDecimalString(raw, currency);
}

/** Money from a decimal string in major units. */
export function moneyFromDecimalString(value: string, currency: Currency): Money | undefined {
  const minor = decimalToMinor(value, decimalsFor(currency));
  if (minor === undefined) return undefined;
  return money(minor, currency);
}
