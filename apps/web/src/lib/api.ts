/**
 * Typed client for the OTA API.
 *
 * The API contract is frozen (`docs/api-contract.md`); every function below
 * maps 1:1 onto a documented route and mirrors its payload exactly. All error
 * responses come back as `{ error: { code, message, retryable, details } }`
 * with a non-2xx status, so `request()` funnels everything into a single
 * `ApiError` that pages can render instead of crashing.
 *
 * The same module is used from server components and from the browser, so the
 * base URL must be `NEXT_PUBLIC_API_BASE_URL` (the API enables CORS for all
 * origins).
 */

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(init: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status ?? 0;
    this.retryable = init.retryable ?? false;
    this.details = init.details ?? {};
  }

  /** The backend could not be reached at all (API not started / wrong URL). */
  get isBackendDown(): boolean {
    return this.code === 'NETWORK_ERROR';
  }

  get isTimeout(): boolean {
    return this.code === 'TIMEOUT';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/* -------------------------------------------------------------------------- */
/* Domain types (mirrors docs/api-contract.md)                                */
/* -------------------------------------------------------------------------- */

/** Money is always integer minor units + a display `major` value. */
export interface Money {
  amount: number;
  currency: string;
  major: number;
}

export interface Address {
  street?: string | null;
  city?: string | null;
  country?: string | null;
  countryCode?: string | null;
  postalCode?: string | null;
}

export interface Geo {
  latitude: number;
  longitude: number;
}

export interface HotelSummary {
  id: string;
  supplierHotelId?: string | null;
  slug?: string | null;
  name: string;
  starRating: number;
  address?: Address | null;
  geo?: Geo | null;
  thumbnail?: string | null;
  images?: string[] | null;
  lowestNightlyTotal?: Money | null;
  lowestStayTotal?: Money | null;
  reviewScore?: number | null;
  reviewCount?: number | null;
}

export interface SearchResponse {
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  adults: number;
  currency: string;
  hotels: HotelSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HotelImage {
  url: string;
  caption?: string | null;
  position?: number | null;
}

export interface Amenity {
  group?: string | null;
  name: string;
}

export interface RoomType {
  id: string;
  supplierRoomTypeId?: string | null;
  name: string;
  description?: string | null;
  maxOccupancy?: number | null;
  bedType?: string | null;
  sizeSqm?: number | null;
  imageUrls?: string[] | null;
}

export interface HotelDetail {
  id: string;
  supplierHotelId?: string | null;
  slug?: string | null;
  name: string;
  starRating: number;
  description?: string | null;
  address?: Address | null;
  geo?: Geo | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  images?: HotelImage[] | null;
  amenities?: Amenity[] | null;
  policies?: string[] | null;
  roomTypes?: RoomType[] | null;
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
  freeCancellationUntil?: string | null;
  penaltyAmount?: Money | null;
  penaltyPercent?: number | null;
  description?: string | null;
}

export interface PriceBreakdown {
  net: Money;
  taxes: Money;
  total: Money;
}

export interface Quote {
  offerId: string;
  roomTypeId: string;
  roomTypeName: string;
  ratePlanId?: string | null;
  ratePlanName?: string | null;
  bedType?: string | null;
  maxOccupancy?: number | null;
  nights: number;
  nightly: PriceBreakdown;
  stayTotal: PriceBreakdown;
  mealPlan: MealPlan;
  payAtHotel?: boolean;
  instantConfirmation?: boolean | null;
  allotment?: number | null;
  taxesIncluded?: boolean | null;
  cancellationPolicy?: CancellationPolicy | null;
}

export interface AvailabilityResponse {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  currency: string;
  quotes: Quote[];
}

export interface PrecheckResponse {
  offerId: string;
  priceChanged: boolean;
  available: boolean;
  quote: Quote;
  total: Money;
}

export interface Guest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'BOOKING_SUBMITTED'
  | 'CONFIRMED'
  | 'CHECKED_IN'
  | 'CHECKED_OUT'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'FAILED';

export interface OrderGuest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface OrderStay {
  checkIn: string;
  checkOut: string;
  nights: number;
  rooms: number;
  adults: number;
  childAges: number[];
}

export interface OrderPrice {
  net: Money;
  taxes: Money;
  total: Money;
  paid?: Money | null;
  refunded?: Money | null;
}

export interface OrderHotel {
  id: string;
  slug?: string | null;
  name: string;
  starRating?: number | null;
  thumbnail?: string | null;
  address?: Address | null;
}

export interface OrderItem {
  offerId: string;
  roomTypeName: string;
  ratePlanName?: string | null;
  nights: number;
  nightlyTotal: Money;
  total: Money;
  mealPlan: MealPlan;
  payAtHotel?: boolean;
  cancellationPolicy?: CancellationPolicy | null;
}

export interface OrderPayment {
  status?: string | null;
  amount?: Money | null;
  provider?: string | null;
  clientSecret?: string | null;
  redirectUrl?: string | null;
}

export interface Order {
  id: string;
  orderNo: string;
  status: OrderStatus;
  supplierStatus?: 'PROCESSING' | 'CONFIRMED' | null;
  confirmationNumber?: string | null;
  hotel: OrderHotel;
  stay: OrderStay;
  guest: OrderGuest;
  price: OrderPrice;
  items: OrderItem[];
  specialRequests?: string[] | null;
  payment?: OrderPayment | null;
  refunds?: unknown[] | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  confirmedAt?: string | null;
  cancelledAt?: string | null;
}

/**
 * `POST /api/v1/bookings/:orderNo/pay` response.
 *
 * The endpoint does **not** return a flat order object any more: the payment
 * result lives in `payment` and the full order (identical to
 * `GET /api/v1/bookings/:orderNo`) lives in `booking`.
 */
export interface PayResponse {
  orderNo: string;
  status: OrderStatus;
  payment?: OrderPayment | null;
  booking?: Order;
}

export interface CancelResponse {
  booking?: Order;
  cancellation: {
    cancelled: boolean;
    penaltyAmount?: Money | null;
    refundAmount?: Money | null;
    policyType?: CancellationPolicyType | null;
  };
}

export interface HealthStatus {
  status: string;
  supplier?: string;
  supplierMode?: string;
  time?: string;
}

/* -------------------------------------------------------------------------- */
/* Query helpers                                                              */
/* -------------------------------------------------------------------------- */

export interface StayQuery {
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges?: number[];
  currency?: string;
  nationality?: string;
}

export interface SearchQuery extends StayQuery {
  destination: string;
  page?: number;
  pageSize?: number;
}

export interface PrecheckInput extends StayQuery {
  hotelId: string;
  offerId: string;
}

export interface CreateBookingInput extends StayQuery {
  hotelId: string;
  offerId: string;
  guest: Guest;
  specialRequests?: string[];
  /**
   * The price the customer explicitly accepted, in **integer minor units**
   * (e.g. cents) — never a float, never a major-unit value.
   *
   * The API rejects a booking with `409 PRICE_CHANGED` when the supplier
   * re-priced the offer; `error.details.expected` then carries the amount the
   * customer has to accept. The client re-sends the very same booking request
   * with that amount in this field and the API lets it through.
   */
  acceptedTotal?: number;
}

type QueryValue = string | number | boolean | undefined | null | number[];

function toQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised ? `?${serialised}` : '';
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

const DEFAULT_BASE_URL = 'http://localhost:3001';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-endpoint timeouts follow SPEC §4.3 (Agoda's own guidance):
 * content/search 30s, precheck 60s, booking 120s.
 */
const TIMEOUTS = {
  content: 30_000,
  search: 30_000,
  precheck: 60_000,
  booking: 120_000,
} as const;

export function apiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_BASE_URL;
  const trimmed = configured.replace(/\/+$/, '');
  if (trimmed.startsWith('/') && typeof window !== 'undefined') {
    return `${window.location.origin}${trimmed}`;
  }
  return trimmed;
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotencyKey, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const supportsTimeout =
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
  const signal = supportsTimeout ? AbortSignal.timeout(timeoutMs) : undefined;

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ApiError({
        code: 'TIMEOUT',
        message: '请求超时，请稍后重试',
        retryable: true,
      });
    }
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: '无法连接后端服务，请确认 API 已启动',
      retryable: true,
    });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = (payload as { error?: ApiErrorPayload } | null)?.error;
    throw new ApiError({
      code: errorBody?.code ?? `HTTP_${response.status}`,
      message: errorBody?.message ?? defaultMessageForStatus(response.status),
      status: response.status,
      retryable: errorBody?.retryable ?? response.status >= 500,
      details: errorBody?.details ?? {},
    });
  }

  if (payload === null) {
    throw new ApiError({
      code: 'EMPTY_RESPONSE',
      message: '后端返回了空响应，请稍后重试',
      status: response.status,
      retryable: true,
    });
  }

  return payload as T;
}

function defaultMessageForStatus(status: number): string {
  if (status === 404) return '请求的资源不存在';
  if (status === 409) return '请求与当前状态冲突，请刷新后重试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return '请求失败，请稍后重试';
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

export async function searchHotels(query: SearchQuery): Promise<SearchResponse> {
  const path = `/api/v1/hotels/search${toQuery({
    destination: query.destination,
    checkIn: query.checkIn,
    checkOut: query.checkOut,
    rooms: query.rooms,
    adults: query.adults,
    childAges: query.childAges,
    currency: query.currency,
    nationality: query.nationality,
    page: query.page,
    pageSize: query.pageSize,
  })}`;
  return request<SearchResponse>(path, { timeoutMs: TIMEOUTS.search });
}

/** `idOrSlug` — the API accepts either the local hotel id or the slug. */
export async function getHotel(idOrSlug: string): Promise<HotelDetail> {
  return request<HotelDetail>(`/api/v1/hotels/${encodeURIComponent(idOrSlug)}`, {
    timeoutMs: TIMEOUTS.content,
  });
}

export async function getAvailability(
  idOrSlug: string,
  stay: StayQuery,
): Promise<AvailabilityResponse> {
  const path = `/api/v1/hotels/${encodeURIComponent(idOrSlug)}/availability${toQuery({
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms: stay.rooms,
    adults: stay.adults,
    childAges: stay.childAges,
    currency: stay.currency,
    nationality: stay.nationality,
  })}`;
  return request<AvailabilityResponse>(path, { timeoutMs: TIMEOUTS.search });
}

/**
 * Verify the price before booking.
 *
 * The optional `idempotencyKey` is sent as the `Idempotency-Key` header: the
 * same key + same body replays the first answer instead of hitting the
 * supplier again. It must stay **stable inside one user submission** (network
 * retries reuse it) and must be **new for every new submission** (a new
 * submission has to re-verify the price).
 */
export async function precheckQuote(
  input: PrecheckInput,
  idempotencyKey?: string,
): Promise<PrecheckResponse> {
  return request<PrecheckResponse>('/api/v1/quotes/precheck', {
    method: 'POST',
    idempotencyKey,
    body: {
      hotelId: input.hotelId,
      offerId: input.offerId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      rooms: input.rooms,
      adults: input.adults,
      childAges: input.childAges ?? [],
      currency: input.currency ?? 'CNY',
      nationality: input.nationality ?? 'CN',
    },
    timeoutMs: TIMEOUTS.precheck,
  });
}

export async function createBooking(
  input: CreateBookingInput,
  idempotencyKey: string,
): Promise<Order> {
  const body: Record<string, unknown> = {
    hotelId: input.hotelId,
    offerId: input.offerId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    rooms: input.rooms,
    adults: input.adults,
    childAges: input.childAges ?? [],
    currency: input.currency ?? 'CNY',
    nationality: input.nationality ?? 'CN',
    guest: input.guest,
    specialRequests: input.specialRequests ?? [],
  };

  // Integer minor units, passed through untouched — no ×100 / ÷100 anywhere.
  if (typeof input.acceptedTotal === 'number') {
    body.acceptedTotal = input.acceptedTotal;
  }

  return request<Order>('/api/v1/bookings', {
    method: 'POST',
    idempotencyKey,
    body,
    timeoutMs: TIMEOUTS.booking,
  });
}

export async function payBooking(
  orderNo: string,
  method: string,
  idempotencyKey: string,
): Promise<PayResponse> {
  return request<PayResponse>(`/api/v1/bookings/${encodeURIComponent(orderNo)}/pay`, {
    method: 'POST',
    idempotencyKey,
    body: { method },
    timeoutMs: TIMEOUTS.booking,
  });
}

export async function getBooking(orderNo: string): Promise<Order> {
  return request<Order>(`/api/v1/bookings/${encodeURIComponent(orderNo)}`, {
    timeoutMs: TIMEOUTS.content,
  });
}

export async function cancelBooking(
  orderNo: string,
  reason: string,
  idempotencyKey: string,
): Promise<CancelResponse> {
  return request<CancelResponse>(`/api/v1/bookings/${encodeURIComponent(orderNo)}/cancel`, {
    method: 'POST',
    idempotencyKey,
    body: { reason },
    timeoutMs: TIMEOUTS.booking,
  });
}

export async function checkHealth(): Promise<HealthStatus> {
  return request<HealthStatus>('/health', { timeoutMs: 5_000 });
}
