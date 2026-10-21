import type { Currency, LocalDate, Money } from '@ota/core';

/**
 * Supplier contract.
 *
 * These types are the ONLY vocabulary the rest of the OTA knows about Agoda.
 * Everything above this layer (search API, booking service, web) speaks in
 * these terms, so that swapping or adding a supplier never leaks vendor
 * quirks into the business logic.
 *
 * Naming follows the OTA/Agoda domain, not the raw XML element names; the
 * XML mapping lives in ./xml and is the only place that knows about both.
 */

// --- Static content --------------------------------------------------------

export interface SupplierGeo {
  latitude: number;
  longitude: number;
}

export interface SupplierAddress {
  street?: string;
  city: string;
  state?: string;
  country: string;
  countryCode: string;
  postalCode?: string;
  /**
   * IANA timezone of the property, e.g. `Asia/Bangkok`.
   *
   * A cancellation deadline is a date on the property's wall clock, so the
   * local timezone is part of the contract, not a detail we can guess.
   */
  timeZone?: string;
}

export interface SupplierImage {
  url: string;
  caption?: string;
  order?: number;
}

export interface SupplierAmenity {
  group?: string;
  name: string;
}

export interface SupplierRoomType {
  id: string;
  name: string;
  description?: string;
  maxOccupancy: number;
  bedType?: string;
  sizeSqm?: number;
  images: SupplierImage[];
  amenities: SupplierAmenity[];
}

export interface SupplierHotel {
  id: string;
  name: string;
  starRating?: number;
  category?: string;
  description?: string;
  address: SupplierAddress;
  geo?: SupplierGeo;
  images: SupplierImage[];
  amenities: SupplierAmenity[];
  roomTypes: SupplierRoomType[];
  checkInTime?: string;
  checkOutTime?: string;
  policies?: string[];
  /** Raw payload, kept for debugging and for future fields we do not model yet. */
  raw?: unknown;
}

export interface SupplierHotelSummary {
  id: string;
  name: string;
  starRating?: number;
  address: SupplierAddress;
  geo?: SupplierGeo;
  thumbnail?: string;
  lowestNightlyTotal?: Money;
  lowestStayTotal?: Money;
  reviewScore?: number;
  reviewCount?: number;
  raw?: unknown;
}

// --- Search & availability -------------------------------------------------

export interface SupplierDestination {
  /** Agoda city id, when known. */
  cityId?: string;
  name?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
}

export interface SupplierSearchQuery {
  destination: SupplierDestination;
  checkIn: LocalDate;
  checkOut: LocalDate;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: Currency;
  nationality: string;
}

export interface SupplierSearchResult {
  hotels: SupplierHotelSummary[];
  total?: number;
  currency: Currency;
  raw?: unknown;
}

export type MealPlan =
  | 'NO_BREAKFAST'
  | 'BREAKFAST_AVAILABLE'
  | 'BREAKFAST_INCLUDED'
  | 'HALF_BOARD'
  | 'FULL_BOARD'
  | 'ALL_INCLUSIVE';

export type CancellationPolicyType = 'FULL_REFUND' | 'PARTIAL_REFUND' | 'NON_REFUNDABLE';

export interface CancellationPolicy {
  type: CancellationPolicyType;
  refundable: boolean;
  /** Last date (property local time) on which a free cancellation is still allowed. */
  freeCancellationUntil?: LocalDate;
  /** Flat amount kept by the supplier on cancellation. */
  penaltyAmount?: Money;
  /** Percentage of the stay price kept by the supplier on cancellation. */
  penaltyPercent?: number;
  noShowPenalty?: Money;
  description: string;
}

export interface QuoteAmounts {
  /** Room price excluding taxes and fees. */
  net: Money;
  taxes: Money;
  /** net + taxes. The amount the customer is charged for the room. */
  total: Money;
}

export interface SupplierQuote {
  /**
   * Opaque supplier token identifying this exact offer (room + rate plan +
   * date + occupancy). Required for Precheck and Book.
   */
  offerId: string;
  supplierHotelId: string;
  roomTypeId: string;
  ratePlanId: string;
  roomTypeName: string;
  ratePlanName: string;
  bedType?: string;
  maxOccupancy: number;
  nights: number;
  currency: Currency;
  /** Per night. */
  nightly: QuoteAmounts;
  /** Whole stay. */
  stayTotal: QuoteAmounts;
  cancellationPolicy: CancellationPolicy;
  mealPlan: MealPlan;
  payAtHotel: boolean;
  instantConfirmation: boolean;
  /** Rooms left for this offer, when the supplier discloses it. */
  allotment?: number;
  taxesIncluded: boolean;
  /** When true the total is already tax-inclusive. */
  raw?: unknown;
}

export interface SupplierHotelAvailability {
  supplierHotelId: string;
  currency: Currency;
  quotes: SupplierQuote[];
  raw?: unknown;
}

// --- Booking ----------------------------------------------------------------

export interface SupplierGuest {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  nationality: string;
  isLead: boolean;
  /** Agoda requires guest age bands for children. */
  age?: number;
}

export interface SupplierPrecheckInput {
  supplierHotelId: string;
  offerId: string;
  checkIn: LocalDate;
  checkOut: LocalDate;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: Currency;
  nationality: string;
  /** Fingerprint of the StayContext that produced the offer. */
  contextFingerprint: string;
}

export interface SupplierPrecheckResult {
  /** Re-validated quote. Prices may have moved since Search. */
  quote: SupplierQuote;
  /** True when the supplier re-priced the offer. */
  priceChanged: boolean;
  available: boolean;
  raw?: unknown;
}

export interface SupplierBookingInput {
  supplierHotelId: string;
  offerId: string;
  checkIn: LocalDate;
  checkOut: LocalDate;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: Currency;
  nationality: string;
  guests: SupplierGuest[];
  specialRequests?: string[];
  /**
   * Agoda rejects a booking when it detects the same guest name + hotel +
   * overlapping dates from a prior booking. We deliberately allow it.
   */
  allowDuplication: boolean;
  /** Our own idempotency key, echoed into the supplier booking. */
  idempotencyKey: string;
  /** Fingerprint of the StayContext, checked for parameter drift. */
  contextFingerprint: string;
  /** Price we expect to be charged; used to detect price changes. */
  expectedTotal: Money;
}

export type SupplierBookingStatus =
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'REJECTED'
  | 'CANCELLED';

export interface SupplierBookingResult {
  supplierBookingId: string;
  confirmationNumber?: string;
  status: SupplierBookingStatus;
  /**
   * Agoda returns `processing: true` while it still reserves the allotment.
   * A processing booking is NOT confirmed and must not be reported as such.
   */
  processing: boolean;
  total?: Money;
  cancellationPolicy?: CancellationPolicy;
  errorCode?: string;
  errorMessage?: string;
  raw?: unknown;
}

export interface SupplierBookingDetail {
  supplierBookingId: string;
  confirmationNumber?: string;
  status: SupplierBookingStatus;
  processing: boolean;
  total?: Money;
  checkIn: LocalDate;
  checkOut: LocalDate;
  guests: SupplierGuest[];
  cancellationPolicy?: CancellationPolicy;
  errorMessage?: string;
  raw?: unknown;
}

export interface SupplierCancelInput {
  supplierBookingId: string;
  /** Reason recorded on the supplier side. */
  reason?: string;
  /** Idempotency key so a retried cancel does not fail. */
  idempotencyKey: string;
}

export interface SupplierCancelResult {
  supplierBookingId: string;
  cancelled: boolean;
  /** Amount the supplier keeps; undefined means full refund. */
  penaltyAmount?: Money;
  /** Refund the supplier expects to return. */
  refundAmount?: Money;
  raw?: unknown;
}

// --- Adapter ----------------------------------------------------------------

export interface SupplierAdapterConfig {
  mode: 'mock' | 'live';
  baseUrl?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  contentLanguage?: string;
  timeouts?: Partial<Record<SupplierEndpoint, number>>;
  maxRetries?: number;
  rateLimitRpm?: number;
  rateLimitBurst?: number;
}

export type SupplierEndpoint =
  | 'content'
  | 'search'
  | 'precheck'
  | 'booking'
  | 'detail'
  | 'cancel';

/**
 * The one interface the business layer talks to.
 * Implementations: ./mock (high fidelity simulator) and ./live (Agoda Demand API).
 */
export interface SupplierAdapter {
  readonly name: string;
  readonly mode: 'mock' | 'live';

  /** Static content: hotel detail incl. room types, images, amenities. */
  getHotel(supplierHotelId: string): Promise<SupplierHotel>;

  /** Bulk static content for the catalog sync job. */
  listHotels(params?: {
    destination?: SupplierDestination;
    page?: number;
    pageSize?: number;
  }): Promise<SupplierHotel[]>;

  /** Availability + price search for a stay. */
  searchHotels(query: SupplierSearchQuery): Promise<SupplierSearchResult>;

  /** Room-level rates for one or more hotels. */
  getAvailability(
    query: SupplierSearchQuery & { hotelIds: string[] },
  ): Promise<SupplierHotelAvailability[]>;

  /** Re-validate price + inventory of a specific offer right before booking. */
  precheck(input: SupplierPrecheckInput): Promise<SupplierPrecheckResult>;

  /** Create the booking. */
  book(input: SupplierBookingInput): Promise<SupplierBookingResult>;

  /** Poll booking status while Agoda is still processing. */
  getBooking(supplierBookingId: string): Promise<SupplierBookingDetail>;

  /** Cancel an existing booking. */
  cancel(input: SupplierCancelInput): Promise<SupplierCancelResult>;
}
