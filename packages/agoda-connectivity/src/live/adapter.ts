import { AppError, CircuitBreaker, createConsoleLogger, newId } from '@ota/core';
import type { Logger } from '@ota/core';
import type {
  SupplierAdapter,
  SupplierAdapterConfig,
  SupplierBookingDetail,
  SupplierBookingInput,
  SupplierBookingResult,
  SupplierCancelInput,
  SupplierCancelResult,
  SupplierDestination,
  SupplierEndpoint,
  SupplierHotel,
  SupplierHotelAvailability,
  SupplierPrecheckInput,
  SupplierPrecheckResult,
  SupplierSearchQuery,
  SupplierSearchResult,
} from '../contract.js';
import { AgodaXmlCodec } from '../xml/codec.js';
import { DEFAULT_BASE_URL, ENDPOINT_PATH } from '../xml/schema.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { AgodaLiveTransport } from './transport.js';
import type { FetchLike } from './transport.js';

/**
 * The live Agoda Demand API adapter.
 *
 * DEMAND side only: we pull Agoda's inventory and resell it. The supply
 * side (`OTA_HotelAvailNotifRQ` and friends) is out of scope.
 *
 * Design notes:
 *  - one timeout per endpoint (30s / 60s precheck / 120s booking);
 *  - the booking call is NEVER retried by the transport (double booking);
 *  - every upstream failure is mapped to an `AppError` code the business
 *    layer knows how to handle;
 *  - guest email / phone are never logged.
 */

export interface AgodaLiveAdapterOptions {
  config: SupplierAdapterConfig;
  logger?: Logger;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  circuitBreaker?: CircuitBreaker;
  rateLimiter?: TokenBucketRateLimiter;
  retryBaseDelayMs?: number;
  correlationIdFactory?: () => string;
}

/**
 * Per endpoint timeouts, in milliseconds.
 * Agoda's guidance: 30s for the general calls, 60s for Precheck, 120s for
 * Booking. They are NOT uniform and must never be collapsed into one.
 */
export const DEFAULT_TIMEOUTS: Readonly<Record<SupplierEndpoint, number>> = {
  content: 30_000,
  search: 30_000,
  precheck: 60_000,
  booking: 120_000,
  detail: 30_000,
  cancel: 30_000,
};

export class AgodaLiveAdapter implements SupplierAdapter {
  readonly name = 'agoda';
  readonly mode = 'live' as const;

  /** The effective per endpoint timeouts, in ms. */
  readonly timeouts: Readonly<Record<SupplierEndpoint, number>>;

  private readonly codec = new AgodaXmlCodec();
  private readonly config: SupplierAdapterConfig;
  private readonly logger: Logger;
  private readonly transport: AgodaLiveTransport;

  constructor(options: AgodaLiveAdapterOptions | SupplierAdapterConfig) {
    const opts: AgodaLiveAdapterOptions = isAdapterConfig(options) ? { config: options } : options;
    const config = opts.config;

    // Credentials are issued by Agoda after the commercial approval. Missing
    // credentials are a CONFIGURATION problem, not a runtime hiccup: we
    // fail fast, loudly, and never at import time.
    const apiKey = config.apiKey?.trim() ?? '';
    const username = config.username?.trim() ?? '';
    const password = config.password ?? '';
    if (!apiKey || !username || !password) {
      const missing = [
        ...(apiKey ? [] : ['apiKey']),
        ...(username ? [] : ['username']),
        ...(password ? [] : ['password']),
      ];
      throw new AppError(
        'CONFIG_ERROR',
        `Agoda live credentials are missing (${missing.join(', ')}). They are issued by Agoda after the commercial approval; use mode "mock" until then.`,
        { details: { missing } },
      );
    }

    this.config = config;
    this.logger = opts.logger ?? createConsoleLogger({ name: 'agoda-live', level: 'info' });
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(config.timeouts ?? {}) };

    const rateLimiter =
      opts.rateLimiter ??
      new TokenBucketRateLimiter({
        rpm: config.rateLimitRpm,
        burst: config.rateLimitBurst,
      });
    const circuitBreaker =
      opts.circuitBreaker ??
      new CircuitBreaker({
        failureThreshold: 5,
        openMs: 30_000,
        onStateChange: (from, to) => {
          this.logger.warn('agoda.circuit_breaker', { from, to });
        },
      });

    this.transport = new AgodaLiveTransport({
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      apiKey,
      username,
      password,
      ...(config.contentLanguage ? { contentLanguage: config.contentLanguage } : {}),
      timeouts: { ...this.timeouts },
      maxRetries: config.maxRetries ?? 3,
      rateLimiter,
      circuitBreaker,
      logger: this.logger,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.retryBaseDelayMs !== undefined ? { retryBaseDelayMs: opts.retryBaseDelayMs } : {}),
      ...(opts.correlationIdFactory ? { correlationIdFactory: opts.correlationIdFactory } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Static content
  // ---------------------------------------------------------------------------

  async getHotel(supplierHotelId: string): Promise<SupplierHotel> {
    const xml = await this.call('content', ENDPOINT_PATH.content, 'POST', this.codec.encodeHotelContentRequest({ hotelIds: [supplierHotelId] }));
    const hotels = this.codec.decodeHotelListResponse(xml);
    const hotel =
      hotels.find((candidate) => candidate.id === supplierHotelId) ??
      (hotels.length === 1 && !hotels[0]?.id ? hotels[0] : undefined);
    if (!hotel) {
      throw new AppError('HOTEL_NOT_FOUND', `Agoda has no hotel ${supplierHotelId}`, {
        details: { supplierHotelId },
      });
    }
    return hotel;
  }

  async listHotels(params: {
    destination?: SupplierDestination;
    page?: number;
    pageSize?: number;
  } = {}): Promise<SupplierHotel[]> {
    const xml = await this.call(
      'content',
      ENDPOINT_PATH.content,
      'POST',
      this.codec.encodeHotelContentRequest({
        ...(params.destination ? { destination: params.destination } : {}),
        ...(params.page !== undefined ? { page: params.page } : {}),
        ...(params.pageSize !== undefined ? { pageSize: params.pageSize } : {}),
      }),
    );
    return this.codec.decodeHotelListResponse(xml);
  }

  // ---------------------------------------------------------------------------
  // Search & availability
  // ---------------------------------------------------------------------------

  async searchHotels(query: SupplierSearchQuery): Promise<SupplierSearchResult> {
    const xml = await this.call('search', ENDPOINT_PATH.search, 'POST', this.codec.encodeSearchRequest(query));
    return this.codec.decodeSearchResponse(xml);
  }

  async getAvailability(
    query: SupplierSearchQuery & { hotelIds: string[] },
  ): Promise<SupplierHotelAvailability[]> {
    const xml = await this.call(
      'search',
      ENDPOINT_PATH.search,
      'POST',
      this.codec.encodeSearchRequest(query, query.hotelIds),
    );
    return this.codec.decodeAvailabilityResponse(xml);
  }

  // ---------------------------------------------------------------------------
  // Booking lifecycle
  // ---------------------------------------------------------------------------

  async precheck(input: SupplierPrecheckInput): Promise<SupplierPrecheckResult> {
    const xml = await this.call('precheck', ENDPOINT_PATH.precheck, 'POST', this.codec.encodePrecheckRequest(input));
    const result = this.codec.decodePrecheckResponse(xml, input.currency);
    if (!result.available) {
      throw new AppError('ROOM_UNAVAILABLE', `Offer ${input.offerId} is no longer available`, {
        details: { offerId: input.offerId, supplierHotelId: input.supplierHotelId },
      });
    }
    return result;
  }

  /**
   * Create the booking.
   *
   * NOTE: this call is NOT retried by the transport. A retried booking POST
   * can create a SECOND reservation at Agoda while the first one actually
   * succeeded — a double booking we would pay for and the customer would
   * not. If this call fails, the business layer decides what to do with the
   * idempotency key (it can safely replay the booking).
   */
  async book(input: SupplierBookingInput): Promise<SupplierBookingResult> {
    const xml = await this.call(
      'booking',
      ENDPOINT_PATH.booking,
      'POST',
      this.codec.encodeBookingRequest(input),
      { retryable: false },
    );
    const result = this.codec.decodeBookingResponse(xml);

    if (result.status === 'REJECTED') {
      throw new AppError('BOOKING_REJECTED', result.errorMessage ?? 'Agoda rejected the booking', {
        details: {
          supplierCode: result.errorCode ?? 'BOOKING_REJECTED',
          supplierBookingId: result.supplierBookingId,
        },
      });
    }

    if (!result.supplierBookingId) {
      // 2xx but nothing we can use: the body is not what we expect.
      throw new AppError('SUPPLIER_ERROR', 'Agoda returned an unreadable booking response', {
        details: { endpoint: 'booking' },
      });
    }

    if (
      result.total &&
      input.expectedTotal &&
      (result.total.amount !== input.expectedTotal.amount ||
        result.total.currency !== input.expectedTotal.currency)
    ) {
      throw new AppError(
        'PRICE_CHANGED',
        `Agoda re-priced the booking: expected ${input.expectedTotal.amount} ${input.expectedTotal.currency}, got ${result.total.amount} ${result.total.currency}`,
        {
          details: {
            expected: { amount: input.expectedTotal.amount, currency: input.expectedTotal.currency },
            actual: { amount: result.total.amount, currency: result.total.currency },
          },
        },
      );
    }

    return result;
  }

  async getBooking(supplierBookingId: string): Promise<SupplierBookingDetail> {
    const path = ENDPOINT_PATH.detail.replace('{id}', encodeURIComponent(supplierBookingId));
    const xml = await this.call('detail', path, 'GET');
    const detail = this.codec.decodeBookingDetailResponse(xml);
    if (!detail.supplierBookingId) {
      throw new AppError('SUPPLIER_ERROR', 'Agoda returned an unreadable booking detail response', {
        details: { endpoint: 'detail', supplierBookingId },
      });
    }
    return detail;
  }

  async cancel(input: SupplierCancelInput): Promise<SupplierCancelResult> {
    const path = ENDPOINT_PATH.cancel.replace('{id}', encodeURIComponent(input.supplierBookingId));
    // A cancel carries an idempotency key, so replaying it is safe.
    const xml = await this.call('cancel', path, 'POST', this.codec.encodeCancelRequest(input));
    const result = this.codec.decodeCancelResponse(xml);
    if (!result.supplierBookingId) {
      throw new AppError('SUPPLIER_ERROR', 'Agoda returned an unreadable cancellation response', {
        details: { endpoint: 'cancel', supplierBookingId: input.supplierBookingId },
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async call(
    endpoint: SupplierEndpoint,
    path: string,
    method: 'GET' | 'POST',
    body?: string,
    options: { retryable?: boolean } = {},
  ): Promise<string> {
    const response = await this.transport.send({
      endpoint,
      path,
      method,
      ...(body !== undefined ? { body } : {}),
      retryable: options.retryable ?? true,
      correlationId: this.correlationId(),
    });
    return response.body;
  }

  private correlationId(): string {
    return `ag-${newId().toLowerCase()}`;
  }
}

function isAdapterConfig(value: AgodaLiveAdapterOptions | SupplierAdapterConfig): value is SupplierAdapterConfig {
  return 'mode' in value;
}
