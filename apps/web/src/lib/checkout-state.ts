/**
 * The chosen offer travels from the hotel page to /checkout through the URL.
 *
 * We keep the full `Quote` (prices, meal plan, cancellation policy) in one
 * JSON blob so the checkout page can render a full summary without a second
 * round trip, and so the API types stay intact end to end. Prices are carried
 * as the API's own objects (`amount` + `major`), never as floats.
 */

import type { Quote } from './api';

export interface CheckoutHotel {
  id: string;
  name: string;
  slug?: string | null;
  thumbnail?: string | null;
  city?: string | null;
}

export interface CheckoutStay {
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: string;
  nights: number;
}

export interface CheckoutState {
  hotel: CheckoutHotel;
  stay: CheckoutStay;
  quote: Quote;
}

export const CHECKOUT_PARAM = 'q';

export function buildCheckoutHref(state: CheckoutState): string {
  const params = new URLSearchParams();
  params.set(CHECKOUT_PARAM, JSON.stringify(state));
  return `/checkout?${params.toString()}`;
}

export function parseCheckoutState(raw: string | undefined): CheckoutState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CheckoutState>;
    const quote = parsed?.quote;
    const stay = parsed?.stay;
    if (!quote?.offerId || !stay?.checkIn || !stay?.checkOut || !parsed?.hotel?.id) {
      return null;
    }
    return {
      hotel: {
        id: parsed.hotel.id,
        name: parsed.hotel.name ?? '未知酒店',
        slug: parsed.hotel.slug ?? null,
        thumbnail: parsed.hotel.thumbnail ?? null,
        city: parsed.hotel.city ?? null,
      },
      stay: {
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        rooms: Number(stay.rooms ?? 1),
        adults: Number(stay.adults ?? 2),
        childAges: Array.isArray(stay.childAges) ? stay.childAges.map(Number) : [],
        currency: stay.currency ?? 'CNY',
        nights: Number(stay.nights ?? 1),
      },
      quote,
    };
  } catch {
    return null;
  }
}
