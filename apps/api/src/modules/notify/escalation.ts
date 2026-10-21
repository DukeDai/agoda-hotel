import { isEscalated, type DeliveryStatus } from '@ota/core';
import { OUTBOX_TOPICS } from '../../lib/outbox.js';

/**
 * Auto re-report (SPEC §6.3).
 *
 * A channel that keeps failing must produce an operations-visible record —
 * an `OutboxEvent` plus an `AuditLog` row — instead of dying quietly in a
 * log file. The escalation report is delivered to the *ops* channel, never
 * back through the customer channel that failed.
 */

/** Audit action written for every escalation. */
export const ESCALATION_ACTION = 'notification.escalated';

/** Audit entity type written for every escalation. */
export const ESCALATION_ENTITY_TYPE = 'NotificationDelivery';

/** Actor recorded in the audit log for machine triggered escalations. */
export const ESCALATION_ACTOR = 'system:notify';

/**
 * True when a delivery must be reported to ops.
 *
 * `isEscalated` from core covers "still retryable but past the threshold".
 * A dead delivery is always reported, even when the max-attempts budget is
 * smaller than the escalation threshold.
 */
export function shouldEscalate(
  status: DeliveryStatus,
  attempts: number,
  threshold: number,
): boolean {
  if (status === 'DEAD') return true;
  return isEscalated(status, attempts, threshold);
}

/** The escalation topic is a report to ops — it never escalates again. */
export function isEscalationTopic(topic: string): boolean {
  return topic === OUTBOX_TOPICS.NOTIFICATION_ESCALATED;
}

/**
 * Stable dedupe key for the ops report of one delivery. The `dedupeKey` is
 * unique in the outbox, so the report is created at most once even if the
 * delivery fails again later.
 */
export function escalationDedupeKey(deliveryId: string): string {
  return `escalated:${deliveryId}`;
}
