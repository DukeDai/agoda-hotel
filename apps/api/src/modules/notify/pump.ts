import type { DeliveryStatus } from '@ota/core';
import type { AppContext } from '../../lib/context.js';
import { OUTBOX_TOPICS, emitEventIdempotent } from '../../lib/outbox.js';
import { nextAttemptAt } from './backoff.js';
import {
  OPS_LOG_DESTINATION,
  createEmailChannel,
  createOpsChannel,
  createSmsChannel,
  createWebhookChannel,
  resolveCustomerChannels,
} from './channels.js';
import {
  ESCALATION_ACTION,
  ESCALATION_ACTOR,
  ESCALATION_ENTITY_TYPE,
  escalationDedupeKey,
  isEscalationTopic,
  shouldEscalate,
} from './escalation.js';
import { extractNotificationData } from './message.js';
import type {
  ChannelName,
  NotifyChannel,
  NotificationTarget,
  OutboxEventPayload,
} from './types.js';

/**
 * The outbox pump.
 *
 * One cycle:
 *  1. requeue events whose lease expired (a crashed worker left them behind),
 *  2. claim pending events oldest first, one conditional update per event so
 *     two API instances never process the same event,
 *  3. create the missing delivery rows (one per channel / webhook endpoint),
 *  4. deliver every channel independently — one broken channel never blocks
 *     another,
 *  5. requeue, settle or dead-letter the event depending on its deliveries,
 *  6. escalate exhausted channels to ops (auto re-report, SPEC §6.3).
 */

/** How many events one cycle takes off the table. */
export const OUTBOX_BATCH_SIZE = 50;

/** How long a claimed event may stay PROCESSING before it is requeued. */
export const OUTBOX_LEASE_MS = 5 * 60 * 1000;

/**
 * How long a claimed delivery is protected from a second worker. It only has
 * to outlive one send (the webhook timeout is 10s).
 */
export const DELIVERY_LEASE_MS = 60_000;

export type OutboxPumpResult = {
  /** Events whose deliveries all ended up SENT. */
  processed: number;
  /** Events that still need work, are dead, or blew up. */
  failed: number;
};

export type OutboxPumpOptions = {
  /**
   * Test seam: replace the channel implementations. The default registry is
   * built from the application context.
   */
  channels?: Map<ChannelName, NotifyChannel>;
};

type OutboxEventRow = {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  status: string;
  attempts: number;
  availableAt: Date;
  lastError: string | null;
};

type DeliveryRow = {
  id: string;
  outboxId: string;
  channel: string;
  destination: string;
  status: string;
  attempts: number;
  lastError: string | null;
  escalatedAt: Date | null;
  sentAt: Date | null;
  nextAttemptAt: Date;
};

type ResolvedTarget = {
  channel: ChannelName;
  destination: string;
  endpoint?: { id: string; url: string; secret: string };
};

type AttemptOutcome = 'sent' | 'failed' | 'dead';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function earlier(current: Date | null, candidate: Date): Date {
  if (current === null) return candidate;
  return candidate.getTime() < current.getTime() ? candidate : current;
}

/** Prisma's unique constraint violation, duck typed to avoid a runtime import. */
function isUniqueViolation(err: unknown): boolean {
  return isRecord(err) && err.code === 'P2002';
}

/** Process one batch of pending outbox events. */
export async function processOutboxOnce(
  ctx: AppContext,
  options: OutboxPumpOptions = {},
): Promise<OutboxPumpResult> {
  const now = ctx.now();

  // A worker that died mid-event leaves the event PROCESSING. The lease in
  // `availableAt` tells us when that can happen; requeue it.
  await ctx.prisma.outboxEvent.updateMany({
    where: { status: 'PROCESSING', availableAt: { lte: now } },
    data: { status: 'PENDING', availableAt: now, lastError: 'delivery lease expired; requeued' },
  });

  const candidates = await ctx.prisma.outboxEvent.findMany({
    where: { status: 'PENDING', availableAt: { lte: now } },
    orderBy: { availableAt: 'asc' },
    take: OUTBOX_BATCH_SIZE,
  });

  let processed = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const claimed = await ctx.prisma.outboxEvent.updateMany({
      where: { id: candidate.id, status: 'PENDING' },
      data: {
        status: 'PROCESSING',
        availableAt: new Date(now.getTime() + OUTBOX_LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    // Someone else won the race for this event.
    if (claimed.count === 0) continue;

    const settled = await processEvent(ctx, candidate, options.channels);
    if (settled) processed += 1;
    else failed += 1;
  }

  return { processed, failed };
}

/** Handles one event. Returns true when every delivery ended up SENT. */
async function processEvent(
  ctx: AppContext,
  event: OutboxEventRow,
  channelOverride?: Map<ChannelName, NotifyChannel>,
): Promise<boolean> {
  const now = ctx.now();
  const escalationEvent = isEscalationTopic(event.topic);

  try {
    const targets = await resolveTargets(ctx, event, escalationEvent);
    const deliveries = await ensureDeliveries(ctx, event.id, targets, now);
    const channels = channelOverride ?? createChannelRegistry(ctx);

    for (const delivery of deliveries) {
      if (delivery.status === 'SENT' || delivery.status === 'DEAD') continue;
      if (delivery.nextAttemptAt.getTime() > now.getTime()) continue;
      await attemptDelivery(ctx, event, delivery, channels, !escalationEvent);
    }

    const finalDeliveries = await ctx.prisma.notificationDelivery.findMany({
      where: { outboxId: event.id },
    });

    if (finalDeliveries.length === 0) {
      // No address, no endpoint: nothing was delivered and nothing ever
      // will be. Marking this SENT would hide a dropped notification behind
      // a green status, so it is reported to ops instead.
      await ctx.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'DEAD',
          processedAt: now,
          lastError: 'no delivery target: the event carries no address for any configured channel',
        },
      });
      await escalateUndeliverableEvent(ctx, event, 'no delivery target');
      ctx.logger.error('outbox event has no delivery target', {
        outboxId: event.id,
        topic: event.topic,
        channels: resolveCustomerChannels(ctx.config.NOTIFY_CHANNELS),
      });
      return false;
    }

    const allDead = finalDeliveries.every((d) => d.status === 'DEAD');
    // Every delivery is settled: sent, or dead after its retries ran out.
    const allSettled = finalDeliveries.every(
      (d) => d.status === 'SENT' || d.status === 'DEAD',
    );

    if (allDead) {
      await ctx.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'DEAD', processedAt: now, lastError: 'all deliveries exhausted' },
      });
      ctx.logger.error('outbox event is dead', { outboxId: event.id, topic: event.topic });
      return false;
    }

    if (allSettled) {
      await ctx.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'SENT', processedAt: now, lastError: null },
      });
      return true;
    }

    // Still retrying: come back when the earliest delivery is due.
    const nextAt = finalDeliveries.reduce<Date | null>((acc, d) => {
      if (d.status !== 'PENDING' && d.status !== 'FAILED') return acc;
      return earlier(acc, d.nextAttemptAt);
    }, null);

    await ctx.prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: 'PENDING',
        availableAt: nextAt ?? now,
        lastError: 'deliveries pending',
      },
    });
    return false;
  } catch (err) {
    // One bad event must never take the pump down.
    const message = errorMessage(err);
    await ctx.prisma.outboxEvent.update({
      where: { id: event.id },
      data: {
        status: 'PENDING',
        availableAt: nextAttemptAt(event.attempts + 1, now),
        lastError: message,
        attempts: { increment: 1 },
      },
    });
    ctx.logger.error('outbox event processing failed', {
      err,
      outboxId: event.id,
      topic: event.topic,
    });
    return false;
  }
}

/**
 * An event that nobody can receive is a dropped notification. It is reported
 * to ops exactly like an exhausted channel is, so that a silent hole in the
 * customer journey cannot hide behind a green outbox.
 */
async function escalateUndeliverableEvent(
  ctx: AppContext,
  event: OutboxEventRow,
  reason: string,
): Promise<void> {
  const now = ctx.now();
  const data = extractNotificationData(isRecord(event.payload) ? event.payload : {});
  const payload: Record<string, unknown> = {
    outboxId: event.id,
    eventId: event.id,
    topic: event.topic,
    reason,
    channels: resolveCustomerChannels(ctx.config.NOTIFY_CHANNELS),
    opsWebhookUrl: ctx.config.OPS_ALERT_WEBHOOK_URL,
  };
  if (data.orderNo !== undefined) payload.orderNo = data.orderNo;

  try {
    await emitEventIdempotent(ctx.prisma, {
      topic: OUTBOX_TOPICS.NOTIFICATION_ESCALATED,
      aggregateType: 'OutboxEvent',
      aggregateId: event.id,
      dedupeKey: `escalated-event:${event.id}`,
      payload,
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  await ctx.prisma.auditLog.create({
    data: {
      actor: ESCALATION_ACTOR,
      action: ESCALATION_ACTION,
      entityType: 'OutboxEvent',
      entityId: event.id,
      meta: { topic: event.topic, reason, outboxId: event.id },
    },
  });

  ctx.logger.error('outbox event escalated to ops (undeliverable)', {
    outboxId: event.id,
    topic: event.topic,
    reason,
    escalatedAt: now.toISOString(),
  });
}

/**
 * Which channels does this event go to?
 *
 * An escalation report is addressed to the operations channel only — never
 * back through the customer channel that failed.
 */
async function resolveTargets(
  ctx: AppContext,
  event: OutboxEventRow,
  escalationEvent: boolean,
): Promise<ResolvedTarget[]> {
  if (escalationEvent) {
    const url = ctx.config.OPS_ALERT_WEBHOOK_URL.trim();
    return [{ channel: 'ops', destination: url === '' ? OPS_LOG_DESTINATION : url }];
  }

  const data = extractNotificationData(isRecord(event.payload) ? event.payload : {});
  const targets: ResolvedTarget[] = [];

  for (const channel of resolveCustomerChannels(ctx.config.NOTIFY_CHANNELS)) {
    if (channel === 'email') {
      if (data.guestEmail) targets.push({ channel: 'email', destination: data.guestEmail });
      continue;
    }
    if (channel === 'sms') {
      if (data.guestPhone) targets.push({ channel: 'sms', destination: data.guestPhone });
      continue;
    }
    // webhook: fan out to every active endpoint.
    const endpoints = await ctx.prisma.webhookEndpoint.findMany({ where: { active: true } });
    for (const endpoint of endpoints) {
      targets.push({
        channel: 'webhook',
        destination: endpoint.url,
        endpoint: { id: endpoint.id, url: endpoint.url, secret: endpoint.secret },
      });
    }
  }

  return targets;
}

/**
 * Create the delivery rows that do not exist yet. The pump is re-runnable:
 * a row that is already there is never duplicated.
 */
async function ensureDeliveries(
  ctx: AppContext,
  outboxId: string,
  targets: ResolvedTarget[],
  now: Date,
): Promise<DeliveryRow[]> {
  const existing = await ctx.prisma.notificationDelivery.findMany({ where: { outboxId } });
  const known = new Set(existing.map((d) => `${d.channel}|${d.destination}`));

  const created: DeliveryRow[] = [];
  for (const target of targets) {
    const key = `${target.channel}|${target.destination}`;
    if (known.has(key)) continue;
    known.add(key);
    const row = await ctx.prisma.notificationDelivery.create({
      data: {
        outboxId,
        channel: target.channel,
        destination: target.destination,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
      },
    });
    created.push(row);
  }

  return [...existing, ...created];
}

function createChannelRegistry(ctx: AppContext): Map<ChannelName, NotifyChannel> {
  return new Map<ChannelName, NotifyChannel>([
    ['email', createEmailChannel({ logger: ctx.logger })],
    ['sms', createSmsChannel({ logger: ctx.logger })],
    ['webhook', createWebhookChannel({ logger: ctx.logger })],
    ['ops', createOpsChannel({ logger: ctx.logger, opsWebhookUrl: ctx.config.OPS_ALERT_WEBHOOK_URL })],
  ]);
}

/** Try one channel. A failure is a retry, not a crash. */
async function attemptDelivery(
  ctx: AppContext,
  event: OutboxEventRow,
  delivery: DeliveryRow,
  channels: Map<ChannelName, NotifyChannel>,
  allowEscalation: boolean,
): Promise<AttemptOutcome> {
  const channel = channels.get(delivery.channel as ChannelName);
  const now = ctx.now();

  if (!channel) {
    await ctx.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: { status: 'DEAD', attempts: { increment: 1 }, lastError: `unknown channel ${delivery.channel}` },
    });
    ctx.logger.error('unknown notification channel', {
      deliveryId: delivery.id,
      channel: delivery.channel,
    });
    if (allowEscalation) {
      try {
        await escalate(
          ctx,
          event,
          delivery,
          delivery.attempts + 1,
          'DEAD',
          `unknown channel ${delivery.channel}`,
        );
      } catch (escalationError) {
        ctx.logger.error('failed to escalate notification delivery', {
          err: escalationError,
          deliveryId: delivery.id,
        });
      }
    }
    return 'dead';
  }

  // Claim the delivery before sending it: the conditional update only hits
  // once, so a second worker can never send the same message twice.
  const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS);
  const claimed = await ctx.prisma.notificationDelivery.updateMany({
    where: { id: delivery.id, status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now } },
    data: { nextAttemptAt: leaseUntil },
  });
  if (claimed.count === 0) {
    return 'failed';
  }

  try {
    const target = await buildTarget(ctx, delivery);
    if (target === null) {
      // The webhook endpoint was deactivated on purpose: nothing to deliver,
      // and we must not keep retrying forever.
      await ctx.prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'SENT',
          sentAt: now,
          attempts: { increment: 1 },
          lastError: 'skipped: webhook endpoint is inactive',
        },
      });
      return 'sent';
    }

    await channel.send(target, toPayload(event));

    await ctx.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENT', sentAt: now, attempts: { increment: 1 }, lastError: null },
    });
    return 'sent';
  } catch (err) {
    const message = errorMessage(err);
    const attempts = delivery.attempts + 1;
    const exhausted = attempts >= ctx.config.NOTIFY_MAX_ATTEMPTS;
    const status: DeliveryStatus = exhausted ? 'DEAD' : 'FAILED';

    await ctx.prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status,
        attempts,
        lastError: message,
        nextAttemptAt: exhausted ? leaseUntil : nextAttemptAt(attempts, now),
      },
    });

    if (allowEscalation && shouldEscalate(status, attempts, ctx.config.NOTIFY_ESCALATION_THRESHOLD)) {
      try {
        await escalate(ctx, event, delivery, attempts, status, message);
      } catch (escalationError) {
        ctx.logger.error('failed to escalate notification delivery', {
          err: escalationError,
          deliveryId: delivery.id,
        });
      }
    }

    return exhausted ? 'dead' : 'failed';
  }
}

/** Rebuild the target for a stored delivery row. */
async function buildTarget(ctx: AppContext, delivery: DeliveryRow): Promise<NotificationTarget | null> {
  const base: NotificationTarget = { destination: delivery.destination, deliveryId: delivery.id };
  if (delivery.channel !== 'webhook') return base;

  const endpoint = await ctx.prisma.webhookEndpoint.findFirst({
    where: { url: delivery.destination, active: true },
  });
  if (!endpoint) return null;
  return { ...base, endpoint: { id: endpoint.id, url: endpoint.url, secret: endpoint.secret } };
}

/** The event as a channel sees it. */
function toPayload(event: OutboxEventRow): OutboxEventPayload {
  const raw = isRecord(event.payload) ? event.payload : {};
  const data = extractNotificationData(raw);
  const payload: OutboxEventPayload = { ...raw, topic: event.topic, eventId: event.id };
  if (data.orderNo !== undefined) payload.orderNo = data.orderNo;
  return payload;
}

/**
 * Auto re-report (SPEC §6.3).
 *
 * An exhausted channel produces an operations visible record: an AuditLog
 * row plus a new outbox event on the ops channel. The dedupe key makes the
 * report at-most-once per delivery.
 */
async function escalate(
  ctx: AppContext,
  event: OutboxEventRow,
  delivery: DeliveryRow,
  attempts: number,
  status: DeliveryStatus,
  error: string,
): Promise<void> {
  const now = ctx.now();
  const opsWebhookUrl = ctx.config.OPS_ALERT_WEBHOOK_URL;

  const payload: Record<string, unknown> = {
    deliveryId: delivery.id,
    channel: delivery.channel,
    destination: delivery.destination,
    attempts,
    status,
    error,
    outboxId: delivery.outboxId,
    eventId: event.id,
    opsWebhookUrl,
  };
  const data = extractNotificationData(isRecord(event.payload) ? event.payload : {});
  if (data.orderNo !== undefined) payload.orderNo = data.orderNo;

  try {
    await emitEventIdempotent(ctx.prisma, {
      topic: OUTBOX_TOPICS.NOTIFICATION_ESCALATED,
      aggregateType: ESCALATION_ENTITY_TYPE,
      aggregateId: delivery.id,
      dedupeKey: escalationDedupeKey(delivery.id),
      payload,
    });
  } catch (err) {
    // Two workers may escalate the same delivery; the unique dedupe key
    // turns that into a no-op for us.
    if (!isUniqueViolation(err)) throw err;
  }

  await ctx.prisma.auditLog.create({
    data: {
      actor: ESCALATION_ACTOR,
      action: ESCALATION_ACTION,
      entityType: ESCALATION_ENTITY_TYPE,
      entityId: delivery.id,
      meta: {
        channel: delivery.channel,
        destination: delivery.destination,
        attempts,
        status,
        outboxId: delivery.outboxId,
        error,
      },
    },
  });

  // Marked last: if we die before this, the next failed attempt escalates
  // again — the dedupe key keeps the report itself unique.
  await ctx.prisma.notificationDelivery.updateMany({
    where: { id: delivery.id, escalatedAt: null },
    data: { escalatedAt: now },
  });

  ctx.logger.error('notification delivery escalated to ops', {
    channel: delivery.channel,
    deliveryId: delivery.id,
    outboxId: delivery.outboxId,
    attempts,
    status,
    error,
    opsWebhookUrl,
  });
}
