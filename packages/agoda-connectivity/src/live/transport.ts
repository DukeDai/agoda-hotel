import { AppError, CircuitBreaker, backoffDelay, sleep } from '@ota/core';
import type { Logger } from '@ota/core';
import type { SupplierEndpoint } from '../contract.js';
import { HEADER } from '../xml/schema.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

/**
 * The HTTP transport towards the Agoda Demand API.
 *
 * Responsibilities (and ONLY these — the adapter stays business focused):
 *   - one timeout PER ENDPOINT (Agoda's guidance: 30s general, 60s
 *     precheck, 120s booking — never one global value);
 *   - a client side quota limiter (429 before it happens);
 *   - a circuit breaker (fail fast while Agoda is down instead of burning
 *     the customer's latency);
 *   - retry with exponential backoff + jitter for SAFE calls only;
 *   - mapping every upstream failure to an `AppError` code.
 *
 * The BOOKING call is explicitly NOT retried here. A blind retry of a
 * booking POST can create a second reservation at Agoda while the first one
 * actually succeeded — a double booking we would have to pay for. The
 * business layer owns that decision, because only it knows the idempotency
 * key and whether a retry is safe.
 */

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface LiveTransportOptions {
  baseUrl: string;
  apiKey: string;
  username: string;
  password: string;
  contentLanguage?: string;
  timeouts: Record<SupplierEndpoint, number>;
  maxRetries: number;
  rateLimiter: TokenBucketRateLimiter;
  circuitBreaker: CircuitBreaker;
  logger: Logger;
  fetchImpl?: FetchLike;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  correlationIdFactory?: () => string;
}

export interface UpstreamRequest {
  endpoint: SupplierEndpoint;
  path: string;
  method: 'GET' | 'POST';
  body?: string;
  /**
   * Whether the transport may retry this call.
   * FALSE for the booking call: a blind retry can double-book.
   */
  retryable: boolean;
  correlationId?: string;
}

export interface UpstreamResponse {
  status: number;
  body: string;
  durationMs: number;
  attempts: number;
  correlationId: string;
}

/** Business error codes Agoda may report in the body. */
const BUSINESS_ERROR_CODES: Record<string, 'ROOM_UNAVAILABLE' | 'PRICE_CHANGED' | 'BOOKING_REJECTED' | 'DUPLICATE_BOOKING'> = {
  ROOM_UNAVAILABLE: 'ROOM_UNAVAILABLE',
  SOLD_OUT: 'ROOM_UNAVAILABLE',
  PRICE_CHANGED: 'PRICE_CHANGED',
  BOOKING_REJECTED: 'BOOKING_REJECTED',
  DUPLICATE_BOOKING: 'DUPLICATE_BOOKING',
  DUPLICATE: 'DUPLICATE_BOOKING',
};

export class AgodaLiveTransport {
  private readonly options: LiveTransportOptions;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;

  constructor(options: LiveTransportOptions) {
    this.options = options;
    this.logger = options.logger;
    this.fetchImpl =
      options.fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
  }

  /** Perform one upstream call, with quota, circuit breaker and retry. */
  async send(request: UpstreamRequest): Promise<UpstreamResponse> {
    this.options.rateLimiter.acquire(request.endpoint);
    return this.options.circuitBreaker.execute(() => this.attempt(request));
  }

  private async attempt(request: UpstreamRequest): Promise<UpstreamResponse> {
    const correlationId = request.correlationId ?? this.options.correlationIdFactory?.() ?? 'agoda-unknown';
    // A non retryable call gets exactly ONE attempt. This is the whole
    // point of the `retryable` flag for the booking endpoint.
    const maxAttempts = request.retryable ? this.options.maxRetries + 1 : 1;
    const timeoutMs = this.options.timeouts[request.endpoint];
    let lastError: AppError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        const response = await this.fetchOnce(request, timeoutMs, correlationId);
        const durationMs = Date.now() - started;
        if (response.status >= 200 && response.status < 300) {
          this.logger.info('agoda.upstream.ok', {
            endpoint: request.endpoint,
            method: request.method,
            path: request.path,
            status: response.status,
            durationMs,
            attempts: attempt,
            correlationId,
          });
          return { ...response, durationMs, attempts: attempt, correlationId };
        }
        lastError = this.mapHttpError(request, response, correlationId);
      } catch (error) {
        lastError = this.normalizeError(error, request, correlationId);
      }

      const canRetry = attempt < maxAttempts && (lastError?.retryable ?? false);
      if (!canRetry) {
        throw lastError ?? new AppError('SUPPLIER_ERROR', 'Agoda call failed');
      }
      const delay = backoffDelay(
        attempt,
        this.options.retryBaseDelayMs ?? 300,
        this.options.retryMaxDelayMs ?? 5_000,
      );
      this.logger.warn('agoda.upstream.retry', {
        endpoint: request.endpoint,
        attempt,
        delayMs: delay,
        code: lastError?.code,
        correlationId,
      });
      await sleep(delay);
    }

    throw lastError ?? new AppError('SUPPLIER_ERROR', 'Agoda call failed');
  }

  private async fetchOnce(
    request: UpstreamRequest,
    timeoutMs: number,
    correlationId: string,
  ): Promise<{ status: number; body: string }> {
    const controller = new AbortController();
    // The AbortSignal guarantees a hung upstream connection can never pin
    // the process: the request is torn down when the endpoint budget is
    // exhausted.
    const timer = setTimeout(() => {
      controller.abort(new Error(`Agoda ${request.endpoint} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    try {
      const response = await this.fetchImpl(this.url(request.path), {
        method: request.method,
        headers: this.headers(request.endpoint, correlationId),
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
      });
      const body = await response.text();
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(endpoint: SupplierEndpoint, correlationId: string): Record<string, string> {
    const basic = Buffer.from(`${this.options.username}:${this.options.password}`).toString('base64');
    return {
      [HEADER.CONTENT_TYPE]: 'text/xml; charset=utf-8',
      [HEADER.ACCEPT]: 'text/xml',
      [HEADER.API_KEY]: this.options.apiKey,
      [HEADER.CORRELATION_ID]: correlationId,
      ...(this.options.contentLanguage ? { [HEADER.CONTENT_LANGUAGE]: this.options.contentLanguage } : {}),
      // The basic credentials are never logged: only the header NAME is.
      authorization: `Basic ${basic}`,
    };
  }

  private url(path: string): string {
    const base = this.options.baseUrl.replace(/\/+$/, '');
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private normalizeError(error: unknown, request: UpstreamRequest, correlationId: string): AppError {
    if (AppError.is(error)) return error;
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'AbortError' || /aborted|timeout/i.test(message)) {
      this.logger.error('agoda.upstream.timeout', {
        endpoint: request.endpoint,
        correlationId,
        message,
      });
      return new AppError('SUPPLIER_TIMEOUT', `Agoda ${request.endpoint} timed out`, {
        details: { endpoint: request.endpoint, correlationId },
        cause: error,
      });
    }
    this.logger.error('agoda.upstream.network_error', {
      endpoint: request.endpoint,
      correlationId,
      message,
    });
    return new AppError('SUPPLIER_ERROR', `Agoda ${request.endpoint} failed: ${message}`, {
      details: { endpoint: request.endpoint, correlationId },
      cause: error,
    });
  }

  private mapHttpError(
    request: UpstreamRequest,
    response: { status: number; body: string },
    correlationId: string,
  ): AppError {
    const business = this.extractBusinessCode(response.body);
    this.logger.error('agoda.upstream.error', {
      endpoint: request.endpoint,
      status: response.status,
      correlationId,
      code: business ?? response.status,
    });

    if (business) {
      return new AppError(business, `Agoda rejected the ${request.endpoint} call (${business})`, {
        details: { endpoint: request.endpoint, status: response.status, supplierCode: business, correlationId },
        retryable: false,
      });
    }

    const status = response.status;
    if (status === 401 || status === 403) {
      return new AppError('SUPPLIER_AUTH_ERROR', 'Agoda rejected our credentials', {
        details: { endpoint: request.endpoint, status, correlationId },
      });
    }
    if (status === 429) {
      return new AppError('SUPPLIER_RATE_LIMITED', 'Agoda throttled us (429)', {
        details: { endpoint: request.endpoint, status, correlationId },
      });
    }
    if (status === 408 || status === 504) {
      return new AppError('SUPPLIER_TIMEOUT', `Agoda ${request.endpoint} timed out (${status})`, {
        details: { endpoint: request.endpoint, status, correlationId },
      });
    }
    if (status === 404) {
      return new AppError('NOT_FOUND', `Agoda has no resource for ${request.path}`, {
        details: { endpoint: request.endpoint, status, correlationId },
      });
    }
    if (status >= 500) {
      return new AppError('SUPPLIER_ERROR', `Agoda ${request.endpoint} failed (${status})`, {
        details: { endpoint: request.endpoint, status, correlationId },
      });
    }
    return new AppError('SUPPLIER_ERROR', `Agoda ${request.endpoint} failed (${status})`, {
      details: { endpoint: request.endpoint, status, correlationId },
      retryable: false,
    });
  }

  /** Look for a business error code inside the XML body. */
  private extractBusinessCode(body: string): 'ROOM_UNAVAILABLE' | 'PRICE_CHANGED' | 'BOOKING_REJECTED' | 'DUPLICATE_BOOKING' | undefined {
    if (!body) return undefined;
    for (const [needle, code] of Object.entries(BUSINESS_ERROR_CODES)) {
      if (body.includes(needle)) return code;
    }
    return undefined;
  }
}
