import { createHmac } from 'node:crypto';
import type { Logger } from '@ota/core';
import { appendNotificationLog, resolveNotificationLogPath } from './file-log.js';
import { renderMessage, renderSmsMessage } from './message.js';
import {
  CUSTOMER_CHANNELS,
  OPS_CHANNEL_NAME,
  type ChannelName,
  type CustomerChannelName,
  type NotifyChannel,
  type NotificationTarget,
  type OutboxEventPayload,
} from './types.js';

/**
 * Channel adapters.
 *
 * Every adapter is independent: it resolves its own transport, throws on
 * failure and never touches the database. The pump turns a throw into a
 * retry, a retry into an escalation.
 */

/** A dead endpoint must not be able to hang the pump. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/** Signing secret for the ops alert webhook. */
export const OPS_ALERT_SIGNING_SECRET = process.env.OPS_ALERT_WEBHOOK_SECRET ?? 'ota-ops-alert';

/** Destination used when no ops webhook is configured: log only. */
export const OPS_LOG_DESTINATION = 'ops-log';

/**
 * Parse `NOTIFY_CHANNELS`. Unknown and empty entries are ignored, duplicates
 * collapse, order is preserved.
 */
export function selectChannels(raw: string): CustomerChannelName[] {
  const selected: CustomerChannelName[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toLowerCase();
    if (name === '') continue;
    if (!(CUSTOMER_CHANNELS as readonly string[]).includes(name)) continue;
    const channel = name as CustomerChannelName;
    if (!selected.includes(channel)) selected.push(channel);
  }
  return selected;
}

/**
 * The channels a customer event fans out to.
 *
 * `NOTIFY_CHANNELS` selects email and sms; the webhook channel always fans
 * out to the active `WebhookEndpoint` rows (SPEC §6.2). To stop webhooks,
 * deactivate the endpoint rows — that is the ops kill switch.
 */
export function resolveCustomerChannels(raw: string): CustomerChannelName[] {
  const selected = selectChannels(raw);
  if (!selected.includes('webhook')) selected.push('webhook');
  return selected;
}

/** `sha256=<hex>` HMAC of the raw request body. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

/** The exact bytes that are signed and sent. */
export function buildWebhookBody(event: OutboxEventPayload): string {
  const { topic, eventId, orderNo, ...data } = event;
  return JSON.stringify({ id: eventId, topic, orderNo, data });
}

/** Log fields: the destination is the only personal datum we keep. */
function destinationFields(channel: ChannelName, destination: string): Record<string, unknown> {
  if (channel === 'email') return { email: destination };
  if (channel === 'sms') return { phone: destination };
  return { destination };
}

/**
 * Mask a destination for the log file.
 *
 * The pino logger redacts `email`/`phone`, but the JSONL notification log
 * is a file on disk: it must not become a copy of the customer database.
 * The masked form still tells an operator WHICH mailbox or number was
 * written to, which is all a support case needs.
 */
export function maskDestination(destination: string): string {
  const at = destination.indexOf('@');
  if (at > 0) {
    const local = destination.slice(0, at);
    const domain = destination.slice(at + 1);
    return `${local.slice(0, 1)}***@${domain}`;
  }
  const digits = destination.replace(/\D/g, '');
  if (digits.length >= 6) {
    return `${destination.slice(0, 3)}****${destination.slice(-2)}`;
  }
  return '***';
}

// --- email ------------------------------------------------------------------

export type EmailChannelOptions = {
  logger: Logger;
  /** Where the rendered message is appended; defaults to the package log file. */
  logFilePath?: string;
};

export function createEmailChannel(options: EmailChannelOptions): NotifyChannel {
  const logFilePath = options.logFilePath ?? resolveNotificationLogPath();

  return {
    name: 'email',
    async send(target: NotificationTarget, event: OutboxEventPayload): Promise<void> {
      const rendered = renderMessage(event.topic, event);
      const fields = {
        channel: 'email',
        topic: event.topic,
        orderNo: event.orderNo,
        deliveryId: target.deliveryId,
        ...destinationFields('email', target.destination),
      };
      options.logger.info('notification delivered', fields);
      await appendNotificationLog(logFilePath, {
        ...fields,
        // The file on disk keeps a MASKED address, never the raw one.
        email: maskDestination(target.destination),
        subject: rendered.subject,
        body: rendered.body,
      });
    },
  };
}

// --- sms --------------------------------------------------------------------

export type SmsChannelOptions = {
  logger: Logger;
};

export function createSmsChannel(options: SmsChannelOptions): NotifyChannel {
  return {
    name: 'sms',
    async send(target: NotificationTarget, event: OutboxEventPayload): Promise<void> {
      const body = renderSmsMessage(event.topic, event);
      options.logger.info('notification delivered', {
        channel: 'sms',
        topic: event.topic,
        orderNo: event.orderNo,
        deliveryId: target.deliveryId,
        ...destinationFields('sms', target.destination),
        body,
      });
    },
  };
}

// --- webhook ----------------------------------------------------------------

export type WebhookChannelOptions = {
  logger: Logger;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

export function createWebhookChannel(options: WebhookChannelOptions): NotifyChannel {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: 'webhook',
    async send(target: NotificationTarget, event: OutboxEventPayload): Promise<void> {
      const endpoint = target.endpoint;
      if (!endpoint) {
        throw new Error('webhook delivery has no endpoint details');
      }
      const body = buildWebhookBody(event);
      const signature = signWebhookBody(endpoint.secret, body);

      let response: Response;
      try {
        response = await doFetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ota-event': event.topic,
            'x-ota-delivery': target.deliveryId ?? '',
            'x-ota-signature': signature,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`webhook request failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!response.ok) {
        throw new Error(`webhook responded with status ${response.status}`);
      }

      options.logger.info('notification delivered', {
        channel: 'webhook',
        topic: event.topic,
        orderNo: event.orderNo,
        deliveryId: target.deliveryId,
        ...destinationFields('webhook', endpoint.url),
        responseStatus: response.status,
      });
    },
  };
}

// --- ops --------------------------------------------------------------------

export type OpsChannelOptions = {
  logger: Logger;
  /** `OPS_ALERT_WEBHOOK_URL`; when empty the alert is only logged. */
  opsWebhookUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  secret?: string;
};

/**
 * The operations channel. It never talks to the customer: it is where the
 * auto re-report of an exhausted channel lands.
 */
export function createOpsChannel(options: OpsChannelOptions): NotifyChannel {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const secret = options.secret ?? OPS_ALERT_SIGNING_SECRET;

  return {
    name: OPS_CHANNEL_NAME,
    async send(target: NotificationTarget, event: OutboxEventPayload): Promise<void> {
      const url = (options.opsWebhookUrl ?? '').trim();
      const fields = {
        channel: OPS_CHANNEL_NAME,
        topic: event.topic,
        orderNo: event.orderNo,
        deliveryId: target.deliveryId,
      };

      if (url === '') {
        options.logger.error('ops alert', {
          ...fields,
          ...destinationFields('ops', OPS_LOG_DESTINATION),
        });
        return;
      }

      const body = buildWebhookBody(event);
      const signature = signWebhookBody(secret, body);

      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-ota-event': event.topic,
            'x-ota-delivery': target.deliveryId ?? '',
            'x-ota-signature': signature,
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new Error(`ops webhook request failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!response.ok) {
        throw new Error(`ops webhook responded with status ${response.status}`);
      }

      options.logger.info('ops alert delivered', {
        ...fields,
        ...destinationFields('ops', url),
        responseStatus: response.status,
      });
    },
  };
}
