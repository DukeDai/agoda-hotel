/**
 * ============================================================================
 * AGODA XML SCHEMA — SINGLE SOURCE OF TRUTH
 * ============================================================================
 *
 * ⚠️  READ THIS BEFORE CHANGING ANY XML ELEMENT NAME.
 *
 * The exact element / attribute names used by Agoda's Demand API are only
 * confirmed when the commercial welcome package (onboarding documents +
 * WSDL/XML samples) is handed over. Everything we know today is the OTA
 * family naming convention (`OTA_HotelAvailRQ`, `OTA_HotelResRQ`, ...).
 *
 * That is WHY this file exists: every element name, attribute name and
 * endpoint path used anywhere in this package is declared HERE and nowhere
 * else. When the welcome package arrives, correcting the integration is a
 * one-file edit in this file — no hunting through encoders and decoders.
 *
 * Rules for this file:
 *   1. No logic. Constants only.
 *   2. Every name used by an encoder/decoder must be listed here.
 *   3. When the real names are confirmed, change the VALUE, never the key,
 *      so the code keeps compiling and the diff stays reviewable.
 *
 * Scope: DEMAND side only (we pull Agoda inventory and resell it).
 * The supply side (`OTA_HotelAvailNotifRQ`, `OTA_HotelRatePlanNotifRQ`,
 * `OTA_HotelResModifyRQ`) is intentionally NOT modelled here.
 */

/** XML declaration version used on every request body we emit. */
export const XML_VERSION = '1.0';

/** Default Agoda Demand API origin (matches AGODA_BASE_URL in apps/api). */
export const DEFAULT_BASE_URL = 'https://api-connectivity.agoda.com';

/**
 * Endpoint paths. Placeholders are resolved by the live adapter.
 * ⚠️ Confirm against the welcome package.
 */
export const ENDPOINT_PATH = {
  /** Static content: hotel detail + catalogue. */
  content: '/v1/hotels/content',
  /** Multi-property availability / price search. */
  search: '/v1/hotels/availability',
  /** Re-validation of one specific offer right before booking. */
  precheck: '/v1/hotels/precheck',
  /** Create a booking. */
  booking: '/v1/bookings',
  /** Read a booking (used for the PROCESSING -> CONFIRMED poll). */
  detail: '/v1/bookings/{id}',
  /** Cancel a booking. */
  cancel: '/v1/bookings/{id}/cancel',
} as const;

/**
 * Element names.
 *
 * `EL.*` is the canonical lookup table. The grouped aliases below exist
 * only for readability at the call sites.
 */
export const EL = {
  // --- request roots ------------------------------------------------------
  AVAIL_RQ: 'OTA_HotelAvailRQ',
  RES_RQ: 'OTA_HotelResRQ',
  CANCEL_RQ: 'OTA_CancelRQ',
  CONTENT_RQ: 'OTA_HotelContentRQ',

  // --- response roots -----------------------------------------------------
  AVAIL_RS: 'OTA_HotelAvailRS',
  RES_RS: 'OTA_HotelResRS',
  CANCEL_RS: 'OTA_CancelRS',
  CONTENT_RS: 'OTA_HotelContentRS',

  // --- request: availability (search / precheck) --------------------------
  AVAIL_REQUEST_SEGMENTS: 'AvailRequestSegments',
  AVAIL_REQUEST_SEGMENT: 'AvailRequestSegment',
  HOTEL_SEARCH_CRITERIA: 'HotelSearchCriteria',
  CITY_IDS: 'CityIDs',
  CITY_ID: 'CityID',
  HOTEL_IDS: 'HotelIDs',
  HOTEL_ID: 'HotelID',
  HOTEL_NAME: 'HotelName',
  COUNTRY_CODE: 'CountryCode',
  HOTEL_STAY_REQUEST: 'HotelStayRequest',
  ROOM_STAYS: 'RoomStays',
  ROOM_STAY: 'RoomStay',
  ROOM_STAY_INDEXES: 'RoomStayIndexes',
  ROOM_STAY_INDEX: 'RoomStayIndex',
  TIME_SPAN: 'TimeSpan',
  GUEST_COUNTS: 'GuestCounts',
  ADULT_COUNT: 'AdultCount',
  CHILD_COUNT: 'ChildCount',
  CHILD_AGES: 'ChildAges',
  CHILD_AGE: 'ChildAge',
  RATE_PLANS: 'RatePlans',
  RATE_PLAN: 'RatePlan',
  RATE_PLAN_CODE: 'RatePlanCode',
  RATE_PLAN_DESCRIPTION: 'RatePlanDescription',
  ADDITIONAL_INFO: 'AdditionalInfo',
  CURRENCY: 'Currency',
  NATIONALITY: 'Nationality',
  ROOMS: 'Rooms',
  CONTEXT_FINGERPRINT: 'ContextFingerprint',
  OFFER_ID: 'OfferId',
  REQUEST_TYPE: 'RequestType',
  ALLOW_DUPLICATION: 'AllowDuplication',
  SELL_OUT_ONLY: 'SelloutOnly',

  // --- request: booking ---------------------------------------------------
  HOTEL_RESERVATIONS: 'HotelReservations',
  HOTEL_RESERVATION: 'HotelReservation',
  UNIQUE_ID: 'UniqueID',
  RES_GUESTS: 'ResGuests',
  RES_GUEST: 'ResGuest',
  GUEST_PROFILE: 'GuestProfile',
  PERSON_NAME: 'PersonName',
  GIVEN_NAME: 'GivenName',
  SURNAME: 'Surname',
  EMAIL: 'Email',
  TELEPHONE: 'Telephone',
  RES_GLOBAL_INFO: 'ResGlobalInfo',
  RES_BOOKING_TYPE: 'ResBookingType',
  SPECIAL_REQUESTS: 'SpecialRequests',
  SPECIAL_REQUEST: 'SpecialRequest',
  IDEMPOTENCY_KEY: 'IdempotencyKey',

  // --- request: cancel ----------------------------------------------------
  CANCEL_INFO: 'CancelInfo',
  CANCELLATION_TYPE: 'CancellationType',
  CANCEL_REASON: 'CancelReason',

  // --- request: content ---------------------------------------------------
  CONTENT_REQUEST: 'ContentRequest',
  PAGE: 'Page',
  PAGE_SIZE: 'PageSize',

  // --- response: availability ---------------------------------------------
  AVAIL_RESPONSE_SEGMENTS: 'AvailResponseSegments',
  AVAIL_RESPONSE_SEGMENT: 'AvailResponseSegment',
  HOTEL_SUMMARY: 'HotelSummary',
  LOWEST_NIGHTLY_TOTAL: 'LowestNightlyTotal',
  LOWEST_STAY_TOTAL: 'LowestStayTotal',
  THUMBNAIL: 'Thumbnail',
  RATES: 'Rates',
  RATE: 'Rate',
  /** Nightly amounts (one night). */
  NIGHTLY: 'Nightly',
  /** Whole-stay amounts. */
  STAY: 'Stay',
  NIGHTS: 'Nights',
  MEAL_PLAN: 'MealPlan',
  PAYMENT_TYPE: 'PaymentType',
  PAY_AT_HOTEL: 'PayAtHotel',
  INSTANT_CONFIRMATION: 'InstantConfirmation',
  TAXES_INCLUDED: 'TaxesIncluded',
  AVAILABLE_ROOMS: 'AvailableRooms',
  CHARGES: 'Charges',
  CHARGE: 'Charge',
  CHARGE_TYPE: 'ChargeType',
  INCLUDED: 'Included',
  AMOUNT: 'Amount',
  CANCELLATION_POLICY: 'CancellationPolicy',
  CANCELLATION_POLICY_TYPE: 'CancellationPolicyType',
  REFUNDABLE: 'Refundable',
  FREE_CANCELLATION_UNTIL: 'FreeCancellationUntil',
  PENALTY_AMOUNT: 'PenaltyAmount',
  PENALTY_PERCENT: 'PenaltyPercent',
  NO_SHOW_PENALTY: 'NoShowPenalty',
  DESCRIPTION: 'Description',
  NET_AMOUNT: 'NetAmount',
  TAX_AMOUNT: 'TaxAmount',
  TOTAL: 'Total',
  TOTAL_AMOUNT: 'TotalAmount',
  /**
   * ⚠️ NOT a confirmed Agoda element. We use it to detect re-pricing in the
   * precheck response (the precheck input carries no expected price).
   * Confirm at onboarding; if Agoda does not send it, the adapter simply
   * reports `priceChanged: false` and the business layer compares the price
   * it already holds.
   */
  ORIGINAL_TOTAL: 'OriginalTotal',
  /** Whether the offer is still bookable (precheck response). */
  AVAILABLE: 'Available',

  // --- response: booking --------------------------------------------------
  RES_STATUS: 'ResStatus',
  RES_CONFIRMATION: 'ResConfirmation',
  CONFIRMATION_NUMBER: 'ConfirmationNumber',
  PROCESSING: 'Processing',
  ERROR: 'Error',

  // --- response: cancel ---------------------------------------------------
  REFUND_AMOUNT: 'RefundAmount',
  PENALTY_TOTAL: 'PenaltyTotal',

  // --- response: content --------------------------------------------------
  HOTELS: 'Hotels',
  HOTEL: 'Hotel',
  STAR_RATING: 'StarRating',
  CATEGORY: 'Category',
  ADDRESS: 'Address',
  ADDRESS_LINE: 'AddressLine',
  CITY_NAME: 'CityName',
  STATE_PROVINCE: 'StateProvince',
  COUNTRY_NAME: 'CountryName',
  POSTAL_CODE: 'PostalCode',
  /**
   * IANA timezone of the property.
   *
   * The element name follows Agoda's convention for the other address
   * fields. If the welcome package uses a different name, this is the ONE
   * line to change — see SPEC §4.9.
   */
  TIME_ZONE: 'TimeZone',
  GEO: 'Geo',
  LATITUDE: 'Latitude',
  LONGITUDE: 'Longitude',
  IMAGES: 'Images',
  IMAGE: 'Image',
  URL: 'URL',
  CAPTION: 'Caption',
  AMENITIES: 'Amenities',
  AMENITY: 'Amenity',
  GROUP: 'Group',
  NAME: 'Name',
  ROOM_TYPES: 'RoomTypes',
  ROOM_TYPE: 'RoomType',
  ROOM_TYPE_ID: 'RoomTypeID',
  ROOM_TYPE_NAME: 'RoomTypeName',
  MAX_OCCUPANCY: 'MaxOccupancy',
  BED_TYPE: 'BedType',
  SIZE_SQM: 'SizeSqm',
  CHECK_IN_TIME: 'CheckInTime',
  CHECK_OUT_TIME: 'CheckOutTime',
  POLICIES: 'Policies',
  POLICY: 'Policy',
} as const;

/** Attribute names. */
export const ATTR = {
  /** TimeSpan Start / End — stay dates (YYYY-MM-DD). */
  START: 'Start',
  END: 'End',
  /** UniqueID Id / CompanyName. */
  ID: 'Id',
  COMPANY_NAME: 'CompanyName',
  /** Image Order. */
  ORDER: 'Order',
  /** Error Code. */
  CODE: 'Code',
  /** XML attributes. */
  IDENTITY: 'Identity',
} as const;

/** HTTP headers used by the live adapter. */
export const HEADER = {
  API_KEY: 'X-Api-Key',
  CONTENT_TYPE: 'Content-Type',
  ACCEPT: 'Accept',
  CONTENT_LANGUAGE: 'Accept-Language',
  CORRELATION_ID: 'X-Correlation-Id',
} as const;

/** Values used inside the XML body. */
export const VAL = {
  /** RequestType discriminator (search vs precheck). */
  REQUEST_TYPE_SEARCH: 'Search',
  REQUEST_TYPE_PRECHECK: 'Precheck',
  /** ResStatus values as they appear on the wire. */
  STATUS_CONFIRMED: 'Confirmed',
  STATUS_PROCESSING: 'Processing',
  STATUS_REJECTED: 'Rejected',
  STATUS_CANCELLED: 'Cancelled',
  /** ResBookingType. */
  BOOKING_TYPE_NEW: 'New',
  /** CompanyName used on UniqueID. */
  COMPANY_NAME: 'Agoda',
} as const;

/** Supplier error codes we understand. */
export const SUPPLIER_ERROR_CODE = {
  ROOM_UNAVAILABLE: 'ROOM_UNAVAILABLE',
  PRICE_CHANGED: 'PRICE_CHANGED',
  BOOKING_REJECTED: 'BOOKING_REJECTED',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
} as const;
