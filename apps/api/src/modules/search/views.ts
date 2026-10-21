import { toDTO } from '@ota/core';
import type { MoneyDTO } from '@ota/core';
import type { SupplierQuote } from '@ota/agoda-connectivity';

/**
 * Wire shapes of the search module (docs/api-contract.md §1, §3, §4).
 *
 * Money is always `{ amount, currency, major }` with the amount in integer
 * minor units.
 */

export interface QuoteAmountsView {
  net: MoneyDTO;
  taxes: MoneyDTO;
  total: MoneyDTO;
}

export interface CancellationPolicyView {
  type: string;
  refundable: boolean;
  freeCancellationUntil: string | null;
  penaltyAmount: MoneyDTO | null;
  penaltyPercent: number | null;
  description: string;
}

export interface QuoteView {
  offerId: string;
  /** LOCAL room type id. */
  roomTypeId: string;
  roomTypeName: string;
  /** LOCAL rate plan id. */
  ratePlanId: string;
  ratePlanName: string;
  bedType: string | null;
  maxOccupancy: number;
  nights: number;
  nightly: QuoteAmountsView;
  stayTotal: QuoteAmountsView;
  mealPlan: string;
  payAtHotel: boolean;
  instantConfirmation: boolean;
  allotment: number | null;
  taxesIncluded: boolean;
  cancellationPolicy: CancellationPolicyView;
}

export interface AddressView {
  street: string | null;
  city: string;
  country: string;
  countryCode: string;
  postalCode: string | null;
}

export interface GeoView {
  latitude: number;
  longitude: number;
}

export interface SearchHotelView {
  /** LOCAL hotel id. */
  id: string;
  supplierHotelId: string;
  slug: string;
  name: string;
  starRating: number | null;
  address: AddressView;
  geo: GeoView | null;
  thumbnail: string | null;
  images: string[];
  lowestNightlyTotal: MoneyDTO | null;
  lowestStayTotal: MoneyDTO | null;
  reviewScore: number | null;
  reviewCount: number | null;
}

export interface SearchResponse {
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  adults: number;
  currency: string;
  hotels: SearchHotelView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AvailabilityResponse {
  /** LOCAL hotel id. */
  hotelId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  currency: string;
  quotes: QuoteView[];
}

export interface PrecheckResponse {
  offerId: string;
  priceChanged: boolean;
  available: boolean;
  quote: QuoteView;
  total: MoneyDTO;
}

function amountsView(quote: SupplierQuote): { nightly: QuoteAmountsView; stayTotal: QuoteAmountsView } {
  return {
    nightly: {
      net: toDTO(quote.nightly.net),
      taxes: toDTO(quote.nightly.taxes),
      total: toDTO(quote.nightly.total),
    },
    stayTotal: {
      net: toDTO(quote.stayTotal.net),
      taxes: toDTO(quote.stayTotal.taxes),
      total: toDTO(quote.stayTotal.total),
    },
  };
}

/**
 * Map a supplier quote to the wire shape.
 *
 * `roomTypeId` / `ratePlanId` are LOCAL ids: the booking module resolves the
 * supplier ids through them.
 */
export function quoteView(
  quote: SupplierQuote,
  localIds: { roomTypeId: string; ratePlanId: string },
): QuoteView {
  const { nightly, stayTotal } = amountsView(quote);
  const policy = quote.cancellationPolicy;

  return {
    offerId: quote.offerId,
    roomTypeId: localIds.roomTypeId,
    roomTypeName: quote.roomTypeName,
    ratePlanId: localIds.ratePlanId,
    ratePlanName: quote.ratePlanName,
    bedType: quote.bedType ?? null,
    maxOccupancy: quote.maxOccupancy,
    nights: quote.nights,
    nightly,
    stayTotal,
    mealPlan: quote.mealPlan,
    payAtHotel: quote.payAtHotel,
    instantConfirmation: quote.instantConfirmation,
    allotment: quote.allotment ?? null,
    taxesIncluded: quote.taxesIncluded,
    cancellationPolicy: {
      type: policy.type,
      refundable: policy.refundable,
      freeCancellationUntil: policy.freeCancellationUntil ?? null,
      penaltyAmount: policy.penaltyAmount ? toDTO(policy.penaltyAmount) : null,
      penaltyPercent: policy.penaltyPercent ?? null,
      description: policy.description,
    },
  };
}
