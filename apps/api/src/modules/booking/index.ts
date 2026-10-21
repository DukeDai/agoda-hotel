import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@ota/core';
import type { AppContext } from '../../lib/context.js';
import { idempotencyKeyFrom } from '../../lib/idempotency.js';
import {
  cancelBooking,
  createBooking,
  getBooking,
  installPaymentHooks,
  payBooking,
  pollPendingBookings,
} from './service.js';

export { evaluateCancellation } from './cancellation.js';
export type { CancellationInput, CancellationOutcome } from './cancellation.js';
export {
  cancelBooking,
  createBooking,
  getBooking,
  payBooking,
  pollPendingBookings,
} from './service.js';

export interface CreateBookingInput {
  hotelId: string;
  offerId: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges?: number[];
  currency?: string;
  nationality?: string;
  guest: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };
  specialRequests?: string[];
  /**
   * The price the customer explicitly agreed to pay, in minor units.
   *
   * Required when the supplier re-priced the offer after the customer chose
   * the room: the server refuses to charge a price nobody agreed to
   * (SPEC §4.5). The amount comes from the 409 PRICE_CHANGED response.
   */
  acceptedTotal?: number;
  idempotencyKey: string;
}

export interface PayBookingInput {
  idempotencyKey: string;
  method?: string;
}

export interface CancelBookingInput {
  reason?: string;
  idempotencyKey: string;
}

/** The shape of a successful payment (docs/api-contract.md §6). */
export interface PayBookingResult {
  orderNo: string;
  status: string;
  payment: Record<string, unknown> | null;
  booking: BookingView;
}

export interface BookingView {
  id: string;
  orderNo: string;
  status: string;
  supplierStatus: string | null;
  confirmationNumber: string | null;
  hotel: Record<string, unknown>;
  stay: Record<string, unknown>;
  guest: Record<string, unknown>;
  price: Record<string, unknown>;
  items: Array<Record<string, unknown>>;
  specialRequests: string[];
  payment: Record<string, unknown> | null;
  refunds: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  [key: string]: unknown;
}

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式必须为 YYYY-MM-DD');
const childAges = z.array(z.number().int().min(0).max(17)).max(6).optional();

const createBookingSchema = z.object({
  hotelId: z.string().min(1),
  offerId: z.string().min(1),
  checkIn: localDate,
  checkOut: localDate,
  rooms: z.number().int().min(1).max(9).default(1),
  adults: z.number().int().min(1).max(16).default(2),
  childAges,
  currency: z.string().length(3).optional(),
  nationality: z.string().length(2).optional(),
  guest: z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().optional(),
  }),
  specialRequests: z.array(z.string()).max(10).optional(),
  /** Integer minor units — never a float, never a major-unit amount. */
  acceptedTotal: z.number().int().nonnegative().optional(),
});

const paySchema = z.object({
  method: z.string().optional(),
});

const cancelSchema = z.object({
  reason: z.string().max(500).optional(),
});

export async function registerBookingRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  installPaymentHooks(ctx);

  app.post(
    '/api/v1/bookings',
    {
      schema: {
        tags: ['booking'],
        description: '创建订单。必须带 Idempotency-Key。',
        headers: {
          type: 'object',
          properties: { 'idempotency-key': { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const parsed = createBookingSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', '请求参数不合法', {
          details: { issues: parsed.error.issues },
        });
      }
      const idempotencyKey = idempotencyKeyFrom(req);
      const view = await createBooking(ctx, { ...parsed.data, idempotencyKey });
      return reply.status(201).send(view);
    },
  );

  app.post(
    '/api/v1/bookings/:orderNo/pay',
    { schema: { tags: ['booking'], description: '支付订单。必须带 Idempotency-Key。' } },
    async (req) => {
      const parsed = paySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', '请求参数不合法', {
          details: { issues: parsed.error.issues },
        });
      }
      const { orderNo } = req.params as { orderNo: string };
      const idempotencyKey = idempotencyKeyFrom(req);
      const view = await payBooking(ctx, orderNo, { ...parsed.data, idempotencyKey });
      return view;
    },
  );

  app.get(
    '/api/v1/bookings/:orderNo',
    { schema: { tags: ['booking'], description: '查询订单状态。' } },
    async (req) => {
      const { orderNo } = req.params as { orderNo: string };
      return getBooking(ctx, orderNo);
    },
  );

  app.post(
    '/api/v1/bookings/:orderNo/cancel',
    { schema: { tags: ['booking'], description: '取消订单并退款。必须带 Idempotency-Key。' } },
    async (req) => {
      const parsed = cancelSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', '请求参数不合法', {
          details: { issues: parsed.error.issues },
        });
      }
      const { orderNo } = req.params as { orderNo: string };
      const idempotencyKey = idempotencyKeyFrom(req);
      return cancelBooking(ctx, orderNo, { ...parsed.data, idempotencyKey });
    },
  );
}
