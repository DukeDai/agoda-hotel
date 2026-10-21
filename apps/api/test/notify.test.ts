import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { noopLogger } from '@ota/core';
import type { AppContext } from '../src/lib/context.js';
import { RETRY_BASE_MS, RETRY_MAX_MS, nextAttemptAt } from '../src/modules/notify/backoff.js';
import {
  escalationDedupeKey,
  isEscalationTopic,
  shouldEscalate,
} from '../src/modules/notify/escalation.js';
import {
  buildWebhookBody,
  createOpsChannel,
  createWebhookChannel,
  resolveCustomerChannels,
  selectChannels,
  signWebhookBody,
} from '../src/modules/notify/channels.js';
import {
  extractNotificationData,
  renderMessage,
  renderSmsMessage,
} from '../src/modules/notify/message.js';
import { processOutboxOnce } from '../src/modules/notify/pump.js';
import type { ChannelName, NotifyChannel } from '../src/modules/notify/types.js';

/**
 * Unit tests for the notification module.
 *
 * No database, no network: everything exercised here is pure logic that the
 * pump and the channels build on.
 */

const NOW = new Date('2026-01-01T00:00:00.000Z');

const ALL_TOPICS = [
  'booking.created',
  'booking.paid',
  'booking.processing',
  'booking.confirmed',
  'booking.failed',
  'booking.cancelled',
  'booking.refunded',
  'payment.failed',
  'supplier.degraded',
  'notification.escalated',
];

describe('nextAttemptAt', () => {
  const delayOf = (attempts: number, now: Date = NOW): number =>
    nextAttemptAt(attempts, now).getTime() - now.getTime();

  it('grows with the number of attempts', () => {
    const first = delayOf(1);
    expect(first).toBeGreaterThanOrEqual(RETRY_BASE_MS / 2);
    expect(first).toBeLessThanOrEqual(RETRY_BASE_MS);

    const second = delayOf(2);
    expect(second).toBeGreaterThanOrEqual(RETRY_BASE_MS);
    expect(second).toBeLessThanOrEqual(RETRY_BASE_MS * 2);
    expect(second).toBeGreaterThanOrEqual(first);

    const third = delayOf(3);
    expect(third).toBeGreaterThanOrEqual(RETRY_BASE_MS * 2);
    expect(third).toBeLessThanOrEqual(RETRY_BASE_MS * 4);
    expect(third).toBeGreaterThanOrEqual(second);
  });

  it('never waits longer than the cap', () => {
    for (const attempts of [1, 4, 8, 13, 20, 50, 100]) {
      expect(delayOf(attempts)).toBeLessThanOrEqual(RETRY_MAX_MS);
    }
  });

  it('sits at the cap once the exponential would pass it', () => {
    // 5s * 2^12 already exceeds the 30 minute cap.
    for (const attempts of [13, 20, 50, 100]) {
      const delay = delayOf(attempts);
      expect(delay).toBeLessThanOrEqual(RETRY_MAX_MS);
      expect(delay).toBeGreaterThanOrEqual(RETRY_MAX_MS / 2);
    }
  });

  it('honours a custom base and cap', () => {
    const delay = nextAttemptAt(1, NOW, 1_000, 4_000).getTime() - NOW.getTime();
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(1_000);
  });

  it('always moves forward from now', () => {
    expect(nextAttemptAt(1, NOW).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('escalation threshold', () => {
  it('stays quiet below the threshold', () => {
    expect(shouldEscalate('FAILED', 1, 3)).toBe(false);
    expect(shouldEscalate('FAILED', 2, 3)).toBe(false);
  });

  it('reports at and above the threshold', () => {
    expect(shouldEscalate('FAILED', 3, 3)).toBe(true);
    expect(shouldEscalate('FAILED', 4, 3)).toBe(true);
  });

  it('always reports an exhausted delivery', () => {
    expect(shouldEscalate('DEAD', 1, 3)).toBe(true);
  });

  it('never reports a healthy delivery', () => {
    expect(shouldEscalate('SENT', 9, 3)).toBe(false);
    expect(shouldEscalate('PENDING', 9, 3)).toBe(false);
  });

  it('does not escalate an escalation', () => {
    expect(isEscalationTopic('notification.escalated')).toBe(true);
    expect(isEscalationTopic('booking.confirmed')).toBe(false);
  });

  it('deduplicates the ops report per delivery', () => {
    expect(escalationDedupeKey('delivery-1')).toBe('escalated:delivery-1');
    expect(escalationDedupeKey('delivery-1')).toBe(escalationDedupeKey('delivery-1'));
  });
});

describe('message rendering', () => {
  it('names the order for every topic', () => {
    for (const topic of ALL_TOPICS) {
      const rendered = renderMessage(topic, { orderNo: 'OTA-20260101-0007', hotelName: 'Hotel' });
      expect(rendered.subject).toContain('OTA-20260101-0007');
      expect(rendered.body).toContain('OTA-20260101-0007');
    }
  });

  it('renders the confirmation number of a confirmed booking', () => {
    const rendered = renderMessage('booking.confirmed', {
      orderNo: 'OTA-1',
      confirmationNumber: 'AGD-4242',
    });
    expect(rendered.body).toContain('AGD-4242');
  });

  it('renders the reason of a failed payment', () => {
    const rendered = renderMessage('payment.failed', { orderNo: 'OTA-2', reason: 'card declined' });
    expect(rendered.body).toContain('card declined');
  });

  it('reads fields out of nested payloads', () => {
    const rendered = renderMessage('booking.confirmed', { booking: { orderNo: 'OTA-3' } });
    expect(rendered.body).toContain('OTA-3');
  });

  it('extracts the notification fields', () => {
    const data = extractNotificationData({
      orderNo: 'OTA-4',
      guestEmail: 'guest@example.com',
      guestPhone: '+8613800000000',
      booking: { hotelName: 'Hotel', checkIn: '2026-02-01', checkOut: '2026-02-03' },
    });
    expect(data.orderNo).toBe('OTA-4');
    expect(data.guestEmail).toBe('guest@example.com');
    expect(data.guestPhone).toBe('+8613800000000');
    expect(data.hotelName).toBe('Hotel');
    expect(data.checkIn).toBe('2026-02-01');
  });

  it('keeps the sms body short', () => {
    const sms = renderSmsMessage('booking.confirmed', {
      orderNo: 'OTA-5',
      hotelName: 'x'.repeat(300),
    });
    expect(sms.length).toBeLessThanOrEqual(160);
  });
});

describe('webhook signature', () => {
  const secret = 'wh-secret';
  const body = '{"id":"evt-1","topic":"booking.confirmed"}';

  it('is the HMAC of the raw body', () => {
    const expected = `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
    expect(signWebhookBody(secret, body)).toBe(expected);
  });

  it('is deterministic', () => {
    expect(signWebhookBody(secret, body)).toBe(signWebhookBody(secret, body));
  });

  it('changes with the body and with the secret', () => {
    expect(signWebhookBody(secret, 'body-a')).not.toBe(signWebhookBody(secret, 'body-b'));
    expect(signWebhookBody('secret-a', body)).not.toBe(signWebhookBody('secret-b', body));
  });

  it('signs exactly the bytes that are sent', () => {
    const event = { topic: 'booking.confirmed', eventId: 'evt-1', orderNo: 'OTA-1', hotel: 'X' };
    const payload = buildWebhookBody(event);
    expect(payload).toContain('booking.confirmed');
    expect(signWebhookBody('k', payload)).toBe(
      `sha256=${createHmac('sha256', 'k').update(payload, 'utf8').digest('hex')}`,
    );
  });
});

describe('channel selection', () => {
  it('ignores unknown and empty entries', () => {
    expect(selectChannels('email, ,unknown,sms,EMAIL')).toEqual(['email', 'sms']);
    expect(selectChannels('pigeon')).toEqual([]);
    expect(selectChannels('')).toEqual([]);
    expect(selectChannels('   ,  ')).toEqual([]);
  });

  it('keeps the configured order and drops duplicates', () => {
    expect(selectChannels('sms,email,sms')).toEqual(['sms', 'email']);
  });

  it('always fans out to the webhook channel', () => {
    expect(resolveCustomerChannels('email')).toEqual(['email', 'webhook']);
    expect(resolveCustomerChannels('email,sms,webhook')).toEqual(['email', 'sms', 'webhook']);
    expect(resolveCustomerChannels('')).toEqual(['webhook']);
  });
});

describe('webhook channel', () => {
  const target = {
    destination: 'https://partner.example/hook',
    deliveryId: 'delivery-1',
    endpoint: { id: 'endpoint-1', url: 'https://partner.example/hook', secret: 'wh-secret' },
  };
  const event = { topic: 'booking.confirmed', eventId: 'evt-1', orderNo: 'OTA-1' };

  it('signs the exact body and sends the ota headers', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const channel = createWebhookChannel({ logger: noopLogger, fetchImpl: fakeFetch });
    await channel.send(target, event);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('no webhook call was made');
    const headers = call.init.headers as Record<string, string>;
    const body = String(call.init.body);

    expect(call.url).toBe('https://partner.example/hook');
    expect(call.init.method).toBe('POST');
    expect(headers['x-ota-event']).toBe('booking.confirmed');
    expect(headers['x-ota-delivery']).toBe('delivery-1');
    expect(headers['x-ota-signature']).toBe(signWebhookBody('wh-secret', body));
  });

  it('treats a non 2xx answer as a failed delivery', async () => {
    const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const channel = createWebhookChannel({ logger: noopLogger, fetchImpl: fakeFetch });
    await expect(channel.send(target, event)).rejects.toThrow(/500/);
  });

  it('treats a network error as a failed delivery', async () => {
    const fakeFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const channel = createWebhookChannel({ logger: noopLogger, fetchImpl: fakeFetch });
    await expect(channel.send(target, event)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('ops channel', () => {
  const event = {
    topic: 'notification.escalated',
    eventId: 'evt-2',
    orderNo: 'OTA-2',
    channel: 'sms',
    attempts: 5,
  };

  it('only logs when no ops webhook is configured', async () => {
    const channel = createOpsChannel({ logger: noopLogger, opsWebhookUrl: '' });
    await expect(
      channel.send({ destination: 'ops-log', deliveryId: 'delivery-2' }, event),
    ).resolves.toBeUndefined();
  });

  it('posts the escalation to the ops webhook', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const channel = createOpsChannel({
      logger: noopLogger,
      opsWebhookUrl: 'https://ops.example/alert',
      secret: 'ops-secret',
      fetchImpl: fakeFetch,
    });
    await channel.send({ destination: 'https://ops.example/alert', deliveryId: 'delivery-2' }, event);

    const call = calls[0];
    if (!call) throw new Error('no ops call was made');
    const headers = call.init.headers as Record<string, string>;
    const body = String(call.init.body);

    expect(call.url).toBe('https://ops.example/alert');
    expect(headers['x-ota-event']).toBe('notification.escalated');
    expect(headers['x-ota-signature']).toBe(signWebhookBody('ops-secret', body));
    expect(body).toContain('notification.escalated');
  });
});

// --- the pump, against an in-memory stand-in for Prisma ---------------------
// No database, no network: the fake below implements the handful of Prisma
// calls the pump makes.

type FakeRow = Record<string, unknown>;

function matches(row: FakeRow, where: FakeRow = {}): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    const value = row[key];

    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (condition instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (typeof condition === 'object') {
      const filters = condition as Record<string, unknown>;
      if ('lte' in filters) {
        const limit = filters.lte as Date;
        if (!(value instanceof Date) || value.getTime() > limit.getTime()) return false;
        continue;
      }
      if ('in' in filters) {
        if (!(filters.in as unknown[]).includes(value)) return false;
        continue;
      }
      if ('not' in filters) {
        if (filters.not === null) {
          if (value === null || value === undefined) return false;
          continue;
        }
        if (value === filters.not) return false;
        continue;
      }
      return false;
    }
    if (value !== condition) return false;
  }
  return true;
}

function applyData(row: FakeRow, data: FakeRow): void {
  for (const [key, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !(value instanceof Date) &&
      'increment' in (value as Record<string, unknown>)
    ) {
      const current = typeof row[key] === 'number' ? (row[key] as number) : 0;
      row[key] = current + (value as { increment: number }).increment;
      continue;
    }
    row[key] = value;
  }
}

function createFakePrisma() {
  const state: {
    outboxEvent: FakeRow[];
    notificationDelivery: FakeRow[];
    webhookEndpoint: FakeRow[];
    auditLog: FakeRow[];
  } = { outboxEvent: [], notificationDelivery: [], webhookEndpoint: [], auditLog: [] };

  let seq = 0;

  const table = (rows: FakeRow[]) => ({
    async findMany(args: { where?: FakeRow; take?: number } = {}) {
      const found = rows.filter((row) => matches(row, args.where));
      found.sort((a, b) => {
        const av = a.availableAt instanceof Date ? a.availableAt.getTime() : 0;
        const bv = b.availableAt instanceof Date ? b.availableAt.getTime() : 0;
        return av - bv;
      });
      return found.slice(0, args.take ?? found.length).map((row) => ({ ...row }));
    },
    async findUnique(args: { where: FakeRow }) {
      const found = rows.find((row) => matches(row, args.where));
      return found ? { ...found } : null;
    },
    async findFirst(args: { where?: FakeRow }) {
      const found = rows.find((row) => matches(row, args.where));
      return found ? { ...found } : null;
    },
    async create(args: { data: FakeRow }) {
      seq += 1;
      const row: FakeRow = { id: `row-${seq}`, ...args.data };
      rows.push(row);
      return { ...row };
    },
    async update(args: { where: FakeRow; data: FakeRow }) {
      const found = rows.find((row) => matches(row, args.where));
      if (!found) throw new Error('record not found');
      applyData(found, args.data);
      return { ...found };
    },
    async updateMany(args: { where?: FakeRow; data: FakeRow }) {
      let count = 0;
      for (const row of rows) {
        if (!matches(row, args.where)) continue;
        applyData(row, args.data);
        count += 1;
      }
      return { count };
    },
  });

  return {
    state,
    prisma: {
      outboxEvent: table(state.outboxEvent),
      notificationDelivery: table(state.notificationDelivery),
      webhookEndpoint: table(state.webhookEndpoint),
      auditLog: table(state.auditLog),
    },
  };
}

function createCtx(prisma: unknown, config: Record<string, unknown> = {}): AppContext {
  return {
    config: {
      NOTIFY_CHANNELS: 'email,sms',
      NOTIFY_MAX_ATTEMPTS: 5,
      NOTIFY_ESCALATION_THRESHOLD: 2,
      OPS_ALERT_WEBHOOK_URL: 'https://ops.example/alert',
      ...config,
    },
    logger: noopLogger,
    prisma,
    now: () => new Date(),
  } as unknown as AppContext;
}

function channelRegistry(overrides: Partial<Record<ChannelName, NotifyChannel>>): Map<ChannelName, NotifyChannel> {
  const ok: NotifyChannel = { name: 'email', send: async () => {} };
  return new Map<ChannelName, NotifyChannel>([
    ['email', overrides.email ?? ok],
    ['sms', overrides.sms ?? ok],
    ['webhook', overrides.webhook ?? ok],
    ['ops', overrides.ops ?? ok],
  ]);
}

describe('outbox pump', () => {
  const bookingEvent = (id: string): FakeRow => ({
    id,
    topic: 'booking.confirmed',
    aggregateType: 'Booking',
    aggregateId: `booking-${id}`,
    payload: {
      orderNo: 'OTA-1',
      guestEmail: 'guest@example.com',
      guestPhone: '+8613800000000',
    },
    status: 'PENDING',
    attempts: 0,
    availableAt: new Date(0),
    lastError: null,
  });

  it('delivers every channel independently and retries only the broken one', async () => {
    const { prisma, state } = createFakePrisma();
    state.outboxEvent.push(bookingEvent('evt-1'));

    const delivered: string[] = [];
    const channels = channelRegistry({
      email: {
        name: 'email',
        send: async () => {
          throw new Error('smtp down');
        },
      },
      sms: {
        name: 'sms',
        send: async (target) => {
          delivered.push(target.destination);
        },
      },
    });

    const result = await processOutboxOnce(createCtx(prisma), { channels });

    expect(delivered).toEqual(['+8613800000000']);
    expect(result).toEqual({ processed: 0, failed: 1 });

    const email = state.notificationDelivery.find((d) => d.channel === 'email');
    const sms = state.notificationDelivery.find((d) => d.channel === 'sms');
    expect(sms?.status).toBe('SENT');
    expect(email?.status).toBe('FAILED');
    expect(email?.attempts).toBe(1);

    // the event waits for the failed channel, not for the healthy one
    const event = state.outboxEvent[0];
    expect(event?.status).toBe('PENDING');
    expect(event?.availableAt).toEqual(email?.nextAttemptAt);
  });

  it('auto reports an exhausted channel to ops, exactly once', async () => {
    const { prisma, state } = createFakePrisma();
    state.outboxEvent.push(bookingEvent('evt-2'));
    state.notificationDelivery.push({
      id: 'delivery-1',
      outboxId: 'evt-2',
      channel: 'email',
      destination: 'guest@example.com',
      status: 'FAILED',
      attempts: 2,
      lastError: 'smtp down',
      escalatedAt: null,
      sentAt: null,
      nextAttemptAt: new Date(0),
    });

    const channels = channelRegistry({
      email: {
        name: 'email',
        send: async () => {
          throw new Error('smtp down');
        },
      },
    });

    await processOutboxOnce(createCtx(prisma), { channels });

    const delivery = state.notificationDelivery[0];
    expect(delivery?.status).toBe('FAILED');
    expect(delivery?.attempts).toBe(3);
    expect(delivery?.escalatedAt).toBeInstanceOf(Date);

    // an operations visible audit record
    expect(state.auditLog).toHaveLength(1);
    expect(state.auditLog[0]?.action).toBe('notification.escalated');
    expect(state.auditLog[0]?.entityType).toBe('NotificationDelivery');
    expect(state.auditLog[0]?.entityId).toBe('delivery-1');

    // and an ops report, addressed to the ops channel
    const report = state.outboxEvent.find((e) => e.topic === 'notification.escalated');
    expect(report).toBeDefined();
    expect(report?.dedupeKey).toBe('escalated:delivery-1');
    expect(report?.aggregateId).toBe('delivery-1');
  });

  it('never escalates an escalation', async () => {
    const { prisma, state } = createFakePrisma();
    state.outboxEvent.push({
      id: 'evt-3',
      topic: 'notification.escalated',
      aggregateType: 'NotificationDelivery',
      aggregateId: 'delivery-9',
      payload: { deliveryId: 'delivery-9', channel: 'sms', attempts: 5, orderNo: 'OTA-9' },
      status: 'PENDING',
      attempts: 0,
      availableAt: new Date(0),
      lastError: null,
    });

    const channels = channelRegistry({
      ops: {
        name: 'ops',
        send: async () => {
          throw new Error('ops endpoint down');
        },
      },
    });

    await processOutboxOnce(createCtx(prisma), { channels });

    // the report goes to the ops channel only, and it reports nothing back
    expect(state.notificationDelivery).toHaveLength(1);
    expect(state.notificationDelivery[0]?.channel).toBe('ops');
    expect(state.auditLog).toHaveLength(0);
    expect(state.outboxEvent.filter((e) => e.topic === 'notification.escalated')).toHaveLength(1);
  });

  it('does not duplicate deliveries when it runs again', async () => {
    const { prisma, state } = createFakePrisma();
    state.outboxEvent.push(bookingEvent('evt-4'));

    const channels = channelRegistry({});
    await processOutboxOnce(createCtx(prisma), { channels });
    await processOutboxOnce(createCtx(prisma), { channels });

    expect(state.notificationDelivery).toHaveLength(2);
    expect(state.notificationDelivery.every((d) => d.status === 'SENT')).toBe(true);
    expect(state.outboxEvent[0]?.status).toBe('SENT');
  });

  it('leaves an event that another worker holds alone', async () => {
    const { prisma, state } = createFakePrisma();
    state.outboxEvent.push({
      ...bookingEvent('evt-5'),
      status: 'PROCESSING',
      availableAt: new Date(Date.now() + 60_000),
    });

    const channels = channelRegistry({});
    const result = await processOutboxOnce(createCtx(prisma), { channels });

    expect(result).toEqual({ processed: 0, failed: 0 });
    expect(state.notificationDelivery).toHaveLength(0);
  });
});
