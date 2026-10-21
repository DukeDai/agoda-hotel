import { isCurrency, money } from '@ota/core';
import type { Currency, LocalDate, Money } from '@ota/core';
import type {
  CancellationPolicy,
  CancellationPolicyType,
  MealPlan,
  SupplierBookingDetail,
  SupplierBookingInput,
  SupplierBookingResult,
  SupplierCancelInput,
  SupplierCancelResult,
  SupplierGuest,
  SupplierHotel,
  SupplierHotelAvailability,
  SupplierHotelSummary,
  SupplierPrecheckInput,
  SupplierPrecheckResult,
  SupplierQuote,
  SupplierSearchQuery,
  SupplierSearchResult,
} from '../contract.js';
import { el, leaf, renderDocument, textEl } from './builder.js';
import type { XmlElement } from './builder.js';
import { ATTR, EL, VAL } from './schema.js';
import {
  attr,
  bool,
  child,
  children,
  date,
  int,
  isRecord,
  minorToDecimalString,
  num,
  parseMoney,
  parseXml,
  rootElement,
  scalar,
  text,
} from './parse.js';

/**
 * The Agoda XML codec.
 *
 * Encodes requests (Search / Precheck / Book / Cancel / Content) and decodes
 * responses into the `Supplier*` DTOs of ../contract.ts.
 *
 * Guarantees:
 *  - every element / attribute name comes from ./schema.ts (one mapping file,
 *    corrected in one place when the Agoda welcome package arrives);
 *  - user controlled text (guest names, special requests) is XML escaped;
 *  - decoding NEVER throws and NEVER produces `NaN` money: a missing or
 *    malformed field becomes `undefined`;
 *  - money is integer minor units end to end.
 */
export class AgodaXmlCodec {
  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  /** Search / availability request. */
  encodeSearchRequest(query: SupplierSearchQuery, hotelIds: string[] = []): string {
    return renderDocument(
      el(EL.AVAIL_RQ, [
        el(EL.AVAIL_REQUEST_SEGMENTS, [
          this.buildStaySegment({
            destination: query.destination,
            checkIn: query.checkIn,
            checkOut: query.checkOut,
            rooms: query.rooms,
            adults: query.adults,
            childAges: query.childAges,
            currency: query.currency,
            nationality: query.nationality,
            hotelIds,
            requestType: VAL.REQUEST_TYPE_SEARCH,
          }),
        ]),
      ]),
    );
  }

  /** Precheck request: same parameters as search, plus the offer + fingerprint. */
  encodePrecheckRequest(input: SupplierPrecheckInput): string {
    return renderDocument(
      el(EL.AVAIL_RQ, [
        el(EL.AVAIL_REQUEST_SEGMENTS, [
          this.buildStaySegment({
            destination: undefined,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            rooms: input.rooms,
            adults: input.adults,
            childAges: input.childAges,
            currency: input.currency,
            nationality: input.nationality,
            hotelIds: [input.supplierHotelId],
            requestType: VAL.REQUEST_TYPE_PRECHECK,
            offerId: input.offerId,
            contextFingerprint: input.contextFingerprint,
          }),
        ]),
      ]),
    );
  }

  /** Booking request. */
  encodeBookingRequest(input: SupplierBookingInput): string {
    const guestNodes = input.guests.map((guest) => this.buildResGuest(guest));
    return renderDocument(
      el(EL.RES_RQ, [
        el(EL.HOTEL_RESERVATIONS, [
          el(EL.HOTEL_RESERVATION, [
            el(EL.UNIQUE_ID, [], { [ATTR.ID]: input.idempotencyKey, [ATTR.COMPANY_NAME]: VAL.COMPANY_NAME }),
            el(EL.RES_GLOBAL_INFO, [leaf(EL.RES_BOOKING_TYPE, VAL.BOOKING_TYPE_NEW)]),
            el(EL.ROOM_STAYS, [
              el(EL.ROOM_STAY, [
                el(EL.ROOM_STAY_INDEXES, [
                  el(EL.ROOM_STAY_INDEX, [
                    el(EL.TIME_SPAN, [], { [ATTR.START]: input.checkIn, [ATTR.END]: input.checkOut }),
                  ]),
                ]),
                el(EL.GUEST_COUNTS, [
                  leaf(EL.ADULT_COUNT, input.adults),
                  leaf(EL.CHILD_COUNT, input.childAges.length),
                  ...(input.childAges.length > 0
                    ? [el(EL.CHILD_AGES, input.childAges.map((age) => leaf(EL.CHILD_AGE, age)))]
                    : []),
                ]),
              ]),
            ]),
            el(EL.RATE_PLANS, [el(EL.RATE_PLAN, [leaf(EL.RATE_PLAN_CODE, input.offerId)])]),
            el(EL.RES_GUESTS, guestNodes),
            ...(input.specialRequests && input.specialRequests.length > 0
              ? [el(EL.SPECIAL_REQUESTS, input.specialRequests.map((req) => leaf(EL.SPECIAL_REQUEST, req)))]
              : []),
            el(EL.ADDITIONAL_INFO, [
              leaf(EL.CURRENCY, input.currency),
              leaf(EL.NATIONALITY, input.nationality),
              leaf(EL.ROOMS, input.rooms),
              leaf(EL.OFFER_ID, input.offerId),
              leaf(EL.CONTEXT_FINGERPRINT, input.contextFingerprint),
              leaf(EL.ALLOW_DUPLICATION, input.allowDuplication),
              leaf(EL.IDEMPOTENCY_KEY, input.idempotencyKey),
            ]),
          ]),
        ]),
      ]),
    );
  }

  /** Cancellation request. */
  encodeCancelRequest(input: SupplierCancelInput): string {
    return renderDocument(
      el(EL.CANCEL_RQ, [
        el(EL.UNIQUE_ID, [], { [ATTR.ID]: input.supplierBookingId, [ATTR.COMPANY_NAME]: VAL.COMPANY_NAME }),
        el(EL.CANCEL_INFO, [
          leaf(EL.CANCELLATION_TYPE, 'Full'),
          ...(input.reason ? [leaf(EL.CANCEL_REASON, input.reason)] : []),
        ]),
        el(EL.ADDITIONAL_INFO, [leaf(EL.IDEMPOTENCY_KEY, input.idempotencyKey)]),
      ]),
    );
  }

  /** Static content request (hotel detail / catalogue). */
  encodeHotelContentRequest(
    params: {
      hotelIds?: string[];
      destination?: SupplierSearchQuery['destination'];
      page?: number;
      pageSize?: number;
    } = {},
  ): string {
    const hotelIds = params.hotelIds ?? [];
    const destination = params.destination;
    return renderDocument(
      el(EL.CONTENT_RQ, [
        el(EL.CONTENT_REQUEST, [
          ...(hotelIds.length > 0 ? [el(EL.HOTEL_IDS, hotelIds.map((id) => leaf(EL.HOTEL_ID, id)))] : []),
          ...(destination?.cityId ? [el(EL.CITY_IDS, [leaf(EL.CITY_ID, destination.cityId)])] : []),
          ...(destination?.name ? [leaf(EL.HOTEL_NAME, destination.name)] : []),
          ...(destination?.countryCode ? [leaf(EL.COUNTRY_CODE, destination.countryCode)] : []),
          leaf(EL.PAGE, params.page ?? 1),
          leaf(EL.PAGE_SIZE, params.pageSize ?? 50),
        ]),
      ]),
    );
  }

  // ---------------------------------------------------------------------------
  // Responses — decoders
  // ---------------------------------------------------------------------------

  /** Decode a search (multi-property availability) response. */
  decodeSearchResponse(xml: string): SupplierSearchResult {
    const segments = this.parseAvailSegments(xml);
    const hotels: SupplierHotelSummary[] = segments.map((segment) => segment.summary);
    const currency = segments[0]?.currency ?? 'USD';
    return { hotels, total: hotels.length, currency, raw: xml };
  }

  /** Decode a room-level availability response. */
  decodeAvailabilityResponse(xml: string): SupplierHotelAvailability[] {
    return this.parseAvailSegments(xml).map((segment) => ({
      supplierHotelId: segment.hotelId,
      currency: segment.currency,
      quotes: segment.quotes,
      raw: xml,
    }));
  }

  /**
   * Decode a precheck response.
   *
   * `priceChanged` is derived from the supplier echoing back the total it
   * originally quoted (see `EL.ORIGINAL_TOTAL`): when the re-validated total
   * differs, the supplier re-priced the offer.
   */
  decodePrecheckResponse(xml: string, expectedCurrency: Currency): SupplierPrecheckResult {
    const segments = this.parseAvailSegments(xml);
    const first = segments[0];
    const quote = first?.quotes[0];
    if (!quote) {
      return { quote: this.emptyQuote(expectedCurrency), priceChanged: false, available: false, raw: xml };
    }
    const original = first?.originalTotal;
    const priceChanged = original !== undefined && original.amount !== quote.stayTotal.total.amount;
    return {
      quote,
      priceChanged,
      available: first?.available !== false,
      raw: xml,
    };
  }

  /** Decode a booking creation response. */
  decodeBookingResponse(xml: string): SupplierBookingResult {
    const reservation = this.firstReservation(xml);
    if (!reservation) {
      // A body we cannot understand must not crash the business layer.
      return { supplierBookingId: '', status: 'REJECTED', processing: false, raw: xml };
    }
    const status = this.decodeStatus(text(reservation, EL.RES_STATUS));
    const global = child(reservation, EL.RES_GLOBAL_INFO);
    const errorNode = child(global, EL.ERROR);
    const errorCode = attr(errorNode, ATTR.CODE);
    const errorMessage = scalar(errorNode);
    const confirmation = text(child(reservation, EL.RES_CONFIRMATION), EL.CONFIRMATION_NUMBER);
    const total = parseMoney(child(reservation, EL.TOTAL), EL.TOTAL_AMOUNT, this.currencyOf(reservation));
    const processingRaw = bool(global, EL.PROCESSING);
    const processing = processingRaw ?? status === 'PROCESSING';

    return {
      supplierBookingId: attr(child(reservation, EL.UNIQUE_ID), ATTR.ID) ?? '',
      ...(confirmation ? { confirmationNumber: confirmation } : {}),
      status,
      processing,
      ...(total ? { total } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
      raw: xml,
    };
  }

  /** Decode a booking detail (polling) response. */
  decodeBookingDetailResponse(xml: string): SupplierBookingDetail {
    const reservation = this.firstReservation(xml);
    if (!reservation) {
      return {
        supplierBookingId: '',
        status: 'REJECTED',
        processing: false,
        checkIn: '',
        checkOut: '',
        guests: [],
        raw: xml,
      };
    }
    const status = this.decodeStatus(text(reservation, EL.RES_STATUS));
    const global = child(reservation, EL.RES_GLOBAL_INFO);
    const processingRaw = bool(global, EL.PROCESSING);
    const processing = processingRaw ?? status === 'PROCESSING';
    const confirmation = text(child(reservation, EL.RES_CONFIRMATION), EL.CONFIRMATION_NUMBER);
    const currency = this.currencyOf(reservation);
    const total = parseMoney(child(reservation, EL.TOTAL), EL.TOTAL_AMOUNT, currency);
    const timeSpan = this.firstTimeSpan(reservation);
    const guests = this.decodeGuests(reservation);
    const policy = this.decodeCancellationPolicy(child(reservation, EL.CANCELLATION_POLICY), currency);

    return {
      supplierBookingId: attr(child(reservation, EL.UNIQUE_ID), ATTR.ID) ?? '',
      ...(confirmation ? { confirmationNumber: confirmation } : {}),
      status,
      processing,
      ...(total ? { total } : {}),
      checkIn: timeSpan?.start ?? '',
      checkOut: timeSpan?.end ?? '',
      guests,
      ...(policy ? { cancellationPolicy: policy } : {}),
      ...(text(global, EL.ERROR) ? { errorMessage: text(global, EL.ERROR) } : {}),
      raw: xml,
    };
  }

  /** Decode a cancellation response. */
  decodeCancelResponse(xml: string): SupplierCancelResult {
    const reservation = this.firstReservation(xml);
    if (!reservation) {
      return { supplierBookingId: '', cancelled: false, raw: xml };
    }
    const status = this.decodeStatus(text(reservation, EL.RES_STATUS));
    const cancelInfo = child(reservation, EL.CANCEL_INFO);
    const currency = this.currencyOf(reservation);
    const refund = parseMoney(cancelInfo, EL.REFUND_AMOUNT, currency);
    const penalty = parseMoney(cancelInfo, EL.PENALTY_TOTAL, currency);
    return {
      supplierBookingId: attr(child(reservation, EL.UNIQUE_ID), ATTR.ID) ?? '',
      cancelled: status === 'CANCELLED',
      ...(refund ? { refundAmount: refund } : {}),
      ...(penalty ? { penaltyAmount: penalty } : {}),
      raw: xml,
    };
  }

  /** Decode a static content response into hotels. */
  decodeHotelListResponse(xml: string): SupplierHotel[] {
    const root = rootElement(parseXml(xml));
    const hotels = children(child(root, EL.HOTELS), EL.HOTEL);
    return hotels
      .map((hotel) => this.decodeHotelNode(hotel))
      .filter((hotel): hotel is SupplierHotel => hotel !== undefined);
  }

  /** Decode a static content response into a single hotel. */
  decodeHotelResponse(xml: string): SupplierHotel {
    const hotels = this.decodeHotelListResponse(xml);
    const hotel = hotels[0];
    if (!hotel) {
      throw new Error('Agoda content response contains no Hotel');
    }
    return hotel;
  }

  /**
   * Extract a supplier error (code + message) from any response body.
   * Used by the live adapter to map a business failure to an AppError code.
   */
  extractError(xml: string): { code?: string; message?: string } | undefined {
    const root = rootElement(parseXml(xml));
    const errorNode =
      child(root, EL.ERROR) ?? child(child(child(root, EL.HOTEL_RESERVATIONS), EL.HOTEL_RESERVATION), EL.RES_GLOBAL_INFO);
    const errorElement = errorNode === undefined ? undefined : child(errorNode, EL.ERROR) ?? errorNode;
    if (errorElement === undefined) return undefined;
    const code = attr(errorElement, ATTR.CODE);
    const message = scalar(errorElement);
    if (code === undefined && message === undefined) return undefined;
    return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
  }

  // ---------------------------------------------------------------------------
  // Responses — encoders (the mock produces the very same dialect)
  // ---------------------------------------------------------------------------

  /** Encode a search response (hotel summaries). */
  encodeSearchResponse(result: SupplierSearchResult): string {
    const segments = result.hotels.map((hotel) =>
      el(EL.AVAIL_RESPONSE_SEGMENT, [
        leaf(EL.HOTEL_ID, hotel.id),
        leaf(EL.HOTEL_NAME, hotel.name),
        ...(hotel.starRating !== undefined ? [leaf(EL.STAR_RATING, hotel.starRating)] : []),
        ...(hotel.geo
          ? [el(EL.GEO, [leaf(EL.LATITUDE, hotel.geo.latitude), leaf(EL.LONGITUDE, hotel.geo.longitude)])]
          : []),
        el(EL.ADDRESS, [
          leaf(EL.CITY_NAME, hotel.address.city),
          leaf(EL.COUNTRY_NAME, hotel.address.country),
          leaf(EL.COUNTRY_CODE, hotel.address.countryCode),
        ]),
        el(EL.HOTEL_SUMMARY, [
          ...(hotel.lowestNightlyTotal
            ? [leaf(EL.LOWEST_NIGHTLY_TOTAL, minorToDecimalString(hotel.lowestNightlyTotal.amount, hotel.lowestNightlyTotal.currency))]
            : []),
          ...(hotel.lowestStayTotal
            ? [leaf(EL.LOWEST_STAY_TOTAL, minorToDecimalString(hotel.lowestStayTotal.amount, hotel.lowestStayTotal.currency))]
            : []),
          ...(hotel.thumbnail ? [leaf(EL.THUMBNAIL, hotel.thumbnail)] : []),
        ]),
        el(EL.ADDITIONAL_INFO, [leaf(EL.CURRENCY, result.currency)]),
      ]),
    );
    return renderDocument(el(EL.AVAIL_RS, [el(EL.AVAIL_RESPONSE_SEGMENTS, segments)]));
  }

  /** Encode a room-level availability response. */
  encodeAvailabilityResponse(availabilities: SupplierHotelAvailability[]): string {
    const segments = availabilities.map((availability) =>
      el(EL.AVAIL_RESPONSE_SEGMENT, [
        leaf(EL.HOTEL_ID, availability.supplierHotelId),
        el(EL.ADDITIONAL_INFO, [leaf(EL.CURRENCY, availability.currency)]),
        el(EL.ROOM_STAYS, [
          el(EL.ROOM_STAY, [
            el(EL.ROOM_STAY_INDEXES, [el(EL.ROOM_STAY_INDEX, [leaf('RoomStayIndex', 1)])]),
            el(EL.RATES, availability.quotes.map((quote) => this.encodeQuote(quote))),
          ]),
        ]),
      ]),
    );
    return renderDocument(el(EL.AVAIL_RS, [el(EL.AVAIL_RESPONSE_SEGMENTS, segments)]));
  }

  /**
   * Encode a precheck response.
   * `originalTotal` is the total we were quoted before the re-validation.
   */
  encodePrecheckResponse(result: SupplierPrecheckResult, originalTotal?: Money, available = true): string {
    const segment = el(EL.AVAIL_RESPONSE_SEGMENT, [
      leaf(EL.HOTEL_ID, result.quote.supplierHotelId),
      el(EL.ADDITIONAL_INFO, [leaf(EL.CURRENCY, result.quote.currency)]),
      leaf(EL.AVAILABLE, available),
      ...(originalTotal
        ? [leaf(EL.ORIGINAL_TOTAL, minorToDecimalString(originalTotal.amount, originalTotal.currency))]
        : []),
      el(EL.ROOM_STAYS, [
        el(EL.ROOM_STAY, [
          el(EL.ROOM_STAY_INDEXES, [el(EL.ROOM_STAY_INDEX, [leaf('RoomStayIndex', 1)])]),
          el(EL.RATES, [this.encodeQuote(result.quote)]),
        ]),
      ]),
    ]);
    return renderDocument(el(EL.AVAIL_RS, [el(EL.AVAIL_RESPONSE_SEGMENTS, [segment])]));
  }

  /** Encode a booking response. */
  encodeBookingResponse(result: SupplierBookingResult): string {
    const globalInfo: XmlElement[] = [leaf(EL.PROCESSING, result.processing)];
    if (result.errorCode || result.errorMessage) {
      globalInfo.push(
        textEl(EL.ERROR, result.errorMessage ?? result.errorCode ?? '', {
          ...(result.errorCode ? { [ATTR.CODE]: result.errorCode } : {}),
        }),
      );
    }
    return renderDocument(
      el(EL.RES_RS, [
        el(EL.HOTEL_RESERVATIONS, [
          el(EL.HOTEL_RESERVATION, [
            el(EL.UNIQUE_ID, [], { [ATTR.ID]: result.supplierBookingId, [ATTR.COMPANY_NAME]: VAL.COMPANY_NAME }),
            leaf(EL.RES_STATUS, this.encodeStatus(result.status)),
            el(EL.RES_GLOBAL_INFO, globalInfo),
            ...(result.confirmationNumber
              ? [el(EL.RES_CONFIRMATION, [leaf(EL.CONFIRMATION_NUMBER, result.confirmationNumber)])]
              : []),
            ...(result.total
              ? [
                  el(EL.TOTAL, [
                    leaf(EL.TOTAL_AMOUNT, minorToDecimalString(result.total.amount, result.total.currency)),
                    leaf(EL.CURRENCY, result.total.currency),
                  ]),
                ]
              : []),
          ]),
        ]),
      ]),
    );
  }

  /** Encode a booking detail response. */
  encodeBookingDetailResponse(detail: SupplierBookingDetail): string {
    return renderDocument(
      el(EL.RES_RS, [
        el(EL.HOTEL_RESERVATIONS, [
          el(EL.HOTEL_RESERVATION, [
            el(EL.UNIQUE_ID, [], { [ATTR.ID]: detail.supplierBookingId, [ATTR.COMPANY_NAME]: VAL.COMPANY_NAME }),
            leaf(EL.RES_STATUS, this.encodeStatus(detail.status)),
            el(EL.RES_GLOBAL_INFO, [leaf(EL.PROCESSING, detail.processing)]),
            ...(detail.confirmationNumber
              ? [el(EL.RES_CONFIRMATION, [leaf(EL.CONFIRMATION_NUMBER, detail.confirmationNumber)])]
              : []),
            ...(detail.total
              ? [
                  el(EL.TOTAL, [
                    leaf(EL.TOTAL_AMOUNT, minorToDecimalString(detail.total.amount, detail.total.currency)),
                    leaf(EL.CURRENCY, detail.total.currency),
                  ]),
                ]
              : []),
            el(EL.ROOM_STAYS, [
              el(EL.ROOM_STAY, [
                el(EL.ROOM_STAY_INDEXES, [
                  el(EL.ROOM_STAY_INDEX, [
                    el(EL.TIME_SPAN, [], { [ATTR.START]: detail.checkIn, [ATTR.END]: detail.checkOut }),
                  ]),
                ]),
              ]),
            ]),
            ...(detail.guests.length > 0 ? [el(EL.RES_GUESTS, detail.guests.map((g) => this.buildResGuest(g)))] : []),
            ...(detail.cancellationPolicy
              ? [this.encodeCancellationPolicy(detail.cancellationPolicy)]
              : []),
          ]),
        ]),
      ]),
    );
  }

  /** Encode a cancellation response. */
  encodeCancelResponse(result: SupplierCancelResult): string {
    const currency = result.refundAmount?.currency ?? result.penaltyAmount?.currency ?? 'USD';
    return renderDocument(
      el(EL.CANCEL_RS, [
        el(EL.HOTEL_RESERVATIONS, [
          el(EL.HOTEL_RESERVATION, [
            el(EL.UNIQUE_ID, [], { [ATTR.ID]: result.supplierBookingId, [ATTR.COMPANY_NAME]: VAL.COMPANY_NAME }),
            leaf(EL.RES_STATUS, result.cancelled ? VAL.STATUS_CANCELLED : VAL.STATUS_REJECTED),
            el(EL.CANCEL_INFO, [
              ...(result.refundAmount
                ? [leaf(EL.REFUND_AMOUNT, minorToDecimalString(result.refundAmount.amount, result.refundAmount.currency))]
                : []),
              ...(result.penaltyAmount
                ? [leaf(EL.PENALTY_TOTAL, minorToDecimalString(result.penaltyAmount.amount, result.penaltyAmount.currency))]
                : []),
              leaf(EL.CURRENCY, currency),
            ]),
          ]),
        ]),
      ]),
    );
  }

  /** Encode a static content response. */
  encodeHotelListResponse(hotels: SupplierHotel[]): string {
    return renderDocument(el(EL.CONTENT_RS, [el(EL.HOTELS, hotels.map((hotel) => this.encodeHotel(hotel)))]));
  }

  /** Encode a single hotel (static content). */
  encodeHotelResponse(hotel: SupplierHotel): string {
    return this.encodeHotelListResponse([hotel]);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private buildStaySegment(params: {
    destination: SupplierSearchQuery['destination'] | undefined;
    checkIn: LocalDate;
    checkOut: LocalDate;
    rooms: number;
    adults: number;
    childAges: number[];
    currency: Currency;
    nationality: string;
    hotelIds: string[];
    requestType: string;
    offerId?: string;
    contextFingerprint?: string;
  }): XmlElement {
    const criteria: XmlElement[] = [];
    if (params.destination?.cityId) {
      criteria.push(el(EL.CITY_IDS, [leaf(EL.CITY_ID, params.destination.cityId)]));
    }
    if (params.destination?.name) {
      criteria.push(leaf(EL.HOTEL_NAME, params.destination.name));
    }
    if (params.destination?.countryCode) {
      criteria.push(leaf(EL.COUNTRY_CODE, params.destination.countryCode));
    }
    if (params.hotelIds.length > 0) {
      criteria.push(el(EL.HOTEL_IDS, params.hotelIds.map((id) => leaf(EL.HOTEL_ID, id))));
    }

    const additional: XmlElement[] = [
      leaf(EL.CURRENCY, params.currency),
      leaf(EL.NATIONALITY, params.nationality),
      leaf(EL.ROOMS, params.rooms),
      leaf(EL.REQUEST_TYPE, params.requestType),
    ];
    if (params.offerId) additional.push(leaf(EL.OFFER_ID, params.offerId));
    if (params.contextFingerprint) additional.push(leaf(EL.CONTEXT_FINGERPRINT, params.contextFingerprint));

    return el(EL.AVAIL_REQUEST_SEGMENT, [
      el(EL.HOTEL_SEARCH_CRITERIA, criteria),
      el(EL.HOTEL_STAY_REQUEST, [
        el(EL.ROOM_STAYS, [
          el(EL.ROOM_STAY, [
            el(EL.ROOM_STAY_INDEXES, [
              el(EL.ROOM_STAY_INDEX, [
                el(EL.TIME_SPAN, [], { [ATTR.START]: params.checkIn, [ATTR.END]: params.checkOut }),
              ]),
            ]),
            el(EL.GUEST_COUNTS, [
              leaf(EL.ADULT_COUNT, params.adults),
              leaf(EL.CHILD_COUNT, params.childAges.length),
              ...(params.childAges.length > 0
                ? [el(EL.CHILD_AGES, params.childAges.map((age) => leaf(EL.CHILD_AGE, age)))]
                : []),
            ]),
          ]),
        ]),
      ]),
      el(EL.ADDITIONAL_INFO, additional),
    ]);
  }

  private buildResGuest(guest: SupplierGuest): XmlElement {
    const profile: XmlElement[] = [
      el(EL.PERSON_NAME, [leaf(EL.GIVEN_NAME, guest.firstName), leaf(EL.SURNAME, guest.lastName)]),
      leaf(EL.EMAIL, guest.email),
    ];
    if (guest.phone) profile.push(leaf(EL.TELEPHONE, guest.phone));
    profile.push(leaf(EL.NATIONALITY, guest.nationality));
    return el(EL.RES_GUEST, [
      el(EL.GUEST_PROFILE, profile),
      el(EL.GUEST_COUNTS, [
        leaf(EL.ADULT_COUNT, guest.isLead ? 1 : 0),
        ...(guest.age !== undefined ? [leaf(EL.CHILD_AGE, guest.age)] : []),
      ]),
    ]);
  }

  private encodeQuote(quote: SupplierQuote): XmlElement {
    return el(EL.RATE_PLAN, [
      leaf(EL.OFFER_ID, quote.offerId),
      leaf(EL.RATE_PLAN_CODE, quote.ratePlanId),
      leaf(EL.RATE_PLAN_DESCRIPTION, quote.ratePlanName),
      leaf(EL.ROOM_TYPE_ID, quote.roomTypeId),
      leaf(EL.ROOM_TYPE_NAME, quote.roomTypeName),
      ...(quote.bedType ? [leaf(EL.BED_TYPE, quote.bedType)] : []),
      leaf(EL.MAX_OCCUPANCY, quote.maxOccupancy),
      leaf(EL.NIGHTS, quote.nights),
      leaf(EL.MEAL_PLAN, quote.mealPlan),
      leaf(EL.PAY_AT_HOTEL, quote.payAtHotel),
      leaf(EL.INSTANT_CONFIRMATION, quote.instantConfirmation),
      leaf(EL.TAXES_INCLUDED, quote.taxesIncluded),
      ...(quote.allotment !== undefined ? [leaf(EL.AVAILABLE_ROOMS, quote.allotment)] : []),
      el(EL.RATES, [
        el(EL.RATE, [this.encodeAmounts(EL.NIGHTLY, quote.nightly), this.encodeAmounts(EL.STAY, quote.stayTotal)]),
      ]),
      el(EL.CHARGES, [
        el(EL.CHARGE, [
          leaf(EL.CHARGE_TYPE, 'Tax'),
          leaf(EL.AMOUNT, minorToDecimalString(quote.nightly.taxes.amount, quote.nightly.taxes.currency)),
          leaf(EL.CURRENCY, quote.nightly.taxes.currency),
          leaf(EL.INCLUDED, quote.taxesIncluded),
        ]),
      ]),
      this.encodeCancellationPolicy(quote.cancellationPolicy),
    ]);
  }

  private encodeAmounts(name: string, amounts: { net: Money; taxes: Money; total: Money }): XmlElement {
    return el(name, [
      leaf(EL.AMOUNT, minorToDecimalString(amounts.total.amount, amounts.total.currency)),
      leaf(EL.NET_AMOUNT, minorToDecimalString(amounts.net.amount, amounts.net.currency)),
      leaf(EL.TAX_AMOUNT, minorToDecimalString(amounts.taxes.amount, amounts.taxes.currency)),
      leaf(EL.CURRENCY, amounts.total.currency),
    ]);
  }

  private encodeCancellationPolicy(policy: CancellationPolicy): XmlElement {
    return el(EL.CANCELLATION_POLICY, [
      leaf(EL.CANCELLATION_POLICY_TYPE, policy.type),
      leaf(EL.REFUNDABLE, policy.refundable),
      ...(policy.freeCancellationUntil ? [leaf(EL.FREE_CANCELLATION_UNTIL, policy.freeCancellationUntil)] : []),
      ...(policy.penaltyAmount
        ? [leaf(EL.PENALTY_AMOUNT, minorToDecimalString(policy.penaltyAmount.amount, policy.penaltyAmount.currency))]
        : []),
      ...(policy.penaltyPercent !== undefined ? [leaf(EL.PENALTY_PERCENT, policy.penaltyPercent)] : []),
      ...(policy.noShowPenalty
        ? [leaf(EL.NO_SHOW_PENALTY, minorToDecimalString(policy.noShowPenalty.amount, policy.noShowPenalty.currency))]
        : []),
      leaf(EL.DESCRIPTION, policy.description),
    ]);
  }

  private encodeHotel(hotel: SupplierHotel): XmlElement {
    return el(EL.HOTEL, [
      leaf(EL.HOTEL_ID, hotel.id),
      leaf(EL.HOTEL_NAME, hotel.name),
      ...(hotel.description ? [leaf(EL.DESCRIPTION, hotel.description)] : []),
      ...(hotel.starRating !== undefined ? [leaf(EL.STAR_RATING, hotel.starRating)] : []),
      ...(hotel.category ? [leaf(EL.CATEGORY, hotel.category)] : []),
      el(EL.ADDRESS, [
        ...(hotel.address.street ? [leaf(EL.ADDRESS_LINE, hotel.address.street)] : []),
        leaf(EL.CITY_NAME, hotel.address.city),
        ...(hotel.address.state ? [leaf(EL.STATE_PROVINCE, hotel.address.state)] : []),
        leaf(EL.COUNTRY_NAME, hotel.address.country),
        leaf(EL.COUNTRY_CODE, hotel.address.countryCode),
        ...(hotel.address.postalCode ? [leaf(EL.POSTAL_CODE, hotel.address.postalCode)] : []),
        ...(hotel.address.timeZone ? [leaf(EL.TIME_ZONE, hotel.address.timeZone)] : []),
      ]),
      ...(hotel.geo
        ? [el(EL.GEO, [leaf(EL.LATITUDE, hotel.geo.latitude), leaf(EL.LONGITUDE, hotel.geo.longitude)])]
        : []),
      el(EL.IMAGES, hotel.images.map((image) => this.encodeImage(image))),
      el(EL.AMENITIES, hotel.amenities.map((amenity) => this.encodeAmenity(amenity))),
      el(EL.ROOM_TYPES, hotel.roomTypes.map((roomType) => this.encodeRoomType(roomType))),
      ...(hotel.checkInTime ? [leaf(EL.CHECK_IN_TIME, hotel.checkInTime)] : []),
      ...(hotel.checkOutTime ? [leaf(EL.CHECK_OUT_TIME, hotel.checkOutTime)] : []),
      el(EL.POLICIES, (hotel.policies ?? []).map((policy) => leaf(EL.POLICY, policy))),
    ]);
  }

  private encodeImage(image: SupplierImageLike): XmlElement {
    return el(
      EL.IMAGE,
      [leaf(EL.URL, image.url), ...(image.caption ? [leaf(EL.CAPTION, image.caption)] : [])],
      image.order !== undefined ? { [ATTR.ORDER]: image.order } : {},
    );
  }

  private encodeAmenity(amenity: SupplierAmenityLike): XmlElement {
    return el(EL.AMENITY, [
      ...(amenity.group ? [leaf(EL.GROUP, amenity.group)] : []),
      leaf(EL.NAME, amenity.name),
    ]);
  }

  private encodeRoomType(roomType: SupplierRoomTypeLike): XmlElement {
    return el(EL.ROOM_TYPE, [
      leaf(EL.ROOM_TYPE_ID, roomType.id),
      leaf(EL.ROOM_TYPE_NAME, roomType.name),
      ...(roomType.description ? [leaf(EL.DESCRIPTION, roomType.description)] : []),
      leaf(EL.MAX_OCCUPANCY, roomType.maxOccupancy),
      ...(roomType.bedType ? [leaf(EL.BED_TYPE, roomType.bedType)] : []),
      ...(roomType.sizeSqm !== undefined ? [leaf(EL.SIZE_SQM, roomType.sizeSqm)] : []),
      el(EL.IMAGES, roomType.images.map((image) => this.encodeImage(image))),
      el(EL.AMENITIES, roomType.amenities.map((amenity) => this.encodeAmenity(amenity))),
    ]);
  }

  private parseAvailSegments(xml: string): AvailSegment[] {
    const root = rootElement(parseXml(xml));
    const segments = children(child(root, EL.AVAIL_RESPONSE_SEGMENTS), EL.AVAIL_RESPONSE_SEGMENT);
    const out: AvailSegment[] = [];
    for (const segment of segments) {
      const hotelId = text(segment, EL.HOTEL_ID) ?? '';
      const additional = child(segment, EL.ADDITIONAL_INFO);
      const currencyRaw = text(additional, EL.CURRENCY);
      const currency: Currency = currencyRaw && isCurrency(currencyRaw) ? currencyRaw : 'USD';

      const quotes: SupplierQuote[] = [];
      for (const ratePlan of this.ratePlanNodes(segment)) {
        const quote = this.decodeQuote(ratePlan, currency);
        if (quote) quotes.push({ ...quote, supplierHotelId: hotelId || quote.supplierHotelId });
      }

      const summaryNode = child(segment, EL.HOTEL_SUMMARY);
      const addressNode = child(segment, EL.ADDRESS);
      const geoNode = child(segment, EL.GEO);
      const hotelName = text(segment, EL.HOTEL_NAME);
      const lowestNightly = parseMoney(summaryNode, EL.LOWEST_NIGHTLY_TOTAL, currency);
      const lowestStay = parseMoney(summaryNode, EL.LOWEST_STAY_TOTAL, currency);
      const thumbnail = text(summaryNode, EL.THUMBNAIL);
      const starRating = num(segment, EL.STAR_RATING);
      const latitude = num(geoNode, EL.LATITUDE);
      const longitude = num(geoNode, EL.LONGITUDE);
      const originalTotal = parseMoney(segment, EL.ORIGINAL_TOTAL, currency);
      const available = bool(segment, EL.AVAILABLE);

      out.push({
        hotelId,
        currency,
        quotes,
        originalTotal,
        available,
        summary: {
          id: hotelId,
          name: hotelName ?? '',
          ...(starRating !== undefined ? { starRating } : {}),
          address: {
            city: text(addressNode, EL.CITY_NAME) ?? '',
            country: text(addressNode, EL.COUNTRY_NAME) ?? '',
            countryCode: text(addressNode, EL.COUNTRY_CODE) ?? '',
            ...(text(addressNode, EL.TIME_ZONE)
              ? { timeZone: text(addressNode, EL.TIME_ZONE) }
              : {}),
          },
          ...(latitude !== undefined && longitude !== undefined
            ? { geo: { latitude, longitude } }
            : {}),
          ...(thumbnail ? { thumbnail } : {}),
          ...(lowestNightly ? { lowestNightlyTotal: lowestNightly } : {}),
          ...(lowestStay ? { lowestStayTotal: lowestStay } : {}),
        },
      });
    }
    return out;
  }

  /** RoomStays -> RoomStay -> Rates -> RatePlan, flattened. */
  private ratePlanNodes(segment: unknown): unknown[] {
    const nodes: unknown[] = [];
    for (const roomStay of children(child(segment, EL.ROOM_STAYS), EL.ROOM_STAY)) {
      for (const rates of children(roomStay, EL.RATES)) {
        nodes.push(...children(rates, EL.RATE_PLAN));
      }
    }
    return nodes;
  }

  private decodeQuote(node: unknown, fallbackCurrency: Currency): SupplierQuote | undefined {
    const offerId = text(node, EL.OFFER_ID);
    const ratePlanId = text(node, EL.RATE_PLAN_CODE);
    if (!offerId || !ratePlanId) return undefined;

    const rateNode = child(child(node, EL.RATES), EL.RATE);
    const nightlyNode = child(rateNode, EL.NIGHTLY);
    const stayNode = child(rateNode, EL.STAY);
    const currencyRaw = text(nightlyNode, EL.CURRENCY) ?? text(stayNode, EL.CURRENCY);
    const currency: Currency = currencyRaw && isCurrency(currencyRaw) ? currencyRaw : fallbackCurrency;

    const nightly = this.decodeAmounts(nightlyNode, currency);
    const stay = this.decodeAmounts(stayNode, currency);
    if (!nightly || !stay) return undefined;

    const policy = this.decodeCancellationPolicy(child(node, EL.CANCELLATION_POLICY), currency);
    const allotment = int(node, EL.AVAILABLE_ROOMS);
    const maxOccupancy = int(node, EL.MAX_OCCUPANCY);
    const bedType = text(node, EL.BED_TYPE);
    const roomTypeName = text(node, EL.ROOM_TYPE_NAME);
    const ratePlanName = text(node, EL.RATE_PLAN_DESCRIPTION);

    return {
      offerId,
      supplierHotelId: '',
      roomTypeId: text(node, EL.ROOM_TYPE_ID) ?? '',
      ratePlanId,
      roomTypeName: roomTypeName ?? '',
      ratePlanName: ratePlanName ?? '',
      ...(bedType ? { bedType } : {}),
      maxOccupancy: maxOccupancy ?? 2,
      nights: int(node, EL.NIGHTS) ?? 1,
      currency,
      nightly,
      stayTotal: stay,
      cancellationPolicy: policy ?? this.defaultPolicy(currency),
      mealPlan: toMealPlan(text(node, EL.MEAL_PLAN)),
      payAtHotel: bool(node, EL.PAY_AT_HOTEL) ?? false,
      instantConfirmation: bool(node, EL.INSTANT_CONFIRMATION) ?? false,
      ...(allotment !== undefined ? { allotment } : {}),
      taxesIncluded: bool(node, EL.TAXES_INCLUDED) ?? false,
      raw: node,
    };
  }

  private decodeAmounts(
    node: unknown,
    currency: Currency,
  ): { net: Money; taxes: Money; total: Money } | undefined {
    if (!isRecord(node)) return undefined;
    const currencyRaw = text(node, EL.CURRENCY);
    const effective: Currency = currencyRaw && isCurrency(currencyRaw) ? currencyRaw : currency;
    const total = parseMoney(node, EL.AMOUNT, effective);
    if (!total) return undefined;
    const net = parseMoney(node, EL.NET_AMOUNT, effective);
    const taxes = parseMoney(node, EL.TAX_AMOUNT, effective);
    return {
      net: net ?? money(0, effective),
      taxes: taxes ?? money(0, effective),
      total,
    };
  }

  private decodeCancellationPolicy(node: unknown, currency: Currency): CancellationPolicy | undefined {
    if (!isRecord(node)) return undefined;
    const type = toCancellationType(text(node, EL.CANCELLATION_POLICY_TYPE));
    const refundable = bool(node, EL.REFUNDABLE);
    const freeCancellationUntil = date(node, EL.FREE_CANCELLATION_UNTIL);
    const penaltyAmount = parseMoney(node, EL.PENALTY_AMOUNT, currency);
    const penaltyPercent = num(node, EL.PENALTY_PERCENT);
    const noShowPenalty = parseMoney(node, EL.NO_SHOW_PENALTY, currency);
    const description = text(node, EL.DESCRIPTION) ?? '';
    return {
      type,
      refundable: refundable ?? type === 'FULL_REFUND',
      ...(freeCancellationUntil ? { freeCancellationUntil } : {}),
      ...(penaltyAmount ? { penaltyAmount } : {}),
      ...(penaltyPercent !== undefined ? { penaltyPercent } : {}),
      ...(noShowPenalty ? { noShowPenalty } : {}),
      description,
    };
  }

  private decodeHotelNode(node: unknown): SupplierHotel | undefined {
    const id = text(node, EL.HOTEL_ID);
    if (!id) return undefined;
    const addressNode = child(node, EL.ADDRESS);
    const geoNode = child(node, EL.GEO);
    const latitude = num(geoNode, EL.LATITUDE);
    const longitude = num(geoNode, EL.LONGITUDE);
    const starRating = num(node, EL.STAR_RATING);
    const images = children(child(node, EL.IMAGES), EL.IMAGE).map((image, index) => {
      const order = int(image, ATTR.ORDER);
      const caption = text(image, EL.CAPTION);
      return { url: text(image, EL.URL) ?? '', ...(caption ? { caption } : {}), order: order ?? index + 1 };
    });
    const amenities = children(child(node, EL.AMENITIES), EL.AMENITY).map((amenity) => {
      const group = text(amenity, EL.GROUP);
      return { ...(group ? { group } : {}), name: text(amenity, EL.NAME) ?? '' };
    });
    const roomTypes = children(child(node, EL.ROOM_TYPES), EL.ROOM_TYPE).map((roomType) => {
      const roomImages = children(child(roomType, EL.IMAGES), EL.IMAGE).map((image, index) => {
        const order = int(image, ATTR.ORDER);
        const caption = text(image, EL.CAPTION);
        return { url: text(image, EL.URL) ?? '', ...(caption ? { caption } : {}), order: order ?? index + 1 };
      });
      const roomAmenities = children(child(roomType, EL.AMENITIES), EL.AMENITY).map((amenity) => {
        const group = text(amenity, EL.GROUP);
        return { ...(group ? { group } : {}), name: text(amenity, EL.NAME) ?? '' };
      });
      const bedType = text(roomType, EL.BED_TYPE);
      const sizeSqm = num(roomType, EL.SIZE_SQM);
      const description = text(roomType, EL.DESCRIPTION);
      return {
        id: text(roomType, EL.ROOM_TYPE_ID) ?? '',
        name: text(roomType, EL.ROOM_TYPE_NAME) ?? '',
        ...(description ? { description } : {}),
        maxOccupancy: int(roomType, EL.MAX_OCCUPANCY) ?? 2,
        ...(bedType ? { bedType } : {}),
        ...(sizeSqm !== undefined ? { sizeSqm } : {}),
        images: roomImages,
        amenities: roomAmenities,
      };
    });
    const checkInTime = text(node, EL.CHECK_IN_TIME);
    const checkOutTime = text(node, EL.CHECK_OUT_TIME);
    const policies = children(child(node, EL.POLICIES), EL.POLICY)
      .map((policy) => scalar(policy))
      .filter((policy): policy is string => policy !== undefined);
    const description = text(node, EL.DESCRIPTION);
    const category = text(node, EL.CATEGORY);
    const street = text(addressNode, EL.ADDRESS_LINE);
    const state = text(addressNode, EL.STATE_PROVINCE);
    const postalCode = text(addressNode, EL.POSTAL_CODE);
    const timeZone = text(addressNode, EL.TIME_ZONE);

    return {
      id,
      name: text(node, EL.HOTEL_NAME) ?? '',
      ...(starRating !== undefined ? { starRating } : {}),
      ...(category ? { category } : {}),
      ...(description ? { description } : {}),
      address: {
        ...(street ? { street } : {}),
        city: text(addressNode, EL.CITY_NAME) ?? '',
        ...(state ? { state } : {}),
        country: text(addressNode, EL.COUNTRY_NAME) ?? '',
        countryCode: text(addressNode, EL.COUNTRY_CODE) ?? '',
        ...(postalCode ? { postalCode } : {}),
        ...(timeZone ? { timeZone } : {}),
      },
      ...(latitude !== undefined && longitude !== undefined ? { geo: { latitude, longitude } } : {}),
      images,
      amenities,
      roomTypes,
      ...(checkInTime ? { checkInTime } : {}),
      ...(checkOutTime ? { checkOutTime } : {}),
      ...(policies.length > 0 ? { policies } : {}),
    };
  }

  private decodeGuests(reservation: unknown): SupplierGuest[] {
    return children(child(reservation, EL.RES_GUESTS), EL.RES_GUEST).map((guestNode) => {
      const profile = child(guestNode, EL.GUEST_PROFILE);
      const counts = child(guestNode, EL.GUEST_COUNTS);
      const adultCount = int(counts, EL.ADULT_COUNT) ?? 0;
      const age = int(counts, EL.CHILD_AGE);
      const phone = text(profile, EL.TELEPHONE);
      return {
        firstName: text(child(profile, EL.PERSON_NAME), EL.GIVEN_NAME) ?? '',
        lastName: text(child(profile, EL.PERSON_NAME), EL.SURNAME) ?? '',
        email: text(profile, EL.EMAIL) ?? '',
        ...(phone ? { phone } : {}),
        nationality: text(profile, EL.NATIONALITY) ?? '',
        isLead: adultCount > 0,
        ...(age !== undefined ? { age } : {}),
      };
    });
  }

  private firstReservation(xml: string): unknown {
    const root = rootElement(parseXml(xml));
    return children(child(root, EL.HOTEL_RESERVATIONS), EL.HOTEL_RESERVATION)[0];
  }

  private firstTimeSpan(node: unknown): { start?: LocalDate; end?: LocalDate } | undefined {
    const timeSpan = children(child(node, EL.ROOM_STAYS), EL.ROOM_STAY)
      .flatMap((roomStay) => children(child(roomStay, EL.ROOM_STAY_INDEXES), EL.ROOM_STAY_INDEX))
      .map((index) => child(index, EL.TIME_SPAN))[0];
    if (!isRecord(timeSpan)) return undefined;
    const start = attr(timeSpan, ATTR.START);
    const end = attr(timeSpan, ATTR.END);
    return {
      ...(start && isLocalDateSafe(start) ? { start } : {}),
      ...(end && isLocalDateSafe(end) ? { end } : {}),
    };
  }

  private currencyOf(node: unknown): Currency {
    const raw =
      text(child(node, EL.TOTAL), EL.CURRENCY) ?? text(child(node, EL.CANCEL_INFO), EL.CURRENCY);
    return raw && isCurrency(raw) ? raw : 'USD';
  }

  private decodeStatus(raw: string | undefined): SupplierBookingResult['status'] {
    switch ((raw ?? '').toLowerCase()) {
      case 'confirmed':
        return 'CONFIRMED';
      case 'processing':
        return 'PROCESSING';
      case 'rejected':
      case 'failed':
        return 'REJECTED';
      case 'cancelled':
      case 'canceled':
        return 'CANCELLED';
      default:
        return 'REJECTED';
    }
  }

  private encodeStatus(status: SupplierBookingResult['status']): string {
    switch (status) {
      case 'CONFIRMED':
        return VAL.STATUS_CONFIRMED;
      case 'PROCESSING':
        return VAL.STATUS_PROCESSING;
      case 'CANCELLED':
        return VAL.STATUS_CANCELLED;
      case 'REJECTED':
      default:
        return VAL.STATUS_REJECTED;
    }
  }

  private defaultPolicy(currency: Currency): CancellationPolicy {
    return {
      type: 'NON_REFUNDABLE',
      refundable: false,
      penaltyAmount: money(0, currency),
      description: 'No cancellation policy supplied by the supplier',
    };
  }

  private emptyQuote(currency: Currency): SupplierQuote {
    return {
      offerId: '',
      supplierHotelId: '',
      roomTypeId: '',
      ratePlanId: '',
      roomTypeName: '',
      ratePlanName: '',
      maxOccupancy: 0,
      nights: 0,
      currency,
      nightly: { net: money(0, currency), taxes: money(0, currency), total: money(0, currency) },
      stayTotal: { net: money(0, currency), taxes: money(0, currency), total: money(0, currency) },
      cancellationPolicy: this.defaultPolicy(currency),
      mealPlan: 'NO_BREAKFAST',
      payAtHotel: false,
      instantConfirmation: false,
      taxesIncluded: false,
    };
  }
}

interface AvailSegment {
  hotelId: string;
  currency: Currency;
  quotes: SupplierQuote[];
  originalTotal?: Money;
  available?: boolean;
  summary: SupplierHotelSummary;
}

type SupplierImageLike = SupplierHotel['images'][number];
type SupplierAmenityLike = SupplierHotel['amenities'][number];
type SupplierRoomTypeLike = SupplierHotel['roomTypes'][number];

function isLocalDateSafe(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function toCancellationType(raw: string | undefined): CancellationPolicyType {
  switch ((raw ?? '').toUpperCase()) {
    case 'FULL_REFUND':
    case 'FULLY_REFUNDABLE':
      return 'FULL_REFUND';
    case 'PARTIAL_REFUND':
    case 'PARTIALLY_REFUNDABLE':
      return 'PARTIAL_REFUND';
    case 'NON_REFUNDABLE':
    case 'NON_REFUNDABLE_RATE':
      return 'NON_REFUNDABLE';
    default:
      return 'NON_REFUNDABLE';
  }
}

function toMealPlan(raw: string | undefined): MealPlan {
  const value = (raw ?? '').toUpperCase();
  const known: MealPlan[] = [
    'NO_BREAKFAST',
    'BREAKFAST_AVAILABLE',
    'BREAKFAST_INCLUDED',
    'HALF_BOARD',
    'FULL_BOARD',
    'ALL_INCLUSIVE',
  ];
  return known.find((plan) => plan === value) ?? 'NO_BREAKFAST';
}
