/**
 * Notification module — shared types.
 *
 * The channel port is deliberately tiny: a channel knows how to put a message
 * somewhere. It knows nothing about the outbox, the database or retries; the
 * pump owns all of that. That is what makes each channel independently
 * retryable (SPEC §6.2) — a broken channel only ever fails its own delivery.
 */

/** Customer facing channels. `ops` is internal and never selected by config. */
export const CUSTOMER_CHANNELS = ['email', 'sms', 'webhook'] as const;

export type CustomerChannelName = (typeof CUSTOMER_CHANNELS)[number];

/** Internal channel used to deliver escalations to the operations team. */
export const OPS_CHANNEL_NAME = 'ops';

export type ChannelName = CustomerChannelName | typeof OPS_CHANNEL_NAME;

/**
 * The event as seen by a channel. It is the outbox payload plus the envelope
 * fields every channel needs (topic + event id for idempotency on the
 * receiving side).
 */
export type OutboxEventPayload = {
  topic: string;
  eventId: string;
  orderNo?: string;
  [key: string]: unknown;
};

/** Where a single delivery goes. */
export type NotificationTarget = {
  /** Email address, phone number, webhook URL or ops endpoint. */
  destination: string;
  /** Delivery id — echoed back to webhook receivers for deduplication. */
  deliveryId?: string;
  /** Webhook target details; the secret signs the request body. */
  endpoint?: {
    id: string;
    url: string;
    secret: string;
  };
};

/** A delivery transport. */
export interface NotifyChannel {
  readonly name: ChannelName;
  send(target: NotificationTarget, event: OutboxEventPayload): Promise<void>;
}
