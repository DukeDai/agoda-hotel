import type { Prisma } from '@prisma/client';
import { toDTO, type Money } from '@ota/core';
import type { BookingView } from './index.js';

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    hotel: { include: { images: { orderBy: { position: 'asc' } } } };
    items: true;
    guest: true;
    payment: true;
    refunds: true;
  };
}>;

function localDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  return new Date(value.getTime()).toISOString().slice(0, 10);
}

function moneyDto(value: number, currency: string): ReturnType<typeof toDTO> {
  return toDTO({ amount: value, currency: currency as Money['currency'] });
}

/**
 * Serialise a booking into the shape defined in docs/api-contract.md §7.
 * The frontend depends on this exact shape.
 */
export function toBookingView(booking: BookingWithRelations): BookingView {
  const lead = booking.guest.find((g) => g.isLead) ?? booking.guest[0];

  return {
    id: booking.id,
    orderNo: booking.orderNo,
    status: booking.status,
    supplierStatus: booking.supplierStatus,
    confirmationNumber: booking.confirmationNumber,
    hotel: {
      id: booking.hotel.id,
      slug: booking.hotel.slug,
      name: booking.hotel.name,
      starRating: booking.hotel.starRating,
      thumbnail: booking.hotel.images[0]?.url ?? null,
      address: {
        city: booking.hotel.city,
        country: booking.hotel.country,
        countryCode: booking.hotel.countryCode,
      },
    },
    stay: {
      checkIn: localDate(booking.checkIn),
      checkOut: localDate(booking.checkOut),
      nights: booking.nights,
      rooms: booking.rooms,
      adults: booking.adults,
      childAges: booking.childAges,
    },
    guest: lead
      ? {
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone: lead.phone,
        }
      : {
          firstName: booking.guestFirstName,
          lastName: booking.guestLastName,
          email: booking.guestEmail,
          phone: booking.guestPhone,
        },
    price: {
      net: moneyDto(booking.netAmount, booking.currency),
      taxes: moneyDto(booking.taxAmount, booking.currency),
      total: moneyDto(booking.totalAmount, booking.currency),
      paid: moneyDto(booking.paidAmount, booking.currency),
      refunded: moneyDto(booking.refundedAmount, booking.currency),
    },
    items: booking.items.map((item) => ({
      offerId: item.offerId,
      roomTypeName: item.roomTypeName,
      ratePlanName: item.ratePlanName,
      bedType: item.bedType,
      nights: item.nights,
      nightlyTotal: moneyDto(item.nightlyTotal, booking.currency),
      total: moneyDto(item.totalAmount, booking.currency),
      mealPlan: item.mealPlan,
      payAtHotel: item.payAtHotel,
      cancellationPolicy: {
        type: item.cancellationType,
        refundable: item.cancellationType !== 'NON_REFUNDABLE',
        freeCancellationUntil: localDate(item.freeCancellationUntil),
        penaltyAmount: item.penaltyAmount === null ? null : moneyDto(item.penaltyAmount, booking.currency),
        penaltyPercent: item.penaltyPercent,
        description: item.cancellationText ?? '',
      },
    })),
    specialRequests: booking.specialRequests,
    payment: booking.payment
      ? {
          status: booking.payment.status,
          amount: moneyDto(booking.payment.amount, booking.payment.currency),
          provider: booking.payment.provider,
        }
      : null,
    refunds: booking.refunds.map((refund) => ({
      id: refund.id,
      status: refund.status,
      amount: moneyDto(refund.amount, refund.currency),
      reason: refund.reason,
      createdAt: refund.createdAt.toISOString(),
    })),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    confirmedAt: booking.confirmedAt ? booking.confirmedAt.toISOString() : null,
    cancelledAt: booking.cancelledAt ? booking.cancelledAt.toISOString() : null,
  };
}
