import type { LocalDate, Money } from '@ota/core';
import type { SupplierBookingInput, SupplierBookingStatus, SupplierQuote } from '../contract.js';

/**
 * The mock's internal booking ledger.
 *
 * The real Agoda keeps the reservation on its side; the mock has to keep it
 * somewhere, otherwise `getBooking()` and `cancel()` would have nothing to
 * find. The ledger also models the two rules that make the real API
 * surprising:
 *   - a booking that is still PROCESSING keeps returning PROCESSING for a
 *     while before it converges to CONFIRMED;
 *   - a second booking for the same lead guest, same hotel and overlapping
 *     dates is rejected as a duplicate, even though we send
 *     `allowDuplication: true`.
 */

export interface LedgerEntry {
  supplierBookingId: string;
  idempotencyKey: string;
  hotelId: string;
  offerId: string;
  quote: SupplierQuote;
  input: SupplierBookingInput;
  status: SupplierBookingStatus;
  processing: boolean;
  /** How many more polls must report PROCESSING before we converge. */
  pollsRemaining: number;
  confirmationNumber?: string;
  cancelled: boolean;
  penaltyAmount?: Money;
  refundAmount?: Money;
  /** Normalised lead guest name, used for the duplicate rule. */
  leadGuestName: string;
  createdAt: number;
}

export class BookingLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly byIdempotencyKey = new Map<string, string>();

  create(entry: LedgerEntry): LedgerEntry {
    this.entries.set(entry.supplierBookingId, entry);
    this.byIdempotencyKey.set(entry.idempotencyKey, entry.supplierBookingId);
    return entry;
  }

  get(supplierBookingId: string): LedgerEntry | undefined {
    return this.entries.get(supplierBookingId);
  }

  findByIdempotencyKey(idempotencyKey: string): LedgerEntry | undefined {
    const id = this.byIdempotencyKey.get(idempotencyKey);
    return id ? this.entries.get(id) : undefined;
  }

  /**
   * A previous booking for the same lead guest, same hotel and overlapping
   * stay dates. Cancelled bookings do not block a new one.
   */
  findDuplicate(
    hotelId: string,
    leadGuestName: string,
    checkIn: LocalDate,
    checkOut: LocalDate,
  ): LedgerEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.cancelled) continue;
      if (entry.hotelId !== hotelId) continue;
      if (entry.leadGuestName !== leadGuestName) continue;
      if (!overlaps(entry.input.checkIn, entry.input.checkOut, checkIn, checkOut)) continue;
      return entry;
    }
    return undefined;
  }

  all(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Half-open date overlap: [aStart, aEnd) intersects [bStart, bEnd). */
export function overlaps(aStart: LocalDate, aEnd: LocalDate, bStart: LocalDate, bEnd: LocalDate): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Normalise a guest name for comparison: case and spacing insensitive. */
export function normalizeGuestName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim().replace(/\s+/g, ' ').toLowerCase();
}
