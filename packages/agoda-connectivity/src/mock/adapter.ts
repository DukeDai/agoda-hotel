import { AppError, diffDays, noopLogger, percentOf, toLocalDate } from '@ota/core';
import type { Currency, LocalDate, Logger, Money } from '@ota/core';
import type {
  SupplierAdapter,
  SupplierAdapterConfig,
  SupplierBookingDetail,
  SupplierBookingInput,
  SupplierBookingResult,
  SupplierCancelInput,
  SupplierCancelResult,
  SupplierDestination,
  SupplierHotel,
  SupplierHotelAvailability,
  SupplierHotelSummary,
  SupplierPrecheckInput,
  SupplierPrecheckResult,
  SupplierQuote,
  SupplierSearchQuery,
  SupplierSearchResult,
} from '../contract.js';
import { AgodaXmlCodec } from '../xml/codec.js';
import { TokenBucketRateLimiter } from '../live/rate-limiter.js';
import { buildCatalog, confirmationNumberFor } from './catalog.js';
import { BookingLedger, normalizeGuestName } from './ledger.js';
import type { LedgerEntry } from './ledger.js';
import {
  buildQuote,
  decideDrift,
  decodeOfferId,
  isSoldOut,
  ratePlansFor,
} from './pricing.js';
import type { RatePlanSpec } from './pricing.js';

/**
 * The high fidelity in-process simulation of the Agoda Demand API.
 *
 * This is the supplier the whole OTA system runs against in dev and CI, so
 * it deliberately reproduces the AWKWARD parts of the real API instead of a
 * happy path:
 *
 *   - prices drift between search and precheck (deterministically);
 *   - an offer can sell out between search and precheck;
 *   - a booking comes back `processing: true` and only converges to
 *     CONFIRMED after a few polls;
 *   - a duplicate booking (same lead guest + hotel + overlapping dates) is
 *     rejected even though we send `allowDuplication: true`;
 *   - the quota is enforced client side (429 equivalent);
 *   - timeouts and 5xx can be injected so the retry / circuit breaker path
 *     is exercised;
 *   - a booking can be rejected by the supplier.
 *
 * Everything is deterministic: the same seed produces the same catalogue,
 * the same prices and the same drift decisions.
 *
 * The mock speaks the SAME XML dialect as the live adapter: it encodes its
 * responses and decodes them back through `AgodaXmlCodec`, so a codec bug
 * shows up in dev instead of in production.
 */

/** Failure modes that can be injected into the mock. */
export type MockFailureKind =
  | 'timeout'
  | 'error'
  | 'rateLimit'
  | 'auth'
  | 'rejected'
  | 'duplicate'
  | 'sellOut'
  | 'priceChanged';

export interface AgodaMockOptions {
  /** Seed of the deterministic generator. Same seed => same everything. */
  seed?: number;
  /** Adapter configuration (timeouts, quota, content language). */
  config?: SupplierAdapterConfig;
  logger?: Logger;
  /** Probability (0..1) that a quote is re-priced at precheck. 0 = stable. */
  priceDriftRate?: number;
  /** Lower bound of a price drift, in percent. */
  driftMinPercent?: number;
  /** Upper bound of a price drift, in percent. */
  driftMaxPercent?: number;
  /** Probability (0..1) that an offer sells out before precheck. */
  sellOutRate?: number;
  /** Offers that are always sold out (by offer id). */
  soldOutOfferIds?: string[];
  /** How many `getBooking()` polls report PROCESSING before converging. */
  processingPolls?: number;
  /** Client side quota. */
  rateLimitRpm?: number;
  rateLimitBurst?: number;
  /** Clock injection point (tests). */
  now?: () => Date;
}

const DEFAULTS = {
  seed: 20261020,
  priceDriftRate: 0,
  driftMinPercent: 1,
  driftMaxPercent: 8,
  sellOutRate: 0,
  processingPolls: 2,
  rateLimitRpm: 600,
  rateLimitBurst: 60,
} as const;

export class AgodaMockAdapter implements SupplierAdapter {
  readonly name = 'agoda';
  readonly mode = 'mock' as const;

  private readonly codec = new AgodaXmlCodec();
  private readonly catalog: SupplierHotel[];
  private readonly ledger = new BookingLedger();
  private readonly logger: Logger;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly now: () => Date;
  private readonly seed: number;
  private readonly priceDriftRate: number;
  private readonly driftMinPercent: number;
  private readonly driftMaxPercent: number;
  private readonly sellOutRate: number;
  private readonly soldOutOfferIds: Set<string>;
  private readonly processingPolls: number;
  /** Prices as quoted by search / availability (before any drift). */
  private readonly issuedQuotes = new Map<string, SupplierQuote>();
  /** Injected failures, consumed one per supplier call. */
  private readonly failures: MockFailureKind[] = [];
  private bookingSequence = 0;

  constructor(options: AgodaMockOptions | SupplierAdapterConfig = {}) {
    const opts: AgodaMockOptions = isAdapterConfig(options) ? { config: options } : options;
    const config = opts.config;

    this.seed = opts.seed ?? DEFAULTS.seed;
    this.catalog = buildCatalog(this.seed);
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => new Date());
    this.priceDriftRate = opts.priceDriftRate ?? DEFAULTS.priceDriftRate;
    this.driftMinPercent = opts.driftMinPercent ?? DEFAULTS.driftMinPercent;
    this.driftMaxPercent = opts.driftMaxPercent ?? DEFAULTS.driftMaxPercent;
    this.sellOutRate = opts.sellOutRate ?? DEFAULTS.sellOutRate;
    this.soldOutOfferIds = new Set(opts.soldOutOfferIds ?? []);
    this.processingPolls = opts.processingPolls ?? DEFAULTS.processingPolls;
    this.rateLimiter = new TokenBucketRateLimiter({
      rpm: opts.rateLimitRpm ?? config?.rateLimitRpm ?? DEFAULTS.rateLimitRpm,
      burst: opts.rateLimitBurst ?? config?.rateLimitBurst ?? DEFAULTS.rateLimitBurst,
      now: () => this.now().getTime(),
    });
  }

  // ---------------------------------------------------------------------------
  // Test / dev controls
  // ---------------------------------------------------------------------------

  /**
   * Make the next `count` supplier calls fail with the given kind.
   * This is how the retry / circuit breaker path is exercised offline.
   */
  failNext(count = 1, kind: MockFailureKind = 'error'): this {
    for (let i = 0; i < count; i += 1) {
      this.failures.push(kind);
    }
    return this;
  }

  /** Number of bookings currently held in the ledger. */
  get bookingCount(): number {
    return this.ledger.size;
  }

  // ---------------------------------------------------------------------------
  // Static content
  // ---------------------------------------------------------------------------

  async getHotel(supplierHotelId: string): Promise<SupplierHotel> {
    this.beginCall('content');
    const hotel = this.catalog.find((candidate) => candidate.id === supplierHotelId);
    if (!hotel) {
      throw new AppError('HOTEL_NOT_FOUND', `Hotel ${supplierHotelId} does not exist`, {
        details: { supplierHotelId },
      });
    }
    const xml = this.codec.encodeHotelResponse(hotel);
    const decoded = this.codec.decodeHotelResponse(xml);
    return { ...decoded, raw: xml };
  }

  async listHotels(params: {
    destination?: SupplierDestination;
    page?: number;
    pageSize?: number;
  } = {}): Promise<SupplierHotel[]> {
    this.beginCall('content');
    const matched = this.matchHotels(params.destination);
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.max(1, params.pageSize ?? 50);
    const start = (page - 1) * pageSize;
    const slice = matched.slice(start, start + pageSize);
    const xml = this.codec.encodeHotelListResponse(slice);
    return this.codec.decodeHotelListResponse(xml).map((hotel) => ({ ...hotel, raw: xml }));
  }

  // ---------------------------------------------------------------------------
  // Search & availability
  // ---------------------------------------------------------------------------

  async searchHotels(query: SupplierSearchQuery): Promise<SupplierSearchResult> {
    this.beginCall('search');
    this.validateStay(query.checkIn, query.checkOut);

    const hotels = this.matchHotels(query.destination);
    const summaries: SupplierHotelSummary[] = hotels.map((hotel) => {
      const quotes = this.quotesFor(hotel, query);
      const lowestNightly = minAmount(quotes.map((quote) => quote.nightly.total));
      const lowestStay = minAmount(quotes.map((quote) => quote.stayTotal.total));
      return {
        id: hotel.id,
        name: hotel.name,
        ...(hotel.starRating !== undefined ? { starRating: hotel.starRating } : {}),
        address: hotel.address,
        ...(hotel.geo ? { geo: hotel.geo } : {}),
        ...(hotel.images[0] ? { thumbnail: hotel.images[0].url } : {}),
        ...(lowestNightly ? { lowestNightlyTotal: lowestNightly } : {}),
        ...(lowestStay ? { lowestStayTotal: lowestStay } : {}),
      };
    });

    const xml = this.codec.encodeSearchResponse({
      hotels: summaries,
      total: summaries.length,
      currency: query.currency,
    });
    const decoded = this.codec.decodeSearchResponse(xml);
    return { ...decoded, raw: xml };
  }

  async getAvailability(
    query: SupplierSearchQuery & { hotelIds: string[] },
  ): Promise<SupplierHotelAvailability[]> {
    this.beginCall('search');
    this.validateStay(query.checkIn, query.checkOut);

    const hotels =
      query.hotelIds.length > 0
        ? query.hotelIds
            .map((id) => this.catalog.find((hotel) => hotel.id === id))
            .filter((hotel): hotel is SupplierHotel => hotel !== undefined)
        : this.matchHotels(query.destination);

    const availabilities: SupplierHotelAvailability[] = hotels.map((hotel) => ({
      supplierHotelId: hotel.id,
      currency: query.currency,
      quotes: this.quotesFor(hotel, query),
    }));

    const xml = this.codec.encodeAvailabilityResponse(availabilities);
    return this.codec.decodeAvailabilityResponse(xml).map((availability) => ({
      ...availability,
      raw: xml,
    }));
  }

  // ---------------------------------------------------------------------------
  // Booking lifecycle
  // ---------------------------------------------------------------------------

  async precheck(input: SupplierPrecheckInput): Promise<SupplierPrecheckResult> {
    this.beginCall('precheck');
    this.validateStay(input.checkIn, input.checkOut);

    const resolved = this.resolveOffer(input.offerId);
    if (!resolved) {
      throw new AppError('ROOM_UNAVAILABLE', `Offer ${input.offerId} is not a known offer`, {
        details: { offerId: input.offerId, supplierHotelId: input.supplierHotelId },
      });
    }

    if (this.driftedParameters(input, resolved.parts)) {
      this.logger.warn('agoda.mock.parameter_drift', {
        offerId: input.offerId,
        expected: resolved.parts,
        received: { checkIn: input.checkIn, checkOut: input.checkOut, rooms: input.rooms },
      });
    }

    // Sell-out: the offer disappeared between search and precheck.
    if (
      this.soldOutOfferIds.has(input.offerId) ||
      isSoldOut(input.offerId, input.contextFingerprint, this.sellOutRate)
    ) {
      throw new AppError('ROOM_UNAVAILABLE', `Offer ${input.offerId} is no longer available`, {
        details: { offerId: input.offerId, supplierHotelId: resolved.hotel.id },
      });
    }

    // Price drift: the supplier re-prices the offer at precheck time.
    const drift = decideDrift(
      input.offerId,
      input.contextFingerprint,
      this.priceDriftRate,
      this.driftMinPercent,
      this.driftMaxPercent,
    );
    const quote = this.quoteFor(resolved, resolved.parts, drift.percent);
    const original = this.issuedQuotes.get(input.offerId) ?? this.quoteFor(resolved, resolved.parts, 0);

    const xml = this.codec.encodePrecheckResponse(
      { quote, priceChanged: false, available: true },
      original.stayTotal.total,
    );
    const decoded = this.codec.decodePrecheckResponse(xml, resolved.parts.currency);
    this.logger.info('agoda.mock.precheck', {
      offerId: input.offerId,
      priceChanged: decoded.priceChanged,
      driftPercent: drift.percent,
    });
    return decoded;
  }

  async book(input: SupplierBookingInput): Promise<SupplierBookingResult> {
    this.beginCall('booking');
    this.validateStay(input.checkIn, input.checkOut);

    // Idempotent replay: the same idempotency key returns the same booking.
    const replay = this.ledger.findByIdempotencyKey(input.idempotencyKey);
    if (replay) {
      return this.bookingResultOf(replay);
    }

    const resolved = this.resolveOffer(input.offerId);
    if (!resolved) {
      throw new AppError('ROOM_UNAVAILABLE', `Offer ${input.offerId} is not a known offer`, {
        details: { offerId: input.offerId, supplierHotelId: input.supplierHotelId },
      });
    }

    // Duplicate validation: Agoda rejects a second booking with the same
    // lead guest name, same hotel and overlapping stay dates, EVEN THOUGH
    // we send allowDuplication: true.
    const lead = input.guests.find((guest) => guest.isLead) ?? input.guests[0];
    const leadGuestName = lead ? normalizeGuestName(lead.firstName, lead.lastName) : '';
    const duplicate = this.ledger.findDuplicate(
      input.supplierHotelId,
      leadGuestName,
      input.checkIn,
      input.checkOut,
    );
    if (duplicate) {
      throw new AppError(
        'DUPLICATE_BOOKING',
        `Agoda rejected the booking: a booking for ${leadGuestName} at ${input.supplierHotelId} already exists for overlapping dates`,
        {
          details: {
            supplierBookingId: duplicate.supplierBookingId,
            supplierHotelId: input.supplierHotelId,
            allowDuplication: input.allowDuplication,
          },
        },
      );
    }

    if (
      this.soldOutOfferIds.has(input.offerId) ||
      isSoldOut(input.offerId, input.contextFingerprint, this.sellOutRate)
    ) {
      throw new AppError('ROOM_UNAVAILABLE', `Offer ${input.offerId} is no longer available`, {
        details: { offerId: input.offerId, supplierHotelId: input.supplierHotelId },
      });
    }

    const drift = decideDrift(
      input.offerId,
      input.contextFingerprint,
      this.priceDriftRate,
      this.driftMinPercent,
      this.driftMaxPercent,
    );
    const quote = this.quoteFor(resolved, resolved.parts, drift.percent);

    if (
      input.expectedTotal &&
      (input.expectedTotal.amount !== quote.stayTotal.total.amount ||
        input.expectedTotal.currency !== quote.stayTotal.total.currency)
    ) {
      throw new AppError(
        'PRICE_CHANGED',
        `Price changed for offer ${input.offerId}: expected ${input.expectedTotal.amount} ${input.expectedTotal.currency}, supplier asks ${quote.stayTotal.total.amount} ${quote.stayTotal.total.currency}`,
        {
          details: {
            offerId: input.offerId,
            expected: { amount: input.expectedTotal.amount, currency: input.expectedTotal.currency },
            actual: { amount: quote.stayTotal.total.amount, currency: quote.stayTotal.total.currency },
          },
        },
      );
    }

    this.bookingSequence += 1;
    const supplierBookingId = `AGBK-${String(this.bookingSequence).padStart(6, '0')}`;
    const processing = this.processingPolls > 0;
    const entry = this.ledger.create({
      supplierBookingId,
      idempotencyKey: input.idempotencyKey,
      hotelId: input.supplierHotelId,
      offerId: input.offerId,
      quote,
      input,
      status: processing ? 'PROCESSING' : 'CONFIRMED',
      processing,
      pollsRemaining: this.processingPolls,
      confirmationNumber: processing ? undefined : confirmationNumberFor(input.idempotencyKey),
      cancelled: false,
      leadGuestName,
      createdAt: this.now().getTime(),
    });

    this.logger.info('agoda.mock.book', {
      supplierBookingId,
      supplierHotelId: input.supplierHotelId,
      status: entry.status,
      processing: entry.processing,
    });
    return this.bookingResultOf(entry);
  }

  async getBooking(supplierBookingId: string): Promise<SupplierBookingDetail> {
    this.beginCall('detail');
    const entry = this.ledger.get(supplierBookingId);
    if (!entry) {
      throw new AppError('NOT_FOUND', `Booking ${supplierBookingId} does not exist`, {
        details: { supplierBookingId },
      });
    }

    if (entry.status === 'PROCESSING') {
      if (entry.pollsRemaining > 0) {
        entry.pollsRemaining -= 1;
      } else {
        // The allotment has been reserved: the booking is now confirmed.
        entry.status = 'CONFIRMED';
        entry.processing = false;
        entry.confirmationNumber = entry.confirmationNumber ?? confirmationNumberFor(entry.idempotencyKey);
      }
    }

    const detail: SupplierBookingDetail = {
      supplierBookingId: entry.supplierBookingId,
      ...(entry.confirmationNumber ? { confirmationNumber: entry.confirmationNumber } : {}),
      status: entry.status,
      processing: entry.processing,
      total: entry.quote.stayTotal.total,
      checkIn: entry.input.checkIn,
      checkOut: entry.input.checkOut,
      guests: entry.input.guests,
      cancellationPolicy: entry.quote.cancellationPolicy,
    };
    const xml = this.codec.encodeBookingDetailResponse(detail);
    const decoded = this.codec.decodeBookingDetailResponse(xml);
    return { ...decoded, raw: xml };
  }

  async cancel(input: SupplierCancelInput): Promise<SupplierCancelResult> {
    this.beginCall('cancel');
    const entry = this.ledger.get(input.supplierBookingId);
    if (!entry) {
      throw new AppError('NOT_FOUND', `Booking ${input.supplierBookingId} does not exist`, {
        details: { supplierBookingId: input.supplierBookingId },
      });
    }

    // Cancelling twice is idempotent: the same answer, no second penalty.
    if (!entry.cancelled) {
      const { penalty, refund } = this.computeCancellation(entry);
      entry.cancelled = true;
      entry.status = 'CANCELLED';
      entry.processing = false;
      entry.penaltyAmount = penalty;
      entry.refundAmount = refund;
    }

    return this.cancelResultOf(entry);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Every supplier call starts here: quota first (429), then the injected
   * failures (timeout / 5xx), then the business logic.
   */
  private beginCall(endpoint: string): void {
    this.rateLimiter.acquire(endpoint);
    const failure = this.failures.shift();
    if (!failure) return;
    throw this.failureError(failure, endpoint);
  }

  private failureError(kind: MockFailureKind, endpoint: string): AppError {
    switch (kind) {
      case 'timeout':
        return new AppError('SUPPLIER_TIMEOUT', `Agoda ${endpoint} timed out`, {
          details: { endpoint, injected: kind },
        });
      case 'rateLimit':
        return new AppError('SUPPLIER_RATE_LIMITED', `Agoda throttled the ${endpoint} call`, {
          details: { endpoint, injected: kind },
        });
      case 'auth':
        return new AppError('SUPPLIER_AUTH_ERROR', `Agoda rejected the credentials on ${endpoint}`, {
          details: { endpoint, injected: kind },
        });
      case 'rejected':
        return new AppError('BOOKING_REJECTED', 'Agoda rejected the booking', {
          details: { endpoint, injected: kind, supplierCode: 'SUPPLIER_REJECTED' },
        });
      case 'duplicate':
        return new AppError('DUPLICATE_BOOKING', 'Agoda rejected the booking as a duplicate', {
          details: { endpoint, injected: kind, supplierCode: 'DUPLICATE_BOOKING' },
        });
      case 'sellOut':
        return new AppError('ROOM_UNAVAILABLE', 'The offer is no longer available', {
          details: { endpoint, injected: kind, supplierCode: 'ROOM_UNAVAILABLE' },
        });
      case 'priceChanged':
        return new AppError('PRICE_CHANGED', 'Agoda re-priced the offer', {
          details: { endpoint, injected: kind, supplierCode: 'PRICE_CHANGED' },
        });
      case 'error':
      default:
        return new AppError('SUPPLIER_ERROR', `Agoda returned an unexpected error on ${endpoint}`, {
          details: { endpoint, injected: kind },
        });
    }
  }

  private validateStay(checkIn: LocalDate, checkOut: LocalDate): void {
    const nights = diffDays(checkIn, checkOut);
    if (nights <= 0) {
      throw new AppError('VALIDATION_ERROR', `Invalid stay range ${checkIn} -> ${checkOut}`, {
        details: { checkIn, checkOut },
      });
    }
  }

  /**
   * Destination matching.
   *
   * A destination is one of: a city id, a free text name, or a country.
   * When a city id is given it wins (Agoda resolves the city first); the
   * country code, if present, narrows the result further.
   */
  private matchHotels(destination?: SupplierDestination): SupplierHotel[] {
    if (!destination) return [...this.catalog];
    const name = destination.name?.trim().toLowerCase();
    const cityId = destination.cityId;
    const countryCode = destination.countryCode?.toUpperCase();
    if (!name && !cityId && !countryCode) return [...this.catalog];

    return this.catalog.filter((hotel) => {
      const countryMatches = !countryCode || hotel.address.countryCode.toUpperCase() === countryCode;
      if (cityId) return this.cityIdOf(hotel) === cityId && countryMatches;
      if (name) {
        const nameMatches =
          hotel.address.city.toLowerCase().includes(name) || hotel.name.toLowerCase().includes(name);
        return nameMatches && countryMatches;
      }
      return countryMatches;
    });
  }

  private cityIdOf(hotel: SupplierHotel): string | undefined {
    return CITY_IDS[hotel.id];
  }

  /** All quotes of a hotel for one stay, recorded as the "quoted" prices. */
  private quotesFor(
    hotel: SupplierHotel,
    query: { checkIn: LocalDate; checkOut: LocalDate; rooms: number; adults: number; childAges: number[]; currency: Currency },
  ): SupplierQuote[] {
    const quotes: SupplierQuote[] = [];
    for (const roomType of hotel.roomTypes) {
      for (const ratePlan of ratePlansFor(hotel, roomType)) {
        const quote = buildQuote({
          seed: this.seed,
          hotel,
          roomType,
          ratePlan,
          checkIn: query.checkIn,
          checkOut: query.checkOut,
          rooms: query.rooms,
          adults: query.adults,
          childAges: query.childAges,
          currency: query.currency,
        });
        this.issuedQuotes.set(quote.offerId, quote);
        quotes.push(quote);
      }
    }
    return quotes;
  }

  private resolveOffer(
    offerId: string,
  ): { hotel: SupplierHotel; roomType: SupplierHotel['roomTypes'][number]; ratePlan: RatePlanSpec; parts: NonNullable<ReturnType<typeof decodeOfferId>> } | undefined {
    const parts = decodeOfferId(offerId);
    if (!parts) return undefined;
    const hotel = this.catalog.find((candidate) => candidate.id === parts.hotelId);
    const roomType = hotel?.roomTypes.find((candidate) => candidate.id === parts.roomTypeId);
    if (!hotel || !roomType) return undefined;
    const ratePlan = ratePlansFor(hotel, roomType).find((candidate) => candidate.id === parts.ratePlanId);
    if (!ratePlan) return undefined;
    return { hotel, roomType, ratePlan, parts };
  }

  private quoteFor(
    resolved: { hotel: SupplierHotel; roomType: SupplierHotel['roomTypes'][number]; ratePlan: RatePlanSpec },
    parts: NonNullable<ReturnType<typeof decodeOfferId>>,
    driftPercent: number,
  ): SupplierQuote {
    return buildQuote({
      seed: this.seed,
      hotel: resolved.hotel,
      roomType: resolved.roomType,
      ratePlan: resolved.ratePlan,
      checkIn: parts.checkIn,
      checkOut: parts.checkOut,
      rooms: parts.rooms,
      adults: parts.adults,
      childAges: parts.childAges,
      currency: parts.currency,
      driftPercent,
    });
  }

  private driftedParameters(
    input: SupplierPrecheckInput,
    parts: NonNullable<ReturnType<typeof decodeOfferId>>,
  ): boolean {
    return (
      input.checkIn !== parts.checkIn ||
      input.checkOut !== parts.checkOut ||
      input.rooms !== parts.rooms ||
      input.adults !== parts.adults ||
      input.currency !== parts.currency
    );
  }

  private bookingResultOf(entry: LedgerEntry): SupplierBookingResult {
    const result: SupplierBookingResult = {
      supplierBookingId: entry.supplierBookingId,
      status: entry.status,
      processing: entry.processing,
      total: entry.quote.stayTotal.total,
      ...(entry.confirmationNumber ? { confirmationNumber: entry.confirmationNumber } : {}),
      ...(entry.status === 'REJECTED' ? { errorCode: 'BOOKING_REJECTED' } : {}),
    };
    const xml = this.codec.encodeBookingResponse(result);
    return this.codec.decodeBookingResponse(xml);
  }

  private cancelResultOf(entry: LedgerEntry): SupplierCancelResult {
    const result: SupplierCancelResult = {
      supplierBookingId: entry.supplierBookingId,
      cancelled: entry.cancelled,
      ...(entry.penaltyAmount ? { penaltyAmount: entry.penaltyAmount } : {}),
      ...(entry.refundAmount ? { refundAmount: entry.refundAmount } : {}),
    };
    const xml = this.codec.encodeCancelResponse(result);
    return this.codec.decodeCancelResponse(xml);
  }

  /**
   * Apply the rate's cancellation policy.
   * A flexible rate that is cancelled after the free-cancellation deadline
   * keeps the first night; a partially refundable rate keeps the stated
   * percentage; a non refundable rate keeps everything.
   */
  private computeCancellation(entry: LedgerEntry): {
    penalty: Money;
    refund: Money;
  } {
    const policy = entry.quote.cancellationPolicy;
    const total = entry.quote.stayTotal.total;
    const nightly = entry.quote.nightly.total;
    const today = toLocalDate(this.now());

    let penalty: Money;
    if (policy.type === 'NON_REFUNDABLE') {
      penalty = total;
    } else if (policy.type === 'PARTIAL_REFUND') {
      penalty = percentOf(total, policy.penaltyPercent ?? 20);
    } else {
      const deadline = policy.freeCancellationUntil;
      penalty = deadline && today > deadline ? nightly : zeroMoney(total);
    }
    return {
      penalty,
      refund: { amount: total.amount - penalty.amount, currency: total.currency },
    };
  }
}

/** City id per hotel (Agoda city ids are only known at onboarding). */
const CITY_IDS: Record<string, string> = {
  '90001': '9398',
  '90002': '9398',
  '90003': '9452',
  '90004': '9391',
  '90005': '11119',
  '90006': '11119',
  '90007': '10501',
  '90008': '10502',
  '90009': '10885',
  '90010': '15691',
  '90011': '14837',
  '90012': '16055',
};

function isAdapterConfig(value: AgodaMockOptions | SupplierAdapterConfig): value is SupplierAdapterConfig {
  return 'mode' in value;
}

function minAmount(values: Money[]): Money | undefined {
  if (values.length === 0) return undefined;
  let best = values[0] as Money;
  for (const candidate of values) {
    if (candidate.amount < best.amount) best = candidate;
  }
  return best;
}

function zeroMoney(value: Money): Money {
  return { amount: 0, currency: value.currency };
}
