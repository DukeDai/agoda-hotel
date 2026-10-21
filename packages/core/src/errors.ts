/**
 * One error taxonomy for the whole system.
 *
 * Every error carries a stable machine-readable `code`. HTTP status is a
 * transport concern; `retryable` tells the caller whether another attempt
 * could plausibly succeed. Downstream code (auto-retry, auto re-report,
 * notification routing) keys off `code` and `retryable`, never off messages.
 */

export type AppErrorCode =
  // --- input / contract ---
  | 'VALIDATION_ERROR'
  | 'CONFIG_ERROR'
  | 'IDEMPOTENCY_CONFLICT'
  // --- catalog ---
  | 'HOTEL_NOT_FOUND'
  | 'ROOM_NOT_FOUND'
  | 'RATE_PLAN_NOT_FOUND'
  // --- supplier / inventory ---
  | 'ROOM_UNAVAILABLE'
  | 'PRICE_CHANGED'
  | 'SUPPLIER_TIMEOUT'
  | 'SUPPLIER_RATE_LIMITED'
  | 'SUPPLIER_ERROR'
  | 'SUPPLIER_AUTH_ERROR'
  | 'DUPLICATE_BOOKING'
  | 'BOOKING_REJECTED'
  // --- booking lifecycle ---
  | 'INVALID_STATE'
  | 'BOOKING_NOT_CONFIRMED'
  | 'CANCEL_NOT_ALLOWED'
  // --- payment ---
  | 'PAYMENT_FAILED'
  | 'PAYMENT_PENDING'
  | 'REFUND_FAILED'
  // --- infra ---
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

const DEFAULT_STATUS: Record<AppErrorCode, number> = {
  VALIDATION_ERROR: 400,
  CONFIG_ERROR: 500,
  IDEMPOTENCY_CONFLICT: 409,
  HOTEL_NOT_FOUND: 404,
  ROOM_NOT_FOUND: 404,
  RATE_PLAN_NOT_FOUND: 404,
  ROOM_UNAVAILABLE: 409,
  PRICE_CHANGED: 409,
  SUPPLIER_TIMEOUT: 504,
  SUPPLIER_RATE_LIMITED: 429,
  SUPPLIER_ERROR: 502,
  SUPPLIER_AUTH_ERROR: 502,
  DUPLICATE_BOOKING: 409,
  BOOKING_REJECTED: 409,
  INVALID_STATE: 409,
  BOOKING_NOT_CONFIRMED: 409,
  CANCEL_NOT_ALLOWED: 409,
  PAYMENT_FAILED: 402,
  PAYMENT_PENDING: 202,
  REFUND_FAILED: 500,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};

const DEFAULT_RETRYABLE: Record<AppErrorCode, boolean> = {
  VALIDATION_ERROR: false,
  CONFIG_ERROR: false,
  IDEMPOTENCY_CONFLICT: false,
  HOTEL_NOT_FOUND: false,
  ROOM_NOT_FOUND: false,
  RATE_PLAN_NOT_FOUND: false,
  ROOM_UNAVAILABLE: false,
  PRICE_CHANGED: false,
  SUPPLIER_TIMEOUT: true,
  SUPPLIER_RATE_LIMITED: true,
  SUPPLIER_ERROR: true,
  SUPPLIER_AUTH_ERROR: false,
  DUPLICATE_BOOKING: false,
  BOOKING_REJECTED: false,
  INVALID_STATE: false,
  BOOKING_NOT_CONFIRMED: false,
  CANCEL_NOT_ALLOWED: false,
  PAYMENT_FAILED: false,
  PAYMENT_PENDING: false,
  REFUND_FAILED: true,
  NOT_FOUND: false,
  CONFLICT: false,
  INTERNAL_ERROR: true,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
    this.details = options.details ?? {};
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        details: this.details,
      },
    };
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

/** Normalise any thrown value into an AppError. */
export function toAppError(err: unknown): AppError {
  if (AppError.is(err)) return err;
  if (err instanceof Error) {
    return new AppError('INTERNAL_ERROR', err.message, { cause: err });
  }
  return new AppError('INTERNAL_ERROR', describeUnknown(err));
}

/**
 * Describe a value that is not an Error.
 *
 * `String(value)` throws for objects without a prototype (`Object.create(null)`),
 * and an error normaliser that itself throws is the worst possible place to
 * fail — the caller would lose the original failure entirely.
 */
function describeUnknown(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '未知错误';
    }
  }
}

export function validationError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('VALIDATION_ERROR', message, { details });
}
