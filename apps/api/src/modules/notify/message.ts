/**
 * Human readable rendering of an outbox event, per topic.
 *
 * Pure functions only — no I/O, no clock, no database. The channel adapters
 * take the rendered text and ship it.
 *
 * PII rule: the rendered message may contain what the customer needs (order
 * number, hotel, dates, confirmation number) but never the guest's name,
 * phone or address. The destination address is the only personal datum that
 * may reach a log, and only because it is the address we just wrote to.
 */

export type NotificationData = {
  orderNo?: string;
  guestEmail?: string;
  guestPhone?: string;
  hotelName?: string;
  checkIn?: string;
  checkOut?: string;
  confirmationNumber?: string;
  totalAmount?: number;
  currency?: string;
  reason?: string;
  channel?: string;
  attempts?: number;
  error?: string;
};

export type RenderedMessage = {
  subject: string;
  body: string;
};

/** Places a payload may hide the interesting bits in. */
const NESTED_KEYS = ['booking', 'order', 'guest', 'payment', 'escalation', 'data'] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function findText(sources: readonly Record<string, unknown>[], keys: readonly string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const text = asText(source[key]);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

function findNumber(sources: readonly Record<string, unknown>[], keys: readonly string[]): number | undefined {
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
  }
  return undefined;
}

/**
 * Pull the fields we render out of a payload. Producers differ (booking,
 * payment, supplier) so we look at the top level first and then at the
 * well known nested objects.
 */
export function extractNotificationData(payload: Record<string, unknown>): NotificationData {
  const sources: Record<string, unknown>[] = [payload];
  for (const key of NESTED_KEYS) {
    const nested = asRecord(payload[key]);
    if (nested) sources.push(nested);
  }

  const data: NotificationData = {};

  const orderNo = findText(sources, ['orderNo', 'order_no', 'orderNumber']);
  if (orderNo !== undefined) data.orderNo = orderNo;

  const guestEmail = findText(sources, ['guestEmail', 'guest_email', 'email']);
  if (guestEmail !== undefined) data.guestEmail = guestEmail;

  const guestPhone = findText(sources, ['guestPhone', 'guest_phone', 'phone', 'mobile']);
  if (guestPhone !== undefined) data.guestPhone = guestPhone;

  const hotelName = findText(sources, ['hotelName', 'hotel_name', 'hotel']);
  if (hotelName !== undefined) data.hotelName = hotelName;

  const checkIn = findText(sources, ['checkIn', 'check_in']);
  if (checkIn !== undefined) data.checkIn = checkIn;

  const checkOut = findText(sources, ['checkOut', 'check_out']);
  if (checkOut !== undefined) data.checkOut = checkOut;

  const confirmationNumber = findText(sources, [
    'confirmationNumber',
    'confirmation_number',
    'confirmationNo',
  ]);
  if (confirmationNumber !== undefined) data.confirmationNumber = confirmationNumber;

  const totalAmount = findNumber(sources, ['totalAmount', 'total_amount', 'amount']);
  if (totalAmount !== undefined) data.totalAmount = totalAmount;

  const currency = findText(sources, ['currency']);
  if (currency !== undefined) data.currency = currency;

  const reason = findText(sources, ['reason', 'failureReason', 'error', 'message']);
  if (reason !== undefined) data.reason = reason;

  const channel = findText(sources, ['channel']);
  if (channel !== undefined) data.channel = channel;

  const attempts = findNumber(sources, ['attempts']);
  if (attempts !== undefined) data.attempts = attempts;

  const error = findText(sources, ['error', 'lastError']);
  if (error !== undefined) data.error = error;

  return data;
}

const TOPIC_SUBJECTS: Record<string, string> = {
  'booking.created': 'Order {order} created',
  'booking.paid': 'Order {order} paid',
  'booking.processing': 'Order {order} — confirmation in progress',
  'booking.confirmed': 'Order {order} confirmed',
  'booking.failed': 'Order {order} failed',
  'booking.cancelled': 'Order {order} cancelled',
  'booking.refunded': 'Order {order} refunded',
  'payment.failed': 'Payment failed for order {order}',
  'supplier.degraded': 'Supplier degraded — order {order}',
  'notification.escalated': 'Notification escalated — order {order}',
};

function renderTopic(topic: string, data: NotificationData): string[] {
  const hotel = data.hotelName ? ` at ${data.hotelName}` : '';
  const stay = data.checkIn && data.checkOut ? ` (${data.checkIn} → ${data.checkOut})` : '';
  const reason = data.reason ? `: ${data.reason}` : '';

  switch (topic) {
    case 'booking.created':
      return [
        `We received your booking${hotel}${stay}.`,
        'Payment is pending — complete it to confirm the room.',
      ];
    case 'booking.paid':
      return [
        `Payment received for your booking${hotel}${stay}.`,
        'We are now requesting the room from the supplier.',
      ];
    case 'booking.processing':
      return [
        `Your booking${hotel}${stay} is being confirmed.`,
        'We will write to you as soon as the room is secured.',
      ];
    case 'booking.confirmed':
      return [
        `Your booking${hotel}${stay} is confirmed.`,
        data.confirmationNumber
          ? `Confirmation number: ${data.confirmationNumber}.`
          : 'Your confirmation number will follow shortly.',
      ];
    case 'booking.failed':
      return [
        `We could not complete your booking${hotel}${stay}${reason}.`,
        'If you were charged, a full refund is on its way.',
      ];
    case 'booking.cancelled':
      return [`Your booking${hotel}${stay} has been cancelled${reason}.`];
    case 'booking.refunded':
      return [`The refund for your booking${hotel} has been processed${reason}.`];
    case 'payment.failed':
      return [
        `The payment for your booking${hotel} did not go through${reason}.`,
        'Please try again with another payment method.',
      ];
    case 'supplier.degraded':
      return [
        `We are experiencing delays with our supplier${hotel}${stay}${reason}.`,
        'Your booking is still being handled — no action is needed from you.',
      ];
    case 'notification.escalated':
      return [
        `Notification channel ${data.channel ?? 'unknown'} exhausted its retry budget${reason}.`,
        `Failed attempts: ${data.attempts ?? 0}. The operations team has been notified.`,
      ];
    default:
      return [`There is an update on your booking${hotel}${stay}${reason}.`];
  }
}

/**
 * Render one event. Every rendered body names the order, whatever the topic:
 * ops and the customer both need to be able to find the order.
 */
export function renderMessage(topic: string, payload: Record<string, unknown>): RenderedMessage {
  const data = extractNotificationData(payload);
  const order = data.orderNo ?? 'unknown order';
  const subject = (TOPIC_SUBJECTS[topic] ?? 'Update on order {order}').replace('{order}', order);
  const body = [...renderTopic(topic, data), `Order: ${order}`].join('\n');
  return { subject, body };
}

/** SMS bodies are short: one line, hard capped. */
export const SMS_MAX_LENGTH = 160;

export function renderSmsMessage(topic: string, payload: Record<string, unknown>): string {
  const { subject } = renderMessage(topic, payload);
  const text = `${subject}. Reply STOP to opt out.`;
  if (text.length <= SMS_MAX_LENGTH) return text;
  return `${text.slice(0, SMS_MAX_LENGTH - 3)}...`;
}
