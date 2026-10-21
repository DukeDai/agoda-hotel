import type { PrismaClient } from '@prisma/client';
import type {
  SupplierHotel,
  SupplierHotelSummary,
  SupplierRoomType,
} from '@ota/agoda-connectivity';
import { slugify, uniqueSlug } from './slug.js';

/**
 * The persistence layer of the catalog.
 *
 * Both the sync job (static content) and the search module (room types and
 * rate plans discovered through quotes) write to the same tables, so the
 * upserts live here and are shared.
 */

/** A `YYYY-MM-DD` calendar date as the date-only column value. */
export function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/** Same, but tolerant: an absent date stays absent. */
export function dateOnlyOrNull(value?: string | null): Date | null {
  if (!value) return null;
  return dateOnly(value);
}

/** The supplier hands us the raw payload as a string (XML) or an object. */
function rawPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

export interface HotelContentData {
  supplier: string;
  supplierHotelId: string;
  name: string;
  slug: string;
  starRating: number | null;
  category: string | null;
  description: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string;
  state: string | null;
  country: string;
  countryCode: string;
  postalCode: string | null;
  latitude: number | null;
  longitude: number | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  /** IANA timezone of the property — cancellation deadlines use it. */
  timeZone: string | null;
  policies: string[];
  raw: string | undefined;
}

export function hotelContentData(
  hotel: SupplierHotel,
  slug: string,
  supplier: string,
): HotelContentData {
  return {
    supplier,
    supplierHotelId: hotel.id,
    name: hotel.name,
    slug,
    starRating: hotel.starRating ?? null,
    category: hotel.category ?? null,
    description: hotel.description ?? null,
    addressLine1: hotel.address.street ?? null,
    addressLine2: null,
    city: hotel.address.city,
    state: hotel.address.state ?? null,
    country: hotel.address.country,
    countryCode: hotel.address.countryCode,
    postalCode: hotel.address.postalCode ?? null,
    latitude: hotel.geo?.latitude ?? null,
    longitude: hotel.geo?.longitude ?? null,
    checkInTime: hotel.checkInTime ?? null,
    checkOutTime: hotel.checkOutTime ?? null,
    timeZone: hotel.address.timeZone ?? null,
    policies: [...(hotel.policies ?? [])],
    raw: rawPayload(hotel.raw),
  };
}

/** Upsert the hotel row itself. Returns the local id and whether it was new. */
export async function upsertHotelContent(
  prisma: PrismaClient,
  input: {
    supplier: string;
    hotel: SupplierHotel;
    contentHash: string;
    syncedAt: Date;
  },
): Promise<{ id: string; slug: string; created: boolean }> {
  const existing = await prisma.hotel.findFirst({
    where: { supplier: input.supplier, supplierHotelId: input.hotel.id },
  });

  // The slug of a hotel that already exists is never changed: it is part of
  // the public URL.
  const slug = existing?.slug ?? (await freeSlug(prisma, input.hotel.name, input.hotel.id));
  const data = hotelContentData(input.hotel, slug, input.supplier);

  if (existing) {
    const updated = await prisma.hotel.update({
      where: { id: existing.id },
      data: { ...data, contentHash: input.contentHash, contentSyncedAt: input.syncedAt },
    });
    return { id: updated.id, slug: updated.slug, created: false };
  }

  const created = await prisma.hotel.create({
    data: { ...data, contentHash: input.contentHash, contentSyncedAt: input.syncedAt },
  });
  return { id: created.id, slug: created.slug, created: true };
}

/**
 * A slug that no other hotel uses.
 *
 * The supplier hotel id is the tie breaker, so the result is deterministic:
 * re-running the sync never renames a hotel.
 */
export async function freeSlug(
  prisma: PrismaClient,
  name: string,
  supplierHotelId: string,
): Promise<string> {
  return uniqueSlug(slugify(name, supplierHotelId), supplierHotelId, async (candidate) => {
    const found = await prisma.hotel.findFirst({ where: { slug: candidate } });
    return Boolean(found && found.supplierHotelId !== supplierHotelId);
  });
}

/**
 * Make sure the local hotel row exists for a search result.
 *
 * A search result must be immediately bookable, so the hotel has to exist in
 * the database even when the catalog was never synced. Only the fields the
 * supplier actually returns in a search summary are written; the richer
 * address lines coming from the content sync are never wiped by a thinner
 * summary.
 */
export async function upsertHotelFromSummary(
  prisma: PrismaClient,
  supplier: string,
  summary: SupplierHotelSummary,
): Promise<{ id: string; slug: string; created: boolean }> {
  const existing = await prisma.hotel.findFirst({
    where: { supplier, supplierHotelId: summary.id },
  });

  const data = {
    name: summary.name,
    starRating: summary.starRating ?? null,
    city: summary.address.city,
    country: summary.address.country,
    countryCode: summary.address.countryCode,
    addressLine1: summary.address.street ?? null,
    state: summary.address.state ?? null,
    postalCode: summary.address.postalCode ?? null,
    latitude: summary.geo?.latitude ?? null,
    longitude: summary.geo?.longitude ?? null,
    timeZone: summary.address.timeZone ?? null,
  };

  if (existing) {
    const updated = await prisma.hotel.update({
      where: { id: existing.id },
      data: {
        ...data,
        // A summary without a rating must not erase a synced rating.
        ...(summary.starRating === undefined ? { starRating: existing.starRating } : {}),
        ...(summary.address.street === undefined ? { addressLine1: existing.addressLine1 } : {}),
        ...(summary.address.state === undefined ? { state: existing.state } : {}),
        ...(summary.address.postalCode === undefined ? { postalCode: existing.postalCode } : {}),
        // A summary without a timezone must not erase the synced one: the
        // cancellation deadline depends on it.
        ...(summary.address.timeZone === undefined ? { timeZone: existing.timeZone } : {}),
        ...(summary.geo ? {} : { latitude: existing.latitude, longitude: existing.longitude }),
      },
    });
    await storeThumbnail(prisma, updated.id, summary.thumbnail);
    return { id: updated.id, slug: updated.slug, created: false };
  }

  const slug = await freeSlug(prisma, summary.name, summary.id);
  const created = await prisma.hotel.create({ data: { ...data, supplier, supplierHotelId: summary.id, slug } });
  await storeThumbnail(prisma, created.id, summary.thumbnail);
  return { id: created.id, slug: created.slug, created: true };
}

/**
 * The thumbnail of a search summary is the first image of the hotel.
 *
 * It is stored as a `HotelImage` row so the hotel document renders the same
 * picture the search result showed. The content sync replaces the whole set
 * of images later on.
 */
async function storeThumbnail(
  prisma: PrismaClient,
  hotelId: string,
  thumbnail?: string,
): Promise<void> {
  if (!thumbnail) return;
  const known = await prisma.hotelImage.findFirst({ where: { hotelId, url: thumbnail } });
  if (known) return;
  await prisma.hotelImage.create({
    data: { hotelId, url: thumbnail, caption: null, position: 0 },
  });
}

/**
 * Replace the child rows of a hotel: images and amenities are a full
 * replacement (the supplier owns them), room types are upserted so their
 * local ids stay stable for the quotes that point at them.
 */
export async function replaceHotelChildren(
  prisma: PrismaClient,
  hotelId: string,
  hotel: SupplierHotel,
): Promise<void> {
  await prisma.hotelImage.deleteMany({ where: { hotelId } });
  const images = hotel.images.map((image, index) => ({
    hotelId,
    url: image.url,
    caption: image.caption ?? null,
    position: index,
  }));
  if (images.length > 0) {
    await prisma.hotelImage.createMany({ data: images });
  }

  await prisma.hotelAmenity.deleteMany({ where: { hotelId } });
  const seen = new Set<string>();
  const amenities: { hotelId: string; group: string | null; name: string }[] = [];
  for (const amenity of hotel.amenities) {
    const name = amenity.name?.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    amenities.push({ hotelId, group: amenity.group ?? null, name });
  }
  if (amenities.length > 0) {
    await prisma.hotelAmenity.createMany({ data: amenities });
  }

  for (const roomType of hotel.roomTypes) {
    await upsertRoomType(prisma, hotelId, roomType);
  }
}

/** Upsert one room type, keyed on (hotel, supplier room type id). */
export async function upsertRoomType(
  prisma: PrismaClient,
  hotelId: string,
  roomType: SupplierRoomType,
): Promise<string> {
  const create = {
    hotelId,
    supplierRoomTypeId: roomType.id,
    name: roomType.name,
    description: roomType.description ?? null,
    maxOccupancy: roomType.maxOccupancy,
    bedType: roomType.bedType ?? null,
    sizeSqm: roomType.sizeSqm ?? null,
    amenities: roomType.amenities.map((amenity) => amenity.name).filter(Boolean),
    imageUrls: roomType.images.map((image) => image.url).filter(Boolean),
  };

  // A quote knows less about a room type than the content sync does, so a
  // field the caller did not provide is left untouched.
  const update = {
    name: roomType.name,
    maxOccupancy: roomType.maxOccupancy,
    ...(roomType.description !== undefined ? { description: roomType.description } : {}),
    ...(roomType.bedType !== undefined ? { bedType: roomType.bedType } : {}),
    ...(roomType.sizeSqm !== undefined ? { sizeSqm: roomType.sizeSqm } : {}),
    ...(roomType.amenities.length > 0
      ? { amenities: roomType.amenities.map((amenity) => amenity.name).filter(Boolean) }
      : {}),
    ...(roomType.images.length > 0
      ? { imageUrls: roomType.images.map((image) => image.url).filter(Boolean) }
      : {}),
  };

  const row = await prisma.roomType.upsert({
    where: { hotelId_supplierRoomTypeId: { hotelId, supplierRoomTypeId: roomType.id } },
    create,
    update,
  });
  return row.id;
}

export interface RatePlanInput {
  supplierRatePlanId: string;
  name: string;
  cancellationType: string;
  /** `YYYY-MM-DD`, property local time. */
  freeCancellationUntil?: string | null;
  /** Minor units. */
  penaltyAmount?: number | null;
  penaltyPercent?: number | null;
  /** Minor units. */
  noShowPenalty?: number | null;
  cancellationText?: string | null;
  mealPlan?: string;
  payAtHotel?: boolean;
  instantConfirmation?: boolean;
  inclusions?: string[];
}

/** Upsert one rate plan, keyed on (room type, supplier rate plan id). */
export async function upsertRatePlan(
  prisma: PrismaClient,
  roomTypeId: string,
  plan: RatePlanInput,
): Promise<string> {
  const data = {
    name: plan.name,
    cancellationType: plan.cancellationType,
    freeCancellationUntil: dateOnlyOrNull(plan.freeCancellationUntil),
    penaltyAmount: plan.penaltyAmount ?? null,
    penaltyPercent: plan.penaltyPercent ?? null,
    noShowPenalty: plan.noShowPenalty ?? null,
    cancellationText: plan.cancellationText ?? null,
    mealPlan: plan.mealPlan ?? 'NO_BREAKFAST',
    payAtHotel: plan.payAtHotel ?? false,
    instantConfirmation: plan.instantConfirmation ?? true,
    inclusions: plan.inclusions ?? [],
  };

  const row = await prisma.ratePlan.upsert({
    where: { roomTypeId_supplierRatePlanId: { roomTypeId, supplierRatePlanId: plan.supplierRatePlanId } },
    create: { roomTypeId, supplierRatePlanId: plan.supplierRatePlanId, ...data },
    update: data,
  });
  return row.id;
}
