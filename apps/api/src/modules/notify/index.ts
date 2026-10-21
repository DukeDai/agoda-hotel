/**
 * Notification module — public surface.
 *
 * The HTTP routes, the background pump and the pure helpers are all exported
 * from here. `apps/api/src/modules/admin` imports `processOutboxOnce` from
 * this module, so the name and signature must not change.
 */

export { registerNotifyRoutes } from './routes.js';

export { processOutboxOnce, OUTBOX_BATCH_SIZE, OUTBOX_LEASE_MS } from './pump.js';
export type { OutboxPumpResult, OutboxPumpOptions } from './pump.js';

export { startOutboxWorker, OUTBOX_WORKER_INTERVAL_MS } from './worker.js';
export type { OutboxWorkerHandle, OutboxWorkerOptions } from './worker.js';

export { nextAttemptAt, backoffDelayMs, RETRY_BASE_MS, RETRY_MAX_MS } from './backoff.js';

export {
  shouldEscalate,
  isEscalationTopic,
  escalationDedupeKey,
  ESCALATION_ACTION,
  ESCALATION_ACTOR,
  ESCALATION_ENTITY_TYPE,
} from './escalation.js';

export {
  renderMessage,
  renderSmsMessage,
  extractNotificationData,
  SMS_MAX_LENGTH,
} from './message.js';
export type { NotificationData, RenderedMessage } from './message.js';

export {
  selectChannels,
  resolveCustomerChannels,
  signWebhookBody,
  buildWebhookBody,
  createEmailChannel,
  createSmsChannel,
  createWebhookChannel,
  createOpsChannel,
  WEBHOOK_TIMEOUT_MS,
  OPS_LOG_DESTINATION,
  OPS_ALERT_SIGNING_SECRET,
} from './channels.js';

export {
  appendNotificationLog,
  resolveApiPackageDir,
  resolveNotificationLogPath,
  NOTIFICATION_LOG_FILENAME,
} from './file-log.js';

export { CUSTOMER_CHANNELS, OPS_CHANNEL_NAME } from './types.js';
export type {
  ChannelName,
  CustomerChannelName,
  NotifyChannel,
  NotificationTarget,
  OutboxEventPayload,
} from './types.js';
