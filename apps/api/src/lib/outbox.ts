import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Transactional outbox.
 *
 * Domain events are written in the SAME transaction as the state change, so
 * "order confirmed" and "notify the customer" cannot diverge. A background
 * worker picks the events up afterwards and delivers them.
 *
 * `dedupeKey` guarantees at-most-once semantics per logical event even if
 * the producer retries.
 */

export const OUTBOX_TOPICS = {
  BOOKING_CREATED: 'booking.created',
  BOOKING_PAID: 'booking.paid',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_PROCESSING: 'booking.processing',
  BOOKING_FAILED: 'booking.failed',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_REFUNDED: 'booking.refunded',
  PAYMENT_FAILED: 'payment.failed',
  SUPPLIER_DEGRADED: 'supplier.degraded',
  NOTIFICATION_ESCALATED: 'notification.escalated',
} as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[keyof typeof OUTBOX_TOPICS];

export interface EmitEventInput {
  topic: OutboxTopic;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  /** Unique per logical event; a second emit with the same key is a no-op. */
  dedupeKey?: string;
  availableAt?: Date;
}

export async function emitEvent(
  tx: Prisma.TransactionClient | PrismaClient,
  input: EmitEventInput,
): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      topic: input.topic,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      payload: input.payload as Prisma.InputJsonValue,
      dedupeKey: input.dedupeKey ?? null,
      availableAt: input.availableAt ?? new Date(),
    },
  });
}

/**
 * Emit without failing the whole transaction if the event already exists.
 *
 * A duplicate is NOT an error: the producer may retry. The unique
 * `dedupeKey` is the guard, and losing the race must not roll back the
 * business write that happened in the same transaction.
 */
export async function emitEventIdempotent(
  tx: Prisma.TransactionClient | PrismaClient,
  input: EmitEventInput,
): Promise<void> {
  if (!input.dedupeKey) {
    await emitEvent(tx, input);
    return;
  }
  const existing = await tx.outboxEvent.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (existing) return;
  try {
    await emitEvent(tx, input);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/** Prisma's unique-constraint error, without depending on the runtime. */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'P2002') return true;
  const message = err instanceof Error ? err.message : '';
  return message.includes('Unique constraint failed');
}
