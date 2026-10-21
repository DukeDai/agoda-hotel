import { addDays, diffDays, moneyFromMajor, percentOf, toUtcMillis } from '@ota/core';
import type { Currency, LocalDate, Money } from '@ota/core';
import type {
  CancellationPolicy,
  MealPlan,
  SupplierHotel,
  SupplierQuote,
  SupplierRoomType,
} from '../contract.js';
import { SeededRandom, hashSeed, seededUnit } from './prng.js';

/**
 * Quote construction for the mock supplier.
 *
 * Every amount is derived from a KEY (hotel + room + rate plan + stay +
 * occupancy + currency), never from a counter. Two consequences:
 *   1. the same stay always produces the same price (search, availability
 *      and precheck agree);
 *   2. the values do not depend on the order in which the calls happen, so
 *      two mock instances with the same seed are interchangeable.
 */

/** The three rate plans Agoda typically exposes per room type. */
export type RatePlanKind = 'FLEX' | 'PARTIAL' | 'NON_REFUNDABLE';

export interface RatePlanSpec {
  id: string;
  name: string;
  kind: RatePlanKind;
  mealPlan: MealPlan;
  payAtHotel: boolean;
  instantConfirmation: boolean;
}

export interface OfferParts {
  hotelId: string;
  roomTypeId: string;
  ratePlanId: string;
  checkIn: LocalDate;
  checkOut: LocalDate;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: Currency;
}

const OFFER_PREFIX = 'AGODA-OFFER';

/** Relative value of one unit in each supported currency (vs USD). */
const CURRENCY_FACTOR: Record<Currency, number> = {
  USD: 1,
  CNY: 7.1,
  THB: 35.5,
  JPY: 152,
  EUR: 0.92,
  GBP: 0.79,
  SGD: 1.34,
  MYR: 4.7,
  HKD: 7.8,
  KRW: 1340,
  AUD: 1.51,
  TWD: 31.5,
  VND: 25100,
  IDR: 15600,
  PHP: 57,
  INR: 83,
  NZD: 1.64,
  CHF: 0.9,
};

const TAX_PERCENT = 12;

/** The rate plans offered for a room type (2 or 3 of them). */
export function ratePlansFor(hotel: SupplierHotel, roomType: SupplierRoomType): RatePlanSpec[] {
  const isFirstRoom = hotel.roomTypes[0]?.id === roomType.id;
  const plans: RatePlanSpec[] = [
    {
      id: `${roomType.id}-RP1`,
      name: `${roomType.name} - Flexible`,
      kind: 'FLEX',
      mealPlan: 'BREAKFAST_AVAILABLE',
      payAtHotel: true,
      instantConfirmation: true,
    },
    {
      id: `${roomType.id}-RP2`,
      name: `${roomType.name} - Non Refundable`,
      kind: 'NON_REFUNDABLE',
      mealPlan: 'NO_BREAKFAST',
      payAtHotel: true,
      instantConfirmation: true,
    },
  ];
  if (isFirstRoom) {
    plans.splice(1, 0, {
      id: `${roomType.id}-RP2P`,
      name: `${roomType.name} - Partial Refund`,
      kind: 'PARTIAL',
      mealPlan: 'BREAKFAST_INCLUDED',
      payAtHotel: true,
      instantConfirmation: false,
    });
  }
  return plans;
}

/** Build the opaque offer token. It encodes the exact offer + stay. */
export function encodeOfferId(parts: OfferParts): string {
  const ages = [...parts.childAges].sort((a, b) => a - b).join(',');
  return [
    OFFER_PREFIX,
    parts.hotelId,
    parts.roomTypeId,
    parts.ratePlanId,
    parts.checkIn,
    parts.checkOut,
    String(parts.rooms),
    String(parts.adults),
    ages,
    parts.currency,
  ].join('|');
}

/** Parse an offer token. Returns `undefined` for a malformed token. */
export function decodeOfferId(offerId: string): OfferParts | undefined {
  const parts = offerId.split('|');
  if (parts.length !== 10) return undefined;
  const [prefix, hotelId, roomTypeId, ratePlanId, checkIn, checkOut, rooms, adults, ages, currency] = parts;
  if (prefix !== OFFER_PREFIX) return undefined;
  if (!hotelId || !roomTypeId || !ratePlanId || !checkIn || !checkOut || !rooms || !adults || !currency) {
    return undefined;
  }
  const childAges = ages ? ages.split(',').map((age) => Number(age)) : [];
  if (childAges.some((age) => !Number.isInteger(age) || age < 0)) return undefined;
  return {
    hotelId,
    roomTypeId,
    ratePlanId,
    checkIn,
    checkOut,
    rooms: Number(rooms),
    adults: Number(adults),
    childAges,
    currency: currency as Currency,
  };
}

export interface QuoteParams {
  /** Seed of the catalogue / price generator. */
  seed: number;
  hotel: SupplierHotel;
  roomType: SupplierRoomType;
  ratePlan: RatePlanSpec;
  checkIn: LocalDate;
  checkOut: LocalDate;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: Currency;
  /** Re-price by this percent (price drift between search and precheck). */
  driftPercent?: number;
}

/** Build a full quote for one offer. */
export function buildQuote(params: QuoteParams): SupplierQuote {
  const nights = diffDays(params.checkIn, params.checkOut);
  const roomIndex = Math.max(
    0,
    params.hotel.roomTypes.findIndex((roomType) => roomType.id === params.roomType.id),
  );

  const baseNightlyUsd =
    32 + (params.hotel.starRating ?? 3) * 26 +
    new SeededRandom(hashSeed(params.seed, 'hotel-price', params.hotel.id)).float(0, 26);
  const roomFactor = 1 + roomIndex * 0.16;
  const seasonFactor = seasonFactorFor(params.checkIn);
  const weekendFactor = weekendFactorFor(params.checkIn);
  const occupancyFactor = occupancyFactorFor(params.adults, params.childAges.length);
  const rateFactor = params.ratePlan.kind === 'FLEX' ? 1 : params.ratePlan.kind === 'PARTIAL' ? 0.94 : 0.88;
  const driftFactor = 1 + (params.driftPercent ?? 0) / 100;

  const nightlyMajor =
    baseNightlyUsd *
    roomFactor *
    seasonFactor *
    weekendFactor *
    occupancyFactor *
    rateFactor *
    driftFactor *
    CURRENCY_FACTOR[params.currency];

  const nightlyNet = moneyFromMajor(nightlyMajor * params.rooms, params.currency);
  const nightlyTaxes = percentOf(nightlyNet, TAX_PERCENT);
  const nightlyTotal = { net: nightlyNet, taxes: nightlyTaxes, total: add(nightlyNet, nightlyTaxes) };

  const stayNet = scale(nightlyNet, nights);
  const stayTaxes = percentOf(stayNet, TAX_PERCENT);
  const stayTotal = { net: stayNet, taxes: stayTaxes, total: add(stayNet, stayTaxes) };

  const offerId = encodeOfferId({
    hotelId: params.hotel.id,
    roomTypeId: params.roomType.id,
    ratePlanId: params.ratePlan.id,
    checkIn: params.checkIn,
    checkOut: params.checkOut,
    rooms: params.rooms,
    adults: params.adults,
    childAges: params.childAges,
    currency: params.currency,
  });

  const allotment = new SeededRandom(hashSeed(params.seed, 'allotment', offerId)).int(1, 5);

  return {
    offerId,
    supplierHotelId: params.hotel.id,
    roomTypeId: params.roomType.id,
    ratePlanId: params.ratePlan.id,
    roomTypeName: params.roomType.name,
    ratePlanName: params.ratePlan.name,
    ...(params.roomType.bedType ? { bedType: params.roomType.bedType } : {}),
    maxOccupancy: params.roomType.maxOccupancy,
    nights,
    currency: params.currency,
    nightly: nightlyTotal,
    stayTotal,
    cancellationPolicy: cancellationPolicyFor(params, stayTotal.total, nightlyTotal.total),
    mealPlan: params.ratePlan.mealPlan,
    payAtHotel: params.ratePlan.payAtHotel,
    instantConfirmation: params.ratePlan.instantConfirmation,
    allotment,
    taxesIncluded: false,
  };
}

/** The cancellation policy attached to a rate plan. */
export function cancellationPolicyFor(
  params: QuoteParams,
  stayTotal: Money,
  nightlyTotal: Money,
): CancellationPolicy {
  switch (params.ratePlan.kind) {
    case 'PARTIAL':
      return {
        type: 'PARTIAL_REFUND',
        refundable: true,
        freeCancellationUntil: addDays(params.checkIn, -1),
        penaltyPercent: 20,
        noShowPenalty: nightlyTotal,
        description: 'Free cancellation until 1 day before arrival; 20% of the stay price is charged afterwards',
      };
    case 'NON_REFUNDABLE':
      return {
        type: 'NON_REFUNDABLE',
        refundable: false,
        penaltyAmount: stayTotal,
        noShowPenalty: stayTotal,
        description: 'Non refundable: the full stay price is retained',
      };
    case 'FLEX':
    default:
      return {
        type: 'FULL_REFUND',
        refundable: true,
        freeCancellationUntil: addDays(params.checkIn, -3),
        penaltyAmount: stayTotal.amount === 0 ? stayTotal : zeroOf(stayTotal),
        noShowPenalty: nightlyTotal,
        description: 'Free cancellation until 3 days before arrival',
      };
  }
}

export interface DriftDecision {
  drifted: boolean;
  percent: number;
}

/**
 * Decide whether the offer is re-priced between search and precheck.
 *
 * Deterministic: the decision depends on the offer token and the stay
 * fingerprint, never on the clock, so a test can rely on it.
 */
export function decideDrift(
  offerId: string,
  contextFingerprint: string,
  rate: number,
  minPercent: number,
  maxPercent: number,
): DriftDecision {
  if (rate <= 0) return { drifted: false, percent: 0 };
  const trigger = seededUnit(`${offerId}|${contextFingerprint}|drift-trigger`);
  if (trigger >= rate) return { drifted: false, percent: 0 };
  const span = Math.max(0, maxPercent - minPercent + 1);
  const magnitude = seededUnit(`${offerId}|${contextFingerprint}|drift-magnitude`);
  const percent = minPercent + Math.floor(magnitude * span);
  return { drifted: true, percent };
}

/**
 * Decide whether the offer has sold out between search and precheck.
 * Deterministic for the same offer + fingerprint.
 */
export function isSoldOut(offerId: string, contextFingerprint: string, rate: number): boolean {
  if (rate <= 0) return false;
  return seededUnit(`${offerId}|${contextFingerprint}|sellout`) < rate;
}

// --- helpers ----------------------------------------------------------------

function add(a: Money, b: Money): Money {
  return { amount: a.amount + b.amount, currency: a.currency };
}

function scale(value: Money, factor: number): Money {
  return { amount: value.amount * factor, currency: value.currency };
}

function zeroOf(value: Money): Money {
  return { amount: 0, currency: value.currency };
}

function seasonFactorFor(checkIn: LocalDate): number {
  const month = Number(checkIn.slice(5, 7));
  if (month === 12 || month === 1 || month === 2) return 1.25;
  if (month === 7 || month === 8) return 1.2;
  if (month === 6 || month === 9) return 1.12;
  return 1;
}

function weekendFactorFor(checkIn: LocalDate): number {
  const day = new Date(toUtcMillis(checkIn)).getUTCDay();
  // Friday and Saturday arrivals cost more.
  return day === 5 || day === 6 ? 1.08 : 1;
}

function occupancyFactorFor(adults: number, children: number): number {
  const extraAdults = Math.max(0, adults - 2);
  return 1 + extraAdults * 0.12 + children * 0.08;
}
