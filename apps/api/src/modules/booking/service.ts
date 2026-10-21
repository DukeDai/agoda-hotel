import type { Prisma, PrismaClient } from '@prisma/client';
import {
  AppError,
  assertBookingTransition,
  fingerprintStayContext,
  isValidStay,
  localDateInZone,
  money,
  newOrderNo,
  toDTO,
  toLocalDate,
  withRetry,
} from '@ota/core';
import type { BookingStatus, Currency, Money, StayContext } from '@ota/core';
import type { SupplierGuest } from '@ota/agoda-connectivity';
import type { AppContext } from '../../lib/context.js';
import { OUTBOX_TOPICS, emitEventIdempotent } from '../../lib/outbox.js';
import {
  beginIdempotent,
  completeIdempotent,
  failIdempotent,
} from '../../lib/idempotency.js';
import { registerPaymentHooks } from '../../lib/hooks.js';
import { evaluateCancellation, type CancellationOutcome } from './cancellation.js';
import { toBookingView, type BookingWithRelations } from './views.js';
import type {
  BookingView,
  CancelBookingInput,
  CreateBookingInput,
  PayBookingInput,
  PayBookingResult,
} from './index.js';

const MAX_SUPPLIER_ATTEMPTS = 5;
const BOOKING_TIMEOUT_MINUTES = 30;

/** Actor of the audit rows this module writes. */
const SYSTEM_ACTOR = 'system';

function localDate(value: Date): string {
  return toLocalDate(value);
}

function asCurrency(value: string): Currency {
  return value as Currency;
}

const BOOKING_INCLUDE = {
  hotel: { include: { images: { orderBy: { position: 'asc' } } } },
  items: true,
  guest: true,
  payment: true,
  refunds: true,
} as const;

async function loadBooking(ctx: AppContext, orderNo: string): Promise<BookingWithRelations> {
  const booking = await ctx.prisma.booking.findUnique({
    where: { orderNo },
    include: BOOKING_INCLUDE,
  });
  if (!booking) {
    throw new AppError('NOT_FOUND', `订单 ${orderNo} 不存在`, { details: { orderNo } });
  }
  return booking;
}

async function loadBookingById(ctx: AppContext, id: string): Promise<BookingWithRelations> {
  const booking = await ctx.prisma.booking.findUnique({
    where: { id },
    include: BOOKING_INCLUDE,
  });
  if (!booking) {
    throw new AppError('NOT_FOUND', `订单 ${id} 不存在`);
  }
  return booking;
}

function stayContextOf(booking: BookingWithRelations): StayContext {
  return {
    supplierHotelId: booking.hotel.supplierHotelId,
    checkIn: localDate(booking.checkIn),
    checkOut: localDate(booking.checkOut),
    rooms: booking.rooms,
    adults: booking.adults,
    childAges: booking.childAges,
    currency: asCurrency(booking.currency),
    nationality: booking.nationality,
  };
}

/**
 * The fields a notification needs in order to have a destination and to be
 * worth reading. Without them the outbox events carry no address and the
 * customer channels silently have nothing to deliver to.
 */
function notificationContext(booking: BookingWithRelations): Record<string, unknown> {
  const lead = booking.guest.find((g) => g.isLead) ?? booking.guest[0];
  return {
    orderNo: booking.orderNo,
    guestEmail: lead?.email ?? booking.guestEmail,
    guestPhone: lead?.phone ?? booking.guestPhone ?? undefined,
    guestName: `${lead?.firstName ?? booking.guestFirstName} ${lead?.lastName ?? booking.guestLastName}`,
    hotelName: booking.hotel.name,
    checkIn: localDate(booking.checkIn),
    checkOut: localDate(booking.checkOut),
    nights: booking.nights,
    rooms: booking.rooms,
    currency: booking.currency,
    totalAmount: booking.totalAmount,
  };
}

// --- State machine & operations reporting ------------------------------------

/**
 * Move a booking to a new status.
 *
 * Two layers of protection:
 *  1. the transition is asserted against the state machine — an illegal move
 *     is a programming error and must never reach the database;
 *  2. the UPDATE itself is guarded by the current status, so two concurrent
 *     writers (the poller and an operator request, say) cannot both move the
 *     same order forward.
 */
async function changeStatus(
  tx: Prisma.TransactionClient,
  bookingId: string,
  change: {
    from: BookingStatus;
    to: BookingStatus;
    /** Extra columns written together with the status. */
    data?: Prisma.BookingUncheckedUpdateInput;
    eventType: string;
    eventData?: Prisma.InputJsonValue;
  },
): Promise<void> {
  assertBookingTransition(change.from, change.to);

  const updated = await tx.booking.updateMany({
    where: { id: bookingId, status: change.from },
    data: { ...change.data, status: change.to },
  });
  if (updated.count === 0) {
    throw new AppError('INVALID_STATE', `订单状态已变化，无法从 ${change.from} 变更为 ${change.to}`, {
      details: { bookingId, from: change.from, to: change.to },
    });
  }

  await tx.bookingEvent.create({
    data: {
      bookingId,
      type: change.eventType,
      fromStatus: change.from,
      toStatus: change.to,
      ...(change.eventData !== undefined ? { data: change.eventData } : {}),
    },
  });
}

/**
 * SPEC §6.3 — automatic re-report.
 *
 * A failure that needs a human must leave an OPERATIONS-VISIBLE record: an
 * outbox event AND an audit log row, written in the same transaction as the
 * state change. A line in the log file is not a report — nobody reads it.
 */
async function reportToOps(
  tx: Prisma.TransactionClient | PrismaClient,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    meta?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actor: SYSTEM_ACTOR,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    },
  });
}

// --- Create -----------------------------------------------------------------

export async function createBooking(ctx: AppContext, input: CreateBookingInput): Promise<BookingView> {
  if (!isValidStay(input.checkIn, input.checkOut)) {
    throw new AppError('VALIDATION_ERROR', '离店日期必须晚于入住日期', {
      details: { checkIn: input.checkIn, checkOut: input.checkOut },
    });
  }
  if (!input.guest?.email || !input.guest?.firstName || !input.guest?.lastName) {
    throw new AppError('VALIDATION_ERROR', '客人姓名与邮箱为必填项');
  }

  const hotel = await ctx.prisma.hotel.findFirst({
    where: { OR: [{ id: input.hotelId }, { slug: input.hotelId }] },
  });
  if (!hotel) {
    throw new AppError('HOTEL_NOT_FOUND', '酒店不存在或尚未同步', { details: { hotelId: input.hotelId } });
  }

  const childAges = input.childAges ?? [];
  const currency = asCurrency(input.currency ?? 'CNY');
  const nationality = (input.nationality ?? 'CN').toUpperCase();

  const stayContext: StayContext = {
    supplierHotelId: hotel.supplierHotelId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    rooms: input.rooms,
    adults: input.adults,
    childAges,
    currency,
    nationality,
  };
  const contextFingerprint = fingerprintStayContext(stayContext);

  // The quote is the contract with the supplier. It must exist, still be
  // valid, and describe exactly the stay we are about to book.
  // `createdAt desc` matters: a supplier may re-issue the same offer for a
  // new stay, and the freshest row is the one that reflects the current price.
  const quote = await ctx.prisma.availabilityQuote.findFirst({
    where: { offerId: input.offerId, hotelId: hotel.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!quote) {
    throw new AppError('VALIDATION_ERROR', '报价不存在或已失效，请重新选择房型', {
      details: { offerId: input.offerId },
    });
  }
  if (quote.expiresAt.getTime() < ctx.now().getTime()) {
    throw new AppError('VALIDATION_ERROR', '报价已过期，请重新选择房型', {
      details: { offerId: input.offerId, expiredAt: quote.expiresAt.toISOString() },
    });
  }
  if (quote.contextFingerprint !== contextFingerprint) {
    throw new AppError('VALIDATION_ERROR', '入住信息与报价不一致，请重新选择房型', {
      details: {
        offerId: input.offerId,
        expected: quote.contextFingerprint,
        actual: contextFingerprint,
      },
    });
  }

  // SPEC §4.5 — a price increase must be confirmed BY THE CUSTOMER, on the
  // server. The precheck marks the quote when the supplier re-priced it
  // after the customer chose the room; until the customer accepts that
  // amount we refuse to create the order. Charging a price nobody agreed to
  // is not acceptable, no matter how good the frontend is.
  const pendingTotal = quote.pendingTotalAmount;
  if (pendingTotal !== null && pendingTotal !== undefined) {
    if (input.acceptedTotal === undefined || input.acceptedTotal !== pendingTotal) {
      throw new AppError('PRICE_CHANGED', '价格已变动，请确认最新价格后继续下单', {
        details: {
          offerId: input.offerId,
          expected: pendingTotal,
          actual: input.acceptedTotal ?? null,
          currency: quote.currency,
        },
      });
    }
  }

  const replay = await beginIdempotent({
    prisma: ctx.prisma,
    key: input.idempotencyKey,
    scope: 'booking:create',
    request: input,
  });
  if (replay) {
    return replay.body as BookingView;
  }

  try {
    const now = ctx.now();
    const orderNo = newOrderNo(now);
    const created = await ctx.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.create({
        data: {
          orderNo,
          hotelId: hotel.id,
          status: 'PENDING_PAYMENT',
          checkIn: new Date(`${input.checkIn}T00:00:00.000Z`),
          checkOut: new Date(`${input.checkOut}T00:00:00.000Z`),
          nights: quote.nights,
          rooms: input.rooms,
          adults: input.adults,
          childAges,
          currency,
          nationality,
          contextFingerprint,
          netAmount: quote.netAmount,
          taxAmount: quote.taxAmount,
          totalAmount: quote.totalAmount,
          // Null when the price never moved — then no confirmation was needed.
          acceptedTotalAmount: pendingTotal ?? null,
          guestFirstName: input.guest.firstName,
          guestLastName: input.guest.lastName,
          guestEmail: input.guest.email,
          guestPhone: input.guest.phone ?? null,
          specialRequests: input.specialRequests ?? [],
          quoteId: quote.id,
          offerId: input.offerId,
          paymentExpiresAt: new Date(now.getTime() + 30 * 60 * 1000),
        },
      });

      await tx.bookingItem.create({
        data: {
          bookingId: booking.id,
          roomTypeId: quote.roomTypeId,
          ratePlanId: quote.ratePlanId,
          offerId: input.offerId,
          roomTypeName: await roomTypeName(ctx, quote.roomTypeId),
          ratePlanName: await ratePlanName(ctx, quote.ratePlanId),
          bedType: await bedTypeOf(ctx, quote.roomTypeId),
          nights: quote.nights,
          netAmount: quote.netAmount,
          taxAmount: quote.taxAmount,
          totalAmount: quote.totalAmount,
          nightlyTotal: quote.nightlyTotal,
          mealPlan: quote.mealPlan,
          payAtHotel: quote.payAtHotel,
          cancellationType: quote.cancellationType,
          freeCancellationUntil: quote.freeCancellationUntil,
          penaltyAmount: quote.penaltyAmount,
          penaltyPercent: quote.penaltyPercent,
          cancellationText: quote.cancellationText,
        },
      });

      await tx.bookingGuest.create({
        data: {
          bookingId: booking.id,
          firstName: input.guest.firstName,
          lastName: input.guest.lastName,
          email: input.guest.email,
          phone: input.guest.phone ?? null,
          nationality,
          isLead: true,
        },
      });

      await tx.payment.create({
        data: {
          bookingId: booking.id,
          provider: ctx.payment.name,
          idempotencyKey: `pay:${booking.id}`,
          status: 'PENDING',
          amount: quote.totalAmount,
          currency,
        },
      });

      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          type: 'created',
          toStatus: 'PENDING_PAYMENT',
          data: { orderNo, offerId: input.offerId, contextFingerprint },
        },
      });

      await emitEventIdempotent(tx, {
        topic: OUTBOX_TOPICS.BOOKING_CREATED,
        aggregateType: 'booking',
        aggregateId: booking.id,
        payload: {
          // Built from the values we just wrote: reading the row back here
          // would not see it, the transaction has not committed yet.
          orderNo,
          bookingId: booking.id,
          hotelId: hotel.id,
          guestEmail: input.guest.email,
          guestPhone: input.guest.phone,
          guestName: `${input.guest.firstName} ${input.guest.lastName}`,
          hotelName: hotel.name,
          checkIn: input.checkIn,
          checkOut: input.checkOut,
          nights: quote.nights,
          rooms: input.rooms,
          currency,
          totalAmount: quote.totalAmount,
          total: quote.totalAmount,
        },
        dedupeKey: `booking-created:${booking.id}`,
      });

      return booking;
    });

    const view = toBookingView(await loadBookingById(ctx, created.id));
    await completeIdempotent(ctx.prisma, input.idempotencyKey, 201, view);
    return view;
  } catch (err) {
    await failIdempotent(ctx.prisma, input.idempotencyKey, err instanceof Error ? err.message : 'error');
    throw err;
  }
}

// --- Pay --------------------------------------------------------------------

export async function payBooking(
  ctx: AppContext,
  orderNo: string,
  input: PayBookingInput,
): Promise<PayBookingResult> {
  const booking = await loadBooking(ctx, orderNo);

  // The idempotency record is opened BEFORE the state check: a client that
  // retries the same payment with a different body must get a conflict, not
  // a cheerful "already paid" answer.
  const replay = await beginIdempotent({
    prisma: ctx.prisma,
    key: input.idempotencyKey,
    scope: `booking:pay:${orderNo}`,
    request: { orderNo, method: input.method ?? null },
  });
  if (replay) {
    return replay.body as PayBookingResult;
  }

  try {
    if (booking.status !== 'PENDING_PAYMENT') {
      // Already paid: return the current state instead of charging twice.
      if (['PAID', 'BOOKING_SUBMITTED', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'].includes(booking.status)) {
        const view = toBookingView(booking);
        const result: PayBookingResult = {
          orderNo: view.orderNo,
          status: view.status,
          payment: view.payment,
          booking: view,
        };
        await completeIdempotent(ctx.prisma, input.idempotencyKey, 200, result);
        return result;
      }
      throw new AppError('INVALID_STATE', `订单当前状态为 ${booking.status}，无法支付`, {
        details: { orderNo, status: booking.status },
      });
    }

    if (!booking.payment) {
      throw new AppError('INTERNAL_ERROR', '订单缺少支付记录', { details: { orderNo } });
    }

    const amount: Money = {
      amount: booking.totalAmount,
      currency: asCurrency(booking.currency),
    };

    const intent = await ctx.payment.createPayment({
      bookingId: booking.id,
      orderNo,
      amount,
      currency: asCurrency(booking.currency),
      idempotencyKey: input.idempotencyKey,
      guestEmail: booking.guestEmail,
      description: `酒店订单 ${orderNo}`,
      method: input.method,
    } as Parameters<typeof ctx.payment.createPayment>[0]);

    await ctx.prisma.payment.update({
      where: { id: booking.payment.id },
      data: { providerPaymentId: intent.providerPaymentId, status: 'PENDING' },
    });

    const capture = await ctx.payment.capturePayment({
      providerPaymentId: intent.providerPaymentId,
      amount,
      idempotencyKey: input.idempotencyKey,
    });

    if (capture.status !== 'SUCCEEDED') {
      await ctx.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: booking.payment!.id },
          data: {
            status: 'FAILED',
            failureCode: capture.failureCode ?? 'capture_failed',
            failureMessage: capture.failureMessage ?? '支付失败',
          },
        });
        await tx.bookingEvent.create({
          data: { bookingId: booking.id, type: 'payment_failed', data: { message: capture.failureMessage } },
        });
        await emitEventIdempotent(tx, {
          topic: OUTBOX_TOPICS.PAYMENT_FAILED,
          aggregateType: 'booking',
          aggregateId: booking.id,
          payload: {
            ...notificationContext(booking),
            message: capture.failureMessage ?? '支付失败',
          },
          dedupeKey: `payment-failed:${booking.id}:${input.idempotencyKey}`,
        });
      });
      throw new AppError('PAYMENT_FAILED', capture.failureMessage ?? '支付失败', {
        details: { orderNo, failureCode: capture.failureCode },
      });
    }

    const now = ctx.now();
    // The status change and the "customer paid" event are one transaction:
    // an order that is PAID without an event would never notify anybody.
    await ctx.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: booking.payment!.id },
        data: {
          status: 'CAPTURED',
          capturedAmount: amount.amount,
          paidAt: now,
          method: input.method ?? 'mock_card',
        },
      });
      await changeStatus(tx, booking.id, {
        from: 'PENDING_PAYMENT',
        to: 'PAID',
        data: { paidAmount: amount.amount },
        eventType: 'paid',
      });
      await emitEventIdempotent(tx, {
        topic: OUTBOX_TOPICS.BOOKING_PAID,
        aggregateType: 'booking',
        aggregateId: booking.id,
        payload: {
          ...notificationContext(booking),
          amount: amount.amount,
          currency: amount.currency,
        },
        dedupeKey: `booking-paid:${booking.id}`,
      });
    });

    // The supplier call happens OUTSIDE any transaction: a 120 second
    // network call must never hold a database transaction open.
    await submitToSupplier(ctx, booking.id);

    const view = toBookingView(await loadBooking(ctx, orderNo));
    const result: PayBookingResult = {
      orderNo: view.orderNo,
      status: view.status,
      payment: view.payment,
      booking: view,
    };
    await completeIdempotent(ctx.prisma, input.idempotencyKey, 200, result);
    return result;
  } catch (err) {
    await failIdempotent(ctx.prisma, input.idempotencyKey, err instanceof Error ? err.message : 'error');
    throw err;
  }
}

// --- Supplier submission ------------------------------------------------------

async function submitToSupplier(ctx: AppContext, bookingId: string): Promise<void> {
  const booking = await loadBookingById(ctx, bookingId);
  if (!['PAID', 'BOOKING_SUBMITTED'].includes(booking.status)) return;

  const stayContext = stayContextOf(booking);
  const fingerprint = fingerprintStayContext(stayContext);
  if (booking.contextFingerprint !== fingerprint) {
    await failBooking(ctx, booking, 'INVALID_STATE', '入住参数与报价不一致，已拒绝下单');
    return;
  }

  const item = booking.items[0];
  if (!item) {
    await failBooking(ctx, booking, 'INTERNAL_ERROR', '订单缺少房型明细');
    return;
  }

  const idempotencyKey = booking.supplierIdempotencyKey ?? `bk_${booking.id}`;
  // The move into BOOKING_SUBMITTED goes through the state machine, and the
  // attempt counter is bumped in the same transaction.
  await ctx.prisma.$transaction(async (tx) => {
    if (booking.status === 'BOOKING_SUBMITTED') {
      // A re-submission of an order that is already in flight: the status
      // does not move, only the attempt counter does.
      await tx.booking.update({
        where: { id: booking.id },
        data: {
          supplierStatus: 'PROCESSING',
          supplierIdempotencyKey: idempotencyKey,
          supplierAttempts: { increment: 1 },
          lastSupplierAttemptAt: ctx.now(),
        },
      });
      await tx.bookingEvent.create({
        data: { bookingId: booking.id, type: 'supplier_submitted', toStatus: 'BOOKING_SUBMITTED' },
      });
      return;
    }
    await changeStatus(tx, booking.id, {
      from: 'PAID',
      to: 'BOOKING_SUBMITTED',
      data: {
        supplierStatus: 'PROCESSING',
        supplierIdempotencyKey: idempotencyKey,
        supplierAttempts: { increment: 1 },
        lastSupplierAttemptAt: ctx.now(),
      },
      eventType: 'supplier_submitted',
    });
  });

  const guests: SupplierGuest[] = booking.guest.map((g) => ({
    firstName: g.firstName,
    lastName: g.lastName,
    email: g.email,
    phone: g.phone ?? undefined,
    nationality: g.nationality,
    isLead: g.isLead,
    age: g.age ?? undefined,
  }));

  try {
    const result = await ctx.supplier.book({
      supplierHotelId: booking.hotel.supplierHotelId,
      offerId: item.offerId,
      checkIn: stayContext.checkIn,
      checkOut: stayContext.checkOut,
      rooms: stayContext.rooms,
      adults: stayContext.adults,
      childAges: stayContext.childAges,
      currency: stayContext.currency,
      nationality: stayContext.nationality,
      guests,
      specialRequests: booking.specialRequests,
      // We deliberately allow a duplicate-looking booking: the guest may
      // legitimately book the same hotel twice. The supplier may still flag
      // it, and we handle that as an explicit error.
      allowDuplication: true,
      idempotencyKey,
      contextFingerprint: fingerprint,
      expectedTotal: { amount: booking.totalAmount, currency: stayContext.currency },
    });

    if (result.status === 'CONFIRMED' && !result.processing) {
      await confirmBooking(ctx, booking.id, result.confirmationNumber ?? null, result.supplierBookingId);
      return;
    }

    if (result.processing || result.status === 'PROCESSING') {
      // Not confirmed yet. The booking stays BOOKING_SUBMITTED and the
      // poller keeps checking until the supplier settles it.
      await ctx.prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            supplierBookingId: result.supplierBookingId,
            supplierStatus: 'PROCESSING',
          },
        });
        await emitEventIdempotent(tx, {
          topic: OUTBOX_TOPICS.BOOKING_PROCESSING,
          aggregateType: 'booking',
          aggregateId: booking.id,
          payload: {
            ...notificationContext(booking),
            supplierBookingId: result.supplierBookingId,
          },
          dedupeKey: `booking-processing:${booking.id}`,
        });
      });
      return;
    }

    await failBookingAndRefund(
      ctx,
      booking,
      result.errorCode ?? 'BOOKING_REJECTED',
      result.errorMessage ?? '供应商拒绝了本次预订',
    );
  } catch (err) {
    await handleSupplierFailure(ctx, booking, err);
  }
}

async function handleSupplierFailure(
  ctx: AppContext,
  booking: BookingWithRelations,
  err: unknown,
): Promise<void> {
  const appError = AppError.is(err) ? err : new AppError('SUPPLIER_ERROR', String(err));

  if (appError.code === 'ROOM_UNAVAILABLE') {
    const retried = await tryAutoRequote(ctx, booking);
    if (retried) return;
    await failBookingAndRefund(ctx, booking, 'ROOM_UNAVAILABLE', appError.message);
    return;
  }

  if (appError.code === 'PRICE_CHANGED') {
    await failBookingAndRefund(ctx, booking, 'PRICE_CHANGED', appError.message);
    return;
  }

  if (appError.retryable) {
    // Transient supplier failure: keep the money, keep the order, and let
    // the poller retry with the SAME idempotency key.
    //
    // The status, the event and the report to ops are one transaction: the
    // order must not silently sit in BOOKING_SUBMITTED while everybody
    // believes the failure was recorded.
    await ctx.prisma.$transaction(async (tx) => {
      await changeStatus(tx, booking.id, {
        from: 'BOOKING_SUBMITTED',
        to: 'PAID',
        data: {
          supplierStatus: 'RETRY_SCHEDULED',
          lastErrorCode: appError.code,
          failureReason: appError.message,
        },
        eventType: 'supplier_retry_scheduled',
        eventData: { code: appError.code, message: appError.message },
      });
      await emitEventIdempotent(tx, {
        topic: OUTBOX_TOPICS.SUPPLIER_DEGRADED,
        aggregateType: 'booking',
        aggregateId: booking.id,
        payload: { ...notificationContext(booking), code: appError.code, message: appError.message },
        dedupeKey: `supplier-degraded:${booking.id}:${appError.code}`,
      });
      // SPEC §6.3: a supplier that keeps failing must leave a record an
      // operator can find, not just a log line.
      await reportToOps(tx, {
        action: 'supplier.degraded',
        entityType: 'booking',
        entityId: booking.id,
        meta: {
          orderNo: booking.orderNo,
          code: appError.code,
          message: appError.message,
          attempts: booking.supplierAttempts,
          status: 'PAID',
        },
      });
    });
    ctx.logger.warn('supplier booking failed, will retry', { err: appError, orderNo: booking.orderNo });
    return;
  }

  await failBookingAndRefund(ctx, booking, appError.code, appError.message);
}

/**
 * "The room sold out between the quote and the booking" recovery.
 * We re-price the same room type once. If the price is unchanged we place
 * the booking automatically; if the price moved we stop and refund, because
 * silently charging a different amount is not acceptable.
 */
async function tryAutoRequote(ctx: AppContext, booking: BookingWithRelations): Promise<boolean> {
  if (booking.autoRequoteUsed) return false;

  const updated = await ctx.prisma.booking.update({
    where: { id: booking.id },
    data: { autoRequoteUsed: true },
  });
  void updated;

  const stayContext = stayContextOf(booking);
  try {
    const availability = await ctx.supplier.getAvailability({
      destination: { name: booking.hotel.city, countryCode: booking.hotel.countryCode },
      checkIn: stayContext.checkIn,
      checkOut: stayContext.checkOut,
      rooms: stayContext.rooms,
      adults: stayContext.adults,
      childAges: stayContext.childAges,
      currency: stayContext.currency,
      nationality: stayContext.nationality,
      hotelIds: [booking.hotel.supplierHotelId],
    });

    const item = booking.items[0];
    const supplierRoomTypeId = item?.roomTypeId
      ? ((await ctx.prisma.roomType.findUnique({ where: { id: item.roomTypeId } }))?.supplierRoomTypeId ??
        undefined)
      : undefined;

    const quotes = availability.flatMap((a) => a.quotes);
    const replacement = quotes.find((q) =>
      supplierRoomTypeId ? q.roomTypeId === supplierRoomTypeId : q.offerId === item?.offerId,
    );
    if (!replacement) return false;

    if (replacement.stayTotal.total.amount !== booking.totalAmount) {
      ctx.logger.warn('price changed during auto re-quote; refusing to auto-book', {
        orderNo: booking.orderNo,
        expected: booking.totalAmount,
        actual: replacement.stayTotal.total.amount,
      });
      return false;
    }

    await ctx.prisma.bookingItem.updateMany({
      where: { bookingId: booking.id },
      data: { offerId: replacement.offerId },
    });
    await ctx.prisma.booking.update({
      where: { id: booking.id },
      data: { offerId: replacement.offerId },
    });
    await ctx.prisma.bookingEvent.create({
      data: { bookingId: booking.id, type: 'auto_requoted', data: { offerId: replacement.offerId } },
    });

    await submitToSupplier(ctx, booking.id);
    return true;
  } catch (err) {
    ctx.logger.warn('auto re-quote failed', { err, orderNo: booking.orderNo });
    return false;
  }
}

async function confirmBooking(
  ctx: AppContext,
  bookingId: string,
  confirmationNumber: string | null,
  supplierBookingId: string | undefined,
): Promise<void> {
  const now = ctx.now();
  // Read the order BEFORE the transaction: the notification payload is built
  // from the guest and hotel, and the confirmation must be published in the
  // same transaction as the status change.
  const booking = await loadBookingById(ctx, bookingId);

  await ctx.prisma.$transaction(async (tx) => {
    await changeStatus(tx, bookingId, {
      from: 'BOOKING_SUBMITTED',
      to: 'CONFIRMED',
      data: {
        supplierStatus: 'CONFIRMED',
        confirmationNumber,
        ...(supplierBookingId ? { supplierBookingId } : {}),
        confirmedAt: now,
      },
      eventType: 'confirmed',
      eventData: { confirmationNumber },
    });
    await emitEventIdempotent(tx, {
      topic: OUTBOX_TOPICS.BOOKING_CONFIRMED,
      aggregateType: 'booking',
      aggregateId: bookingId,
      payload: {
        ...notificationContext(booking),
        confirmationNumber,
      },
      dedupeKey: `booking-confirmed:${bookingId}`,
    });
  });
}

async function failBooking(
  ctx: AppContext,
  booking: BookingWithRelations,
  code: string,
  message: string,
): Promise<void> {
  await ctx.prisma.$transaction(async (tx) => {
    // Read the status inside the transaction: the order may have moved since
    // it was loaded (the poller and a request can race), and failing an
    // order that is already failed must be a no-op, not an error.
    const current = await tx.booking.findUnique({
      where: { id: booking.id },
      select: { status: true },
    });
    const from = (current?.status ?? booking.status) as BookingStatus;
    if (from === 'FAILED') return;

    await changeStatus(tx, booking.id, {
      from,
      to: 'FAILED',
      data: {
        supplierStatus: 'REJECTED',
        supplierErrorCode: code,
        supplierErrorMessage: message,
        failureReason: message,
      },
      eventType: 'failed',
      eventData: { code, message },
    });
    await emitEventIdempotent(tx, {
      topic: OUTBOX_TOPICS.BOOKING_FAILED,
      aggregateType: 'booking',
      aggregateId: booking.id,
      payload: { ...notificationContext(booking), code, message },
      dedupeKey: `booking-failed:${booking.id}:${code}`,
    });
    // SPEC §6.3: a failed booking must be visible to operations, not only
    // in the log file.
    await reportToOps(tx, {
      action: 'booking.failed',
      entityType: 'booking',
      entityId: booking.id,
      meta: { orderNo: booking.orderNo, code, message },
    });
  });
}

/**
 * A booking that cannot be fulfilled must never keep the customer's money.
 * The refund is a first-class, idempotent record — not a side effect.
 */
async function failBookingAndRefund(
  ctx: AppContext,
  booking: BookingWithRelations,
  code: string,
  message: string,
): Promise<void> {
  await failBooking(ctx, booking, code, message);
  await autoRefund(ctx, booking.id, `booking_failed:${code}`);
}

async function autoRefund(ctx: AppContext, bookingId: string, reason: string): Promise<void> {
  const booking = await loadBookingById(ctx, bookingId);
  if (!booking.payment?.providerPaymentId) return;

  const outstanding = booking.paidAmount - booking.refundedAmount;
  if (outstanding <= 0) return;

  const existing = await ctx.prisma.refund.findFirst({
    where: { bookingId, status: 'PENDING' },
  });
  if (existing) return;

  const amount: Money = { amount: outstanding, currency: asCurrency(booking.currency) };
  const refund = await ctx.prisma.refund.create({
    data: {
      paymentId: booking.payment.id,
      bookingId,
      idempotencyKey: `auto-refund:${bookingId}:${reason}`,
      status: 'PENDING',
      amount: amount.amount,
      currency: booking.currency,
      reason,
    },
  });

  try {
    const result = await ctx.payment.refund({
      providerPaymentId: booking.payment.providerPaymentId,
      amount,
      reason,
      idempotencyKey: refund.idempotencyKey,
    });
    if (result.status === 'SUCCEEDED') {
      await ctx.prisma.$transaction(async (tx) => {
        await tx.refund.update({
          where: { id: refund.id },
          data: { status: 'SUCCEEDED', succeededAt: ctx.now(), providerRefundId: result.providerRefundId },
        });
        const current = await tx.booking.findUnique({
          where: { id: bookingId },
          select: { status: true },
        });
        const from = (current?.status ?? 'REFUND_PENDING') as BookingStatus;
        if (from !== 'REFUNDED') {
          await changeStatus(tx, bookingId, {
            from,
            to: 'REFUNDED',
            data: {
              refundedAmount: { increment: amount.amount },
              refundedAt: ctx.now(),
            },
            eventType: 'refunded',
            eventData: { amount: amount.amount, reason },
          });
        }
        await tx.payment.update({ where: { id: booking.payment!.id }, data: { status: 'REFUNDED' } });
        await emitEventIdempotent(tx, {
          topic: OUTBOX_TOPICS.BOOKING_REFUNDED,
          aggregateType: 'booking',
          aggregateId: bookingId,
          payload: {
            ...notificationContext(booking),
            amount: amount.amount,
            currency: booking.currency,
            reason,
          },
          dedupeKey: `booking-refunded:${bookingId}:${reason}`,
        });
        // SPEC §6.3: "paid but the booking failed" must leave an operations
        // record — this is the case where the customer got money back
        // without a room, and somebody has to follow it up.
        if (reason.startsWith('booking_failed')) {
          await reportToOps(tx, {
            action: 'booking.auto_refund',
            entityType: 'booking',
            entityId: bookingId,
            meta: {
              orderNo: booking.orderNo,
              reason,
              amount: amount.amount,
              currency: booking.currency,
            },
          });
        }
      });
    } else {
      await ctx.prisma.refund.update({
        where: { id: refund.id },
        data: { status: 'FAILED', lastError: result.failureMessage ?? 'refund_failed' },
      });
      ctx.logger.error('auto refund failed', { orderNo: booking.orderNo, refundId: refund.id });
    }
  } catch (err) {
    await ctx.prisma.refund.update({
      where: { id: refund.id },
      data: { attempts: { increment: 1 }, lastError: err instanceof Error ? err.message : 'refund_error' },
    });
    ctx.logger.error('auto refund raised, will retry', { err, orderNo: booking.orderNo });
  }
}

// --- Cancel ------------------------------------------------------------------

export interface CancelBookingResult {
  booking: BookingView;
  cancellation: {
    cancelled: boolean;
    penaltyAmount: ReturnType<typeof import('@ota/core').toDTO>;
    refundAmount: ReturnType<typeof import('@ota/core').toDTO>;
    policyType: string;
  };
}

export async function cancelBooking(
  ctx: AppContext,
  orderNo: string,
  input: CancelBookingInput,
): Promise<CancelBookingResult> {
  const booking = await loadBooking(ctx, orderNo);

  // The idempotency record is opened FIRST: a client that retries the same
  // cancellation must get the first answer back, not "you cannot cancel an
  // already cancelled booking".
  const replay = await beginIdempotent({
    prisma: ctx.prisma,
    key: input.idempotencyKey,
    scope: `booking:cancel:${orderNo}`,
    request: { orderNo, reason: input.reason ?? null },
  });
  if (replay) {
    return replay.body as CancelBookingResult;
  }

  try {
    if (['CANCELLED', 'REFUNDED', 'EXPIRED', 'FAILED', 'CHECKED_OUT'].includes(booking.status)) {
      throw new AppError('CANCEL_NOT_ALLOWED', `订单当前状态为 ${booking.status}，无法取消`, {
        details: { orderNo, status: booking.status },
      });
    }

    const item = booking.items[0];
    const policyType = (item?.cancellationType ?? 'NON_REFUNDABLE') as CancellationOutcome['policyType'];

    // An order that was never paid for holds no room at the supplier and no
    // money of ours: cancelling it is a local state change, not a refund.
    if (booking.status === 'PENDING_PAYMENT') {
      const cancelledAt = ctx.now();
      await ctx.prisma.$transaction(async (tx) => {
        await changeStatus(tx, booking.id, {
          from: 'PENDING_PAYMENT',
          to: 'CANCELLED',
          data: { cancelledAt },
          eventType: 'cancellation_requested',
          eventData: { reason: input.reason ?? null, policyType },
        });
        await emitEventIdempotent(tx, {
          topic: OUTBOX_TOPICS.BOOKING_CANCELLED,
          aggregateType: 'booking',
          aggregateId: booking.id,
          payload: {
            ...notificationContext(booking),
            policyType,
            penaltyAmount: 0,
            refundAmount: 0,
            currency: booking.currency,
          },
          dedupeKey: `booking-cancelled:${booking.id}`,
        });
      });
      const zeroMoney = toDTO(money(0, asCurrency(booking.currency)));
      const result: CancelBookingResult = {
        booking: toBookingView(await loadBooking(ctx, orderNo)),
        cancellation: {
          cancelled: true,
          penaltyAmount: zeroMoney,
          refundAmount: zeroMoney,
          policyType,
        },
      };
      await completeIdempotent(ctx.prisma, input.idempotencyKey, 200, result);
      return result;
    }

    const outcome: CancellationOutcome = evaluateCancellation({
      policyType,
      freeCancellationUntil: item?.freeCancellationUntil ? localDate(item.freeCancellationUntil) : null,
      penaltyAmount: item?.penaltyAmount ?? null,
      penaltyPercent: item?.penaltyPercent ?? null,
      totalAmount: booking.paidAmount || booking.totalAmount,
      currency: asCurrency(booking.currency),
      // SPEC §3.5: the deadline is a date on the PROPERTY's wall clock. In
      // Bangkok it is already tomorrow while it is still today in Europe —
      // deciding that in UTC would refuse free cancellations for seven
      // hours every single day.
      today: localDateInZone(ctx.now(), booking.hotel.timeZone ?? undefined),
      checkIn: localDate(booking.checkIn),
      policyDescription: item?.cancellationText ?? null,
    });

    if (!outcome.allowed) {
      throw new AppError('CANCEL_NOT_ALLOWED', outcome.message, {
        details: {
          orderNo,
          policyType: outcome.policyType,
          policyDescription: item?.cancellationText ?? outcome.message,
          reason: outcome.reason,
        },
      });
    }

    // Release the room at the supplier first, so we never refund a room we
    // still hold. A non-retryable supplier failure is recorded but does not
    // block the customer from getting their money back.
    //
    // The cancel IS retried on transient failures (429 / timeout / 5xx):
    // it is idempotent on the supplier side (same idempotency key), and
    // failing the customer's cancellation because of a throttle would be a
    // self-inflicted wound.
    if (booking.supplierBookingId) {
      try {
        await withRetry(
          () =>
            ctx.supplier.cancel({
              supplierBookingId: booking.supplierBookingId!,
              reason: input.reason,
              idempotencyKey: `cancel:${booking.id}`,
            }),
          {
            attempts: 3,
            baseDelayMs: 200,
            maxDelayMs: 2_000,
            isRetryable: (err) => AppError.is(err) && err.retryable,
          },
        );
      } catch (err) {
        const appError = AppError.is(err) ? err : new AppError('SUPPLIER_ERROR', String(err));
        if (appError.retryable) {
          throw new AppError('SUPPLIER_ERROR', '供应商取消失败，请稍后重试', {
            details: { orderNo, code: appError.code },
            cause: err,
          });
        }
        ctx.logger.error('supplier cancel rejected, continuing with local cancellation', { err, orderNo });
      }
    }

    const now = ctx.now();
    // The status change and the "booking cancelled" event are one
    // transaction: a cancelled order without an event would never notify
    // the customer.
    await ctx.prisma.$transaction(async (tx) => {
      await changeStatus(tx, booking.id, {
        from: booking.status as BookingStatus,
        to: 'REFUND_PENDING',
        data: { cancelledAt: now },
        eventType: 'cancellation_requested',
        eventData: { reason: input.reason ?? null, policyType: outcome.policyType },
      });
      await emitEventIdempotent(tx, {
        topic: OUTBOX_TOPICS.BOOKING_CANCELLED,
        aggregateType: 'booking',
        aggregateId: booking.id,
        payload: {
          ...notificationContext(booking),
          policyType: outcome.policyType,
          penaltyAmount: outcome.penaltyAmount.amount,
          refundAmount: outcome.refundAmount.amount,
          currency: booking.currency,
        },
        dedupeKey: `booking-cancelled:${booking.id}`,
      });
    });

    await autoRefund(ctx, booking.id, 'customer_cancel');

    const view = toBookingView(await loadBooking(ctx, orderNo));
    const result: CancelBookingResult = {
      booking: view,
      cancellation: {
        cancelled: true,
        // toDTO knows about zero-decimal currencies — a hardcoded /100 would
        // report 100x the real amount for JPY, KRW, VND and IDR.
        penaltyAmount: toDTO(outcome.penaltyAmount),
        refundAmount: toDTO(outcome.refundAmount),
        policyType: outcome.policyType,
      },
    };
    await completeIdempotent(ctx.prisma, input.idempotencyKey, 200, result);
    return result;
  } catch (err) {
    await failIdempotent(ctx.prisma, input.idempotencyKey, err instanceof Error ? err.message : 'error');
    throw err;
  }
}

// --- Read ---------------------------------------------------------------------

export async function getBooking(ctx: AppContext, orderNo: string): Promise<BookingView> {
  return toBookingView(await loadBooking(ctx, orderNo));
}

// --- Poller -------------------------------------------------------------------

export async function pollPendingBookings(
  ctx: AppContext,
): Promise<{ checked: number; confirmed: number; failed: number }> {
  const handle = await ctx.lock.acquire('poll-pending-bookings', 55_000);
  if (!handle) {
    return { checked: 0, confirmed: 0, failed: 0 };
  }

  const result = { checked: 0, confirmed: 0, failed: 0 };
  try {
    const now = ctx.now();
    const staleBefore = new Date(now.getTime() - BOOKING_TIMEOUT_MINUTES * 60 * 1000);
    const resubmitBefore = new Date(now.getTime() - 60 * 1000);

    const candidates = await ctx.prisma.booking.findMany({
      where: {
        OR: [
          { status: 'BOOKING_SUBMITTED' },
          // A submission that failed transiently is waiting to be replayed.
          { status: 'PAID', supplierAttempts: { gt: 0 } },
          // A booking that was paid but never submitted (process crashed
          // between the two) is picked up once it is safely in the past.
          { status: 'PAID', createdAt: { lt: resubmitBefore } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    for (const candidate of candidates) {
      result.checked += 1;
      const booking = await loadBookingById(ctx, candidate.id);

      try {
        if (booking.supplierAttempts > MAX_SUPPLIER_ATTEMPTS && !booking.supplierBookingId) {
          await failBookingAndRefund(ctx, booking, 'SUPPLIER_ERROR', '多次尝试下单失败');
          result.failed += 1;
          continue;
        }

        if (booking.status === 'BOOKING_SUBMITTED') {
          const lastAttempt = booking.lastSupplierAttemptAt ?? booking.createdAt;
          if (lastAttempt.getTime() < staleBefore.getTime()) {
            await failBookingAndRefund(
              ctx,
              booking,
              'BOOKING_TIMEOUT',
              `供应商在 ${BOOKING_TIMEOUT_MINUTES} 分钟内未确认订单`,
            );
            // SPEC §6.3: "not confirmed within 30 minutes" is on the
            // operations list — a customer waiting 30 minutes for nothing
            // needs a human to look at the supplier.
            await reportToOps(ctx.prisma, {
              action: 'booking.timeout',
              entityType: 'booking',
              entityId: booking.id,
              meta: {
                orderNo: booking.orderNo,
                code: 'BOOKING_TIMEOUT',
                minutes: BOOKING_TIMEOUT_MINUTES,
                supplierBookingId: booking.supplierBookingId,
              },
            });
            result.failed += 1;
            continue;
          }

          if (booking.supplierBookingId) {
            const detail = await ctx.supplier.getBooking(booking.supplierBookingId);
            if (detail.status === 'CONFIRMED' && !detail.processing) {
              await confirmBooking(ctx, booking.id, detail.confirmationNumber ?? null, booking.supplierBookingId);
              result.confirmed += 1;
            } else if (detail.status === 'REJECTED' || detail.status === 'CANCELLED') {
              await failBookingAndRefund(
                ctx,
                booking,
                detail.errorMessage ? 'BOOKING_REJECTED' : 'BOOKING_REJECTED',
                detail.errorMessage ?? '供应商拒绝了本次预订',
              );
              result.failed += 1;
            } else {
              await ctx.prisma.booking.update({
                where: { id: booking.id },
                data: { supplierStatus: 'PROCESSING' },
              });
            }
          } else {
            // The submission never produced a booking id: retry it.
            await submitToSupplier(ctx, booking.id);
          }
        } else if (booking.status === 'PAID') {
          await submitToSupplier(ctx, booking.id);
        }
      } catch (err) {
        ctx.logger.error('booking poll cycle item failed', { err, orderNo: booking.orderNo });
      }
    }

    // Retry refunds that are still pending (e.g. the gateway was down).
    const pendingRefunds = await ctx.prisma.refund.findMany({
      where: { status: 'PENDING' },
      take: 20,
    });
    for (const pending of pendingRefunds) {
      try {
        const booking = await loadBookingById(ctx, pending.bookingId);
        if (!booking.payment?.providerPaymentId) continue;
        const result2 = await ctx.payment.refund({
          providerPaymentId: booking.payment.providerPaymentId,
          amount: { amount: pending.amount, currency: asCurrency(pending.currency) },
          reason: pending.reason ?? undefined,
          idempotencyKey: pending.idempotencyKey,
        });
        if (result2.status === 'SUCCEEDED') {
          await ctx.prisma.$transaction(async (tx) => {
            await tx.refund.update({
              where: { id: pending.id },
              data: {
                status: 'SUCCEEDED',
                succeededAt: ctx.now(),
                providerRefundId: result2.providerRefundId,
                attempts: { increment: 1 },
              },
            });
            const current = await tx.booking.findUnique({
              where: { id: pending.bookingId },
              select: { status: true },
            });
            const from = (current?.status ?? 'REFUND_PENDING') as BookingStatus;
            if (from !== 'REFUNDED') {
              await changeStatus(tx, pending.bookingId, {
                from,
                to: 'REFUNDED',
                data: {
                  refundedAmount: { increment: pending.amount },
                  refundedAt: ctx.now(),
                },
                eventType: 'refunded',
                eventData: { amount: pending.amount, reason: pending.reason ?? null },
              });
            }
            await tx.payment.update({
              where: { id: booking.payment!.id },
              data: { status: 'REFUNDED' },
            });
            await emitEventIdempotent(tx, {
              topic: OUTBOX_TOPICS.BOOKING_REFUNDED,
              aggregateType: 'booking',
              aggregateId: pending.bookingId,
              payload: {
                ...notificationContext(booking),
                amount: pending.amount,
                currency: pending.currency,
                reason: pending.reason ?? 'auto_refund',
              },
              dedupeKey: `booking-refunded:${pending.bookingId}:${pending.reason ?? 'auto_refund'}`,
            });
          });
        }
      } catch (err) {
        await ctx.prisma.refund.update({
          where: { id: pending.id },
          data: { attempts: { increment: 1 }, lastError: err instanceof Error ? err.message : 'refund_error' },
        });
      }
    }
  } finally {
    await handle.release();
  }

  return result;
}

// --- Helpers -------------------------------------------------------------------

async function roomTypeName(ctx: AppContext, roomTypeId: string | null): Promise<string> {
  if (!roomTypeId) return '标准房';
  const room = await ctx.prisma.roomType.findUnique({ where: { id: roomTypeId } });
  return room?.name ?? '标准房';
}

async function ratePlanName(ctx: AppContext, ratePlanId: string | null): Promise<string> {
  if (!ratePlanId) return '标准价';
  const plan = await ctx.prisma.ratePlan.findUnique({ where: { id: ratePlanId } });
  return plan?.name ?? '标准价';
}

async function bedTypeOf(ctx: AppContext, roomTypeId: string | null): Promise<string | null> {
  if (!roomTypeId) return null;
  const room = await ctx.prisma.roomType.findUnique({ where: { id: roomTypeId } });
  return room?.bedType ?? null;
}

/**
 * Wire the payment gateway callbacks into the booking lifecycle.
 * Registered by the module entry point; see index.ts.
 */
export function installPaymentHooks(ctx: AppContext): void {
  registerPaymentHooks({
    onPaymentSettled: async (paymentId, outcome) => {
      const payment = await ctx.prisma.payment.findUnique({ where: { id: paymentId } });
      if (!payment) return;
      const booking = await ctx.prisma.booking.findUnique({ where: { id: payment.bookingId } });
      if (!booking) return;
      if (outcome === 'failed' && booking.status === 'PENDING_PAYMENT') {
        await ctx.prisma.$transaction(async (tx) => {
          await tx.bookingEvent.create({
            data: { bookingId: booking.id, type: 'payment_failed', data: { via: 'webhook' } },
          });
          await emitEventIdempotent(tx, {
            topic: OUTBOX_TOPICS.PAYMENT_FAILED,
            aggregateType: 'booking',
            aggregateId: booking.id,
            payload: { orderNo: booking.orderNo, via: 'webhook' },
            dedupeKey: `payment-failed-webhook:${booking.id}`,
          });
        });
      }
    },
    onRefundSettled: async (refundId, outcome) => {
      const refund = await ctx.prisma.refund.findUnique({ where: { id: refundId } });
      if (!refund) return;
      if (outcome === 'succeeded') {
        const booking = await ctx.prisma.booking.findUnique({ where: { id: refund.bookingId } });
        if (booking && booking.status === 'REFUND_PENDING') {
          await ctx.prisma.$transaction(async (tx) => {
            await changeStatus(tx, booking.id, {
              from: 'REFUND_PENDING',
              to: 'REFUNDED',
              data: {
                refundedAmount: { increment: refund.amount },
                refundedAt: ctx.now(),
              },
              eventType: 'refunded',
              eventData: { amount: refund.amount, reason: refund.reason ?? null, via: 'webhook' },
            });
            await emitEventIdempotent(tx, {
              topic: OUTBOX_TOPICS.BOOKING_REFUNDED,
              aggregateType: 'booking',
              aggregateId: booking.id,
              payload: { orderNo: booking.orderNo, amount: refund.amount, currency: refund.currency },
              dedupeKey: `booking-refunded-webhook:${booking.id}`,
            });
          });
        }
      }
    },
  });
}
