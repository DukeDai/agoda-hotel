import type { FastifyInstance } from 'fastify';
import { AppError, fingerprint, toDTO } from '@ota/core';
import type { Money, MoneyDTO } from '@ota/core';
import type { SupplierHotelSummary, SupplierQuote, SupplierSearchQuery } from '@ota/agoda-connectivity';
import type { AppContext } from '../../lib/context.js';
import type { LockHandle } from '../../lib/cache.js';
import { beginIdempotent, completeIdempotent, failIdempotent } from '../../lib/idempotency.js';
import {
  dateOnly,
  dateOnlyOrNull,
  upsertHotelFromSummary,
  upsertRatePlan,
  upsertRoomType,
} from '../catalog/persist.js';
import { findHotel } from '../catalog/detail.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildStayContext,
  normalizeStay,
  stayFingerprint,
  type NormalizedStay,
} from './params.js';
import {
  quoteView,
  type AvailabilityResponse,
  type PrecheckResponse,
  type QuoteView,
  type SearchHotelView,
  type SearchResponse,
} from './views.js';

export type {
  AvailabilityResponse,
  PrecheckResponse,
  QuoteView,
  SearchHotelView,
  SearchResponse,
} from './views.js';
export { buildStayContext, normalizeStay, stayFingerprint } from './params.js';
export type { NormalizedStay, StayInput } from './params.js';

/**
 * Search, availability and precheck.
 *
 * The three calls of the supplier chain (Search → Precheck → Book) share one
 * parameter set, the "stay context". Its fingerprint is stored on every
 * quote, so a booking that drifted away from the quote is rejected instead of
 * being placed at the wrong price.
 */

export interface SearchParams {
  destination: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges?: number[];
  currency?: string;
  nationality?: string;
  page?: number;
  pageSize?: number;
}

export interface AvailabilityParams extends SearchParams {
  hotelId: string;
}

export interface PrecheckInput {
  hotelId: string;
  offerId: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges?: number[];
  currency?: string;
  nationality?: string;
  /**
   * Optional idempotency key. With one, the same key + same body replays the
   * first answer instead of hitting the supplier again.
   */
  idempotencyKey?: string;
}

/** Search results are cached this long: enough to absorb a page refresh. */
const SEARCH_CACHE_TTL_SECONDS = 60;
/** A quote is only valid for a couple of minutes. */
const QUOTE_TTL_MS = 2 * 60 * 1000;
const LOCK_TTL_MS = 10_000;
/** How long a request waits for a concurrent identical request to finish. */
const LOCK_WAIT_MS = 1_500;
const POLL_INTERVAL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take the lock, waiting a little for a concurrent request to finish.
 *
 * The lock is what keeps two identical requests from hitting the supplier at
 * the same time. When it cannot be taken in time the caller proceeds anyway:
 * a slow request must never turn into a failed request.
 */
async function acquireWithWait(ctx: AppContext, key: string): Promise<LockHandle | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const handle = await ctx.lock.acquire(key, LOCK_TTL_MS);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

function supplierQuery(stay: NormalizedStay): SupplierSearchQuery {
  return {
    destination: { name: '' },
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms: stay.rooms,
    adults: stay.adults,
    childAges: stay.childAges,
    currency: stay.currency,
    nationality: stay.nationality,
  };
}

function pageNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.trunc(parsed));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search hotels for a stay.
 *
 * The result is cached for a minute: the supplier's rate limit is the scarce
 * resource here, and two identical searches in a row must not cost two
 * supplier calls.
 */
export async function searchHotels(ctx: AppContext, params: SearchParams): Promise<SearchResponse> {
  const stay = normalizeStay(params);
  const destination = typeof params.destination === 'string' ? params.destination.trim() : '';
  if (!destination) {
    throw new AppError('VALIDATION_ERROR', '目的地不能为空');
  }
  const page = pageNumber(params.page, 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, pageNumber(params.pageSize, DEFAULT_PAGE_SIZE));

  const cacheKey = `search:${fingerprint({ destination, stay, page, pageSize })}`;
  const cached = await ctx.cache.get<SearchResponse>(cacheKey);
  if (cached) return cached;

  // Two concurrent searches for the same stay must not both hit the supplier.
  const lockKey = `search:${fingerprint({ destination, stay })}`;
  const handle = await acquireWithWait(ctx, lockKey);

  try {
    // The request that held the lock may have published the result already.
    const published = await ctx.cache.get<SearchResponse>(cacheKey);
    if (published) return published;

    const response = await runSearch(ctx, destination, stay, page, pageSize);
    await ctx.cache.set(cacheKey, response, SEARCH_CACHE_TTL_SECONDS);
    return response;
  } finally {
    if (handle) await handle.release();
  }
}

async function runSearch(
  ctx: AppContext,
  destination: string,
  stay: NormalizedStay,
  page: number,
  pageSize: number,
): Promise<SearchResponse> {
  const query = supplierQuery(stay);
  query.destination = { name: destination };

  const result = await ctx.supplier.searchHotels(query);
  const summaries = result.hotels ?? [];
  const total = result.total ?? summaries.length;
  const start = (page - 1) * pageSize;
  const pageSummaries = summaries.slice(start, start + pageSize);

  // A search result must be bookable right away: the hotel has to exist in
  // the local catalog even when the content sync never ran.
  const localBySupplierId = new Map<string, string>();
  for (const summary of pageSummaries) {
    const local = await upsertHotelFromSummary(ctx.prisma, ctx.supplier.name, summary);
    localBySupplierId.set(summary.id, local.id);
  }

  const localIds = [...localBySupplierId.values()];
  const rows = await ctx.prisma.hotel.findMany({
    where: { id: { in: localIds } },
    include: { images: { orderBy: { position: 'asc' } } },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Prices come from the supplier's availability, never from a guess.
  const prices = await lowestPrices(ctx, query, pageSummaries.map((summary) => summary.id));

  const hotels: SearchHotelView[] = [];
  for (const summary of pageSummaries) {
    const localId = localBySupplierId.get(summary.id) ?? '';
    const local = byId.get(localId) ?? null;
    const images = local ? local.images.map((image) => image.url) : [];
    const lowest = prices.get(summary.id);

    hotels.push({
      id: local?.id ?? localId,
      supplierHotelId: summary.id,
      slug: local?.slug ?? '',
      name: summary.name,
      starRating: summary.starRating ?? null,
      address: {
        street: local?.addressLine1 ?? null,
        city: summary.address.city || local?.city || '',
        country: summary.address.country || local?.country || '',
        countryCode: summary.address.countryCode || local?.countryCode || '',
        postalCode: local?.postalCode ?? null,
      },
      geo:
        summary.geo ??
        (local && local.latitude !== null && local.longitude !== null
          ? { latitude: local.latitude, longitude: local.longitude }
          : null),
      thumbnail: summary.thumbnail ?? images[0] ?? null,
      images: images.length > 0 ? images : summary.thumbnail ? [summary.thumbnail] : [],
      lowestNightlyTotal:
        lowest?.nightly ??
        (summary.lowestNightlyTotal ? toDTO(summary.lowestNightlyTotal) : null),
      lowestStayTotal:
        lowest?.stay ?? (summary.lowestStayTotal ? toDTO(summary.lowestStayTotal) : null),
      reviewScore: summary.reviewScore ?? null,
      reviewCount: summary.reviewCount ?? null,
    });
  }

  return {
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    nights: stay.nights,
    rooms: stay.rooms,
    adults: stay.adults,
    currency: stay.currency,
    hotels,
    total,
    page,
    pageSize,
  };
}

/**
 * The lowest price of every hotel of the page.
 *
 * One availability call covers the whole page; the minimum is taken over the
 * quotes the supplier returned for that hotel.
 */
async function lowestPrices(
  ctx: AppContext,
  query: SupplierSearchQuery,
  hotelIds: string[],
): Promise<Map<string, { nightly: MoneyDTO | null; stay: MoneyDTO | null }>> {
  const out = new Map<string, { nightly: MoneyDTO | null; stay: MoneyDTO | null }>();
  if (hotelIds.length === 0) return out;

  const availabilities = await ctx.supplier.getAvailability({ ...query, hotelIds });
  for (const availability of availabilities) {
    let nightly: Money | null = null;
    let stay: Money | null = null;
    for (const quote of availability.quotes) {
      if (!nightly || quote.nightly.total.amount < nightly.amount) nightly = quote.nightly.total;
      if (!stay || quote.stayTotal.total.amount < stay.amount) stay = quote.stayTotal.total;
    }
    out.set(availability.supplierHotelId, {
      nightly: nightly ? toDTO(nightly) : null,
      stay: stay ? toDTO(stay) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/**
 * Room level availability and prices of one hotel.
 *
 * Every quote is persisted as an `AvailabilityQuote` row: that row is the
 * contract with the booking module, which prices the order from it and
 * refuses to book when the stay context drifted.
 */
export async function getAvailability(
  ctx: AppContext,
  params: AvailabilityParams,
): Promise<AvailabilityResponse> {
  const stay = normalizeStay(params);
  const hotel = await findHotel(ctx, params.hotelId);

  const query = supplierQuery(stay);
  query.destination = { name: '' };

  const lockKey = `availability:${fingerprint({ hotelId: hotel.id, stay })}`;
  const handle = await acquireWithWait(ctx, lockKey);

  try {
    const availabilities = await ctx.supplier.getAvailability({
      ...query,
      hotelIds: [hotel.supplierHotelId],
    });

    const stayContext = buildStayContext(hotel.supplierHotelId, stay);
    const contextFingerprint = stayFingerprint(stayContext);
    const expiresAt = new Date(ctx.now().getTime() + QUOTE_TTL_MS);

    const quotes: QuoteView[] = [];
    for (const quote of availabilities.flatMap((availability) => availability.quotes)) {
      const localIds = await persistQuote(ctx, hotel.id, quote, stay, contextFingerprint, expiresAt, 'availability');
      quotes.push(quoteView(quote, localIds));
    }

    // Rows of this stay that expired are dropped, so the table cannot grow
    // forever. The quote the customer is looking at is still valid and stays.
    await ctx.prisma.availabilityQuote.deleteMany({
      where: {
        hotelId: hotel.id,
        checkIn: dateOnly(stay.checkIn),
        checkOut: dateOnly(stay.checkOut),
        expiresAt: { lt: ctx.now() },
      },
    });

    return {
      hotelId: hotel.id,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      nights: stay.nights,
      currency: stay.currency,
      quotes,
    };
  } finally {
    if (handle) await handle.release();
  }
}

/**
 * Store one quote and return the LOCAL ids of its room type and rate plan.
 *
 * Two price columns matter:
 *  - `quotedTotalAmount` — the price the customer was last SHOWN. It is the
 *    baseline of the offer and only a fresh availability view moves it.
 *  - `pendingTotalAmount` — set when the supplier moved the price UP after
 *    the customer chose the room. While it is set, the booking module
 *    refuses to create an order unless the customer accepted that exact
 *    amount (SPEC §4.5).
 */
async function persistQuote(
  ctx: AppContext,
  hotelId: string,
  quote: SupplierQuote,
  stay: NormalizedStay,
  contextFingerprint: string,
  expiresAt: Date,
  mode: 'availability' | 'precheck',
): Promise<{ roomTypeId: string; ratePlanId: string }> {
  const roomTypeId = await upsertRoomType(ctx.prisma, hotelId, {
    id: quote.roomTypeId,
    name: quote.roomTypeName,
    maxOccupancy: quote.maxOccupancy,
    ...(quote.bedType ? { bedType: quote.bedType } : {}),
    images: [],
    amenities: [],
  });

  const policy = quote.cancellationPolicy;
  const ratePlanId = await upsertRatePlan(ctx.prisma, roomTypeId, {
    supplierRatePlanId: quote.ratePlanId,
    name: quote.ratePlanName,
    cancellationType: policy.type,
    freeCancellationUntil: policy.freeCancellationUntil ?? null,
    penaltyAmount: policy.penaltyAmount?.amount ?? null,
    penaltyPercent: policy.penaltyPercent ?? null,
    noShowPenalty: policy.noShowPenalty?.amount ?? null,
    cancellationText: policy.description ?? null,
    mealPlan: quote.mealPlan,
    payAtHotel: quote.payAtHotel,
    instantConfirmation: quote.instantConfirmation,
  });

  const data = {
    offerId: quote.offerId,
    hotelId,
    roomTypeId,
    ratePlanId,
    checkIn: dateOnly(stay.checkIn),
    checkOut: dateOnly(stay.checkOut),
    nights: stay.nights,
    rooms: stay.rooms,
    adults: stay.adults,
    childAges: [...stay.childAges],
    // The currency of the stay, not of the quote: it has to be the very same
    // currency the fingerprint was built from, otherwise the booking would
    // compare a price in one currency with a price in another.
    currency: stay.currency,
    nightlyNet: quote.nightly.net.amount,
    nightlyTax: quote.nightly.taxes.amount,
    nightlyTotal: quote.nightly.total.amount,
    netAmount: quote.stayTotal.net.amount,
    taxAmount: quote.stayTotal.taxes.amount,
    totalAmount: quote.stayTotal.total.amount,
    mealPlan: quote.mealPlan,
    payAtHotel: quote.payAtHotel,
    instantConfirmation: quote.instantConfirmation,
    allotment: quote.allotment ?? null,
    cancellationType: policy.type,
    freeCancellationUntil: dateOnlyOrNull(policy.freeCancellationUntil),
    penaltyAmount: policy.penaltyAmount?.amount ?? null,
    penaltyPercent: policy.penaltyPercent ?? null,
    cancellationText: policy.description ?? null,
    contextFingerprint,
    expiresAt,
  };

  // `createdAt desc`: a supplier may re-issue the same offer, and only the
  // freshest row reflects the current price.
  const existing = await ctx.prisma.availabilityQuote.findFirst({
    where: { hotelId, offerId: quote.offerId },
    orderBy: { createdAt: 'desc' },
  });

  if (!existing) {
    await ctx.prisma.availabilityQuote.create({
      data: {
        ...data,
        // First time we see this offer: the price we show IS the baseline.
        quotedTotalAmount: data.totalAmount,
        pendingTotalAmount: null,
      },
    });
    return { roomTypeId, ratePlanId };
  }

  // The baseline is what the customer saw. A fresh availability view means
  // "the customer is looking at this price right now" — it becomes the new
  // baseline and any pending confirmation is void.
  const baseline = existing.quotedTotalAmount ?? existing.totalAmount;
  const quotedTotalAmount = mode === 'availability' ? data.totalAmount : baseline;
  // Only a price INCREASE needs an explicit confirmation; a cheaper offer
  // is simply good news for the customer.
  const pendingTotalAmount =
    mode === 'precheck' && data.totalAmount > baseline ? data.totalAmount : null;

  await ctx.prisma.availabilityQuote.update({
    where: { id: existing.id },
    data: { ...data, quotedTotalAmount, pendingTotalAmount },
  });

  return { roomTypeId, ratePlanId };
}

// ---------------------------------------------------------------------------
// Precheck
// ---------------------------------------------------------------------------

/**
 * Re-validate a quote right before the booking.
 *
 * The supplier may have re-priced the offer or sold it out. When the price
 * moved, the cached quote is updated with the new price so the booking is
 * placed at the current price, and the caller is told that the price
 * changed. The booking module then refuses to book without an explicit
 * customer acceptance (SPEC §4.5.1).
 */
export async function precheckQuote(
  ctx: AppContext,
  input: PrecheckInput,
): Promise<PrecheckResponse> {
  const key = input.idempotencyKey;
  if (key) {
    const replay = await beginIdempotent({
      prisma: ctx.prisma,
      key,
      scope: 'quote:precheck',
      request: input,
    });
    if (replay) return replay.body as PrecheckResponse;
  }

  try {
    const response = await runPrecheck(ctx, input);
    if (key) await completeIdempotent(ctx.prisma, key, 200, response);
    return response;
  } catch (err) {
    // A failed precheck must be retryable with the same key: the customer is
    // going to press the button again.
    if (key) await failIdempotent(ctx.prisma, key, err instanceof Error ? err.message : 'error');
    throw err;
  }
}

async function runPrecheck(ctx: AppContext, input: PrecheckInput): Promise<PrecheckResponse> {
  const stay = normalizeStay(input);
  const hotel = await findHotel(ctx, input.hotelId);

  const stayContext = buildStayContext(hotel.supplierHotelId, stay);
  const contextFingerprint = stayFingerprint(stayContext);

  const cached = await ctx.prisma.availabilityQuote.findFirst({
    where: { hotelId: hotel.id, offerId: input.offerId },
    // The freshest row describes the current price; an older row of the same
    // offer would compare against a price that no longer exists.
    orderBy: { createdAt: 'desc' },
  });
  if (!cached) {
    throw new AppError('VALIDATION_ERROR', '报价不存在或已失效，请重新选择房型', {
      details: { offerId: input.offerId },
    });
  }
  if (cached.contextFingerprint !== contextFingerprint) {
    throw new AppError('VALIDATION_ERROR', '入住信息与报价不一致，请重新选择房型', {
      details: { offerId: input.offerId },
    });
  }

  // The fingerprint travels to the supplier unchanged: it proves that the
  // precheck describes the very same stay the quote was made for.
  const lockKey = `precheck:${fingerprint({ offerId: input.offerId, contextFingerprint })}`;
  const handle = await acquireWithWait(ctx, lockKey);

  let result: Awaited<ReturnType<typeof ctx.supplier.precheck>>;
  try {
    result = await ctx.supplier.precheck({
      supplierHotelId: hotel.supplierHotelId,
      offerId: input.offerId,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      rooms: stay.rooms,
      adults: stay.adults,
      childAges: stay.childAges,
      currency: stay.currency,
      nationality: stay.nationality,
      contextFingerprint,
    });
  } finally {
    if (handle) await handle.release();
  }

  if (!result.available) {
    throw new AppError('ROOM_UNAVAILABLE', '所选房型已售罄，请重新选择', {
      details: { offerId: input.offerId },
    });
  }

  const quote = result.quote;
  // The baseline is the price the customer was SHOWN (the detail page), not
  // the price we happen to have stored last: comparing against the stored
  // price would hide the drift after the first precheck.
  const baseline = cached.quotedTotalAmount ?? cached.totalAmount;
  const priceChanged =
    result.priceChanged ||
    quote.stayTotal.total.amount !== baseline ||
    quote.stayTotal.total.currency !== cached.currency;

  // The quote is refreshed with the current price and a fresh expiry, so the
  // booking that follows uses the price the customer just saw. A price
  // INCREASE additionally marks the offer as "waiting for the customer's
  // confirmation" — the booking module enforces it.
  const localIds = await persistQuote(
    ctx,
    hotel.id,
    quote,
    stay,
    contextFingerprint,
    new Date(ctx.now().getTime() + QUOTE_TTL_MS),
    'precheck',
  );

  return {
    offerId: input.offerId,
    priceChanged,
    available: true,
    quote: quoteView(quote, localIds),
    total: toDTO(quote.stayTotal.total),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const stayQuerySchema = {
  type: 'object',
  properties: {
    checkIn: { type: 'string', minLength: 10, maxLength: 10 },
    checkOut: { type: 'string', minLength: 10, maxLength: 10 },
    rooms: { type: 'integer', minimum: 1, maximum: 9, default: 1 },
    adults: { type: 'integer', minimum: 1, maximum: 16, default: 2 },
    childAges: { type: 'string' },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    nationality: { type: 'string', minLength: 2, maxLength: 2 },
  },
  required: ['checkIn', 'checkOut'],
} as const;

/** `childAges` arrives as "5,8" in a query string and as an array in a body. */
function parseChildAges(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    return value.map((age) => Number(age));
  }
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

export async function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get(
    '/api/v1/hotels/search',
    {
      schema: {
        tags: ['search'],
        description: '按目的地与日期搜索酒店，返回最低价。',
        querystring: {
          type: 'object',
          properties: {
            destination: { type: 'string', minLength: 1 },
            ...stayQuerySchema.properties,
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
          },
          required: ['destination', 'checkIn', 'checkOut'],
        },
      },
    },
    async (req) => {
      const q = req.query as Record<string, unknown>;
      return searchHotels(ctx, {
        destination: String(q.destination ?? ''),
        checkIn: String(q.checkIn ?? ''),
        checkOut: String(q.checkOut ?? ''),
        rooms: Number(q.rooms ?? 1),
        adults: Number(q.adults ?? 2),
        childAges: parseChildAges(q.childAges),
        currency: optionalString(q.currency),
        nationality: optionalString(q.nationality),
        page: Number(q.page ?? 1),
        pageSize: Number(q.pageSize ?? DEFAULT_PAGE_SIZE),
      });
    },
  );

  app.get(
    '/api/v1/hotels/:id/availability',
    {
      schema: {
        tags: ['search'],
        description: '房型级库存与报价。:id 为本地酒店 ID 或 slug。',
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
        querystring: stayQuerySchema,
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const q = req.query as Record<string, unknown>;
      return getAvailability(ctx, {
        hotelId: id,
        destination: optionalString(q.destination) ?? '',
        checkIn: String(q.checkIn ?? ''),
        checkOut: String(q.checkOut ?? ''),
        rooms: Number(q.rooms ?? 1),
        adults: Number(q.adults ?? 2),
        childAges: parseChildAges(q.childAges),
        currency: optionalString(q.currency),
        nationality: optionalString(q.nationality),
        page: Number(q.page ?? 1),
        pageSize: Number(q.pageSize ?? DEFAULT_PAGE_SIZE),
      });
    },
  );

  app.post(
    '/api/v1/quotes/precheck',
    {
      schema: {
        tags: ['search'],
        description: '下单前验价验房。',
        body: {
          type: 'object',
          properties: {
            hotelId: { type: 'string', minLength: 1 },
            offerId: { type: 'string', minLength: 1 },
            checkIn: { type: 'string', minLength: 10, maxLength: 10 },
            checkOut: { type: 'string', minLength: 10, maxLength: 10 },
            rooms: { type: 'integer', minimum: 1, maximum: 9, default: 1 },
            adults: { type: 'integer', minimum: 1, maximum: 16, default: 2 },
            childAges: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 17 } },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            nationality: { type: 'string', minLength: 2, maxLength: 2 },
          },
          required: ['hotelId', 'offerId', 'checkIn', 'checkOut'],
        },
      },
    },
    async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return precheckQuote(ctx, {
        hotelId: String(body.hotelId ?? ''),
        offerId: String(body.offerId ?? ''),
        checkIn: String(body.checkIn ?? ''),
        checkOut: String(body.checkOut ?? ''),
        rooms: Number(body.rooms ?? 1),
        adults: Number(body.adults ?? 2),
        childAges: parseChildAges(body.childAges),
        currency: optionalString(body.currency),
        nationality: optionalString(body.nationality),
        idempotencyKey: idempotencyKeyIfPresent(req),
      });
    },
  );
}

/**
 * The precheck key is OPTIONAL: with one, a repeated request replays the
 * first answer instead of hitting the supplier again; without one, every
 * call is a fresh validation (that is what an operator refresh wants).
 */
function idempotencyKeyIfPresent(req: { headers: Record<string, unknown> }): string | undefined {
  const raw = req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
