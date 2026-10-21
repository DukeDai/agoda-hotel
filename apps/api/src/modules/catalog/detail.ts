import { AppError } from '@ota/core';
import type { AppContext } from '../../lib/context.js';

/**
 * The static hotel document (docs/api-contract.md §2).
 *
 * It is served from the local catalog, never from the supplier: the content
 * sync owns the copy we hold, and the C-end must not spend supplier quota on
 * rendering a hotel page.
 */

export interface HotelAddressView {
  street: string | null;
  city: string;
  country: string;
  countryCode: string;
  postalCode: string | null;
}

export interface HotelImageView {
  url: string;
  caption: string | null;
  position: number;
}

export interface HotelAmenityView {
  group: string | null;
  name: string;
}

export interface RoomTypeView {
  id: string;
  supplierRoomTypeId: string;
  name: string;
  description: string | null;
  maxOccupancy: number;
  bedType: string | null;
  sizeSqm: number | null;
  imageUrls: string[];
}

export interface HotelDetailView {
  id: string;
  supplierHotelId: string;
  slug: string;
  name: string;
  starRating: number | null;
  description: string | null;
  address: HotelAddressView;
  geo: { latitude: number; longitude: number } | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  images: HotelImageView[];
  amenities: HotelAmenityView[];
  policies: string[];
  roomTypes: RoomTypeView[];
}

/** Resolve a hotel by its local id or by its slug. */
export async function findHotel(ctx: AppContext, idOrSlug: string): Promise<{
  id: string;
  supplierHotelId: string;
  slug: string;
  name: string;
}> {
  const hotel = await ctx.prisma.hotel.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    select: { id: true, supplierHotelId: true, slug: true, name: true },
  });
  if (!hotel) {
    throw new AppError('HOTEL_NOT_FOUND', '酒店不存在或尚未同步', { details: { hotelId: idOrSlug } });
  }
  return hotel;
}

export async function getHotelDetail(ctx: AppContext, idOrSlug: string): Promise<HotelDetailView> {
  const hotel = await ctx.prisma.hotel.findFirst({
    where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
    include: {
      images: { orderBy: { position: 'asc' } },
      amenities: { orderBy: { name: 'asc' } },
      roomTypes: { orderBy: { name: 'asc' } },
    },
  });

  if (!hotel) {
    throw new AppError('HOTEL_NOT_FOUND', '酒店不存在或尚未同步', { details: { hotelId: idOrSlug } });
  }

  const geo =
    hotel.latitude === null || hotel.longitude === null
      ? null
      : { latitude: hotel.latitude, longitude: hotel.longitude };

  return {
    id: hotel.id,
    supplierHotelId: hotel.supplierHotelId,
    slug: hotel.slug,
    name: hotel.name,
    starRating: hotel.starRating ?? null,
    description: hotel.description ?? null,
    address: {
      street: hotel.addressLine1 ?? null,
      city: hotel.city,
      country: hotel.country,
      countryCode: hotel.countryCode,
      postalCode: hotel.postalCode ?? null,
    },
    geo,
    checkInTime: hotel.checkInTime ?? null,
    checkOutTime: hotel.checkOutTime ?? null,
    images: hotel.images.map((image) => ({
      url: image.url,
      caption: image.caption ?? null,
      position: image.position,
    })),
    amenities: hotel.amenities.map((amenity) => ({
      group: amenity.group ?? null,
      name: amenity.name,
    })),
    policies: [...(hotel.policies ?? [])],
    roomTypes: hotel.roomTypes.map((roomType) => ({
      id: roomType.id,
      supplierRoomTypeId: roomType.supplierRoomTypeId,
      name: roomType.name,
      description: roomType.description ?? null,
      maxOccupancy: roomType.maxOccupancy,
      bedType: roomType.bedType ?? null,
      sizeSqm: roomType.sizeSqm ?? null,
      imageUrls: [...(roomType.imageUrls ?? [])],
    })),
  };
}
