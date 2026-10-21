import { fingerprint } from '@ota/core';
import type { SupplierHotel } from '@ota/agoda-connectivity';

/**
 * Content fingerprint of a hotel's static content.
 *
 * The sync job compares this hash with the one stored on the hotel row: an
 * unchanged hash means "nothing drifted, do not touch the database". The hash
 * therefore has to cover EVERY field we persist, and nothing that we do not
 * persist (otherwise we would rewrite rows for no reason).
 *
 * `fingerprint()` from @ota/core is a sha256 over a stable serialisation, so
 * the same content always produces the same hash, in any process.
 */
export function computeContentHash(hotel: SupplierHotel): string {
  return fingerprint({
    name: hotel.name,
    starRating: hotel.starRating ?? null,
    category: hotel.category ?? null,
    description: hotel.description ?? null,
    address: {
      street: hotel.address.street ?? null,
      city: hotel.address.city,
      state: hotel.address.state ?? null,
      country: hotel.address.country,
      countryCode: hotel.address.countryCode,
      postalCode: hotel.address.postalCode ?? null,
      timeZone: hotel.address.timeZone ?? null,
    },
    geo: hotel.geo ? { latitude: hotel.geo.latitude, longitude: hotel.geo.longitude } : null,
    checkInTime: hotel.checkInTime ?? null,
    checkOutTime: hotel.checkOutTime ?? null,
    policies: [...(hotel.policies ?? [])],
    images: hotel.images.map((image) => ({
      url: image.url,
      caption: image.caption ?? null,
      order: image.order ?? null,
    })),
    amenities: hotel.amenities.map((amenity) => ({
      group: amenity.group ?? null,
      name: amenity.name,
    })),
    roomTypes: hotel.roomTypes.map((roomType) => ({
      id: roomType.id,
      name: roomType.name,
      description: roomType.description ?? null,
      maxOccupancy: roomType.maxOccupancy,
      bedType: roomType.bedType ?? null,
      sizeSqm: roomType.sizeSqm ?? null,
      images: roomType.images.map((image) => ({
        url: image.url,
        caption: image.caption ?? null,
        order: image.order ?? null,
      })),
      amenities: roomType.amenities.map((amenity) => ({
        group: amenity.group ?? null,
        name: amenity.name,
      })),
    })),
  });
}
