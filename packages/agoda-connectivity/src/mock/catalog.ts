import type { SupplierAmenity, SupplierHotel, SupplierImage, SupplierRoomType } from '../contract.js';
import { SeededRandom, hashSeed } from './prng.js';

/**
 * The static content catalogue of the mock supplier.
 *
 * It is a fixed set of hotels (so the catalogue is stable and reviewable)
 * whose images, room type details and amenity sets are derived from the
 * SEED. Same seed => byte-identical catalogue.
 *
 * The data is deliberately varied: 3..5 stars, city hotels AND resorts,
 * several countries, 2..4 room types per hotel, different check-in times.
 */

interface HotelSeed {
  id: string;
  name: string;
  cityId: string;
  city: string;
  state?: string;
  country: string;
  countryCode: string;
  street: string;
  postalCode: string;
  latitude: number;
  longitude: number;
  starRating: number;
  category: string;
  description: string;
  imageCount: number;
  checkInTime: string;
  checkOutTime: string;
  /** IANA timezone of the property; falls back to the country default. */
  timeZone?: string;
  amenities: { group: string; name: string }[];
  policies: string[];
  roomTypes: { name: string; maxOccupancy: number; bedType: string; sizeSqm: number }[];
}

/**
 * Property timezone per country.
 *
 * A cancellation deadline is a date on the property's wall clock: in Bangkok
 * it is already the next day while it is still the previous evening in
 * Europe. Guessing UTC there would refuse free cancellations for a whole
 * seven hours every day.
 */
const COUNTRY_TIME_ZONES: Readonly<Record<string, string>> = {
  TH: 'Asia/Bangkok',
  ID: 'Asia/Makassar',
  JP: 'Asia/Tokyo',
  CN: 'Asia/Shanghai',
  SG: 'Asia/Singapore',
  FR: 'Europe/Paris',
  US: 'America/New_York',
};

const HOTEL_SEEDS: readonly HotelSeed[] = [
  {
    id: '90001',
    name: 'Patong Bayview Resort',
    cityId: '9398',
    city: 'Phuket',
    state: 'Phuket',
    country: 'Thailand',
    countryCode: 'TH',
    street: '28/5 Thaweewong Road',
    postalCode: '83150',
    latitude: 7.8924,
    longitude: 98.2961,
    starRating: 5,
    category: 'RESORT',
    description:
      'Beachfront resort on the Patong bayfront with three pools, a spa and two restaurants facing the Andaman sea.',
    imageCount: 4,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'General', name: 'Airport shuttle' },
      { group: 'Wellness', name: 'Spa' },
      { group: 'Dining', name: 'Buffet restaurant' },
      { group: 'Pool', name: 'Outdoor swimming pool' },
      { group: 'Family', name: 'Kids club' },
    ],
    policies: [
      'Free cancellation until 3 days before arrival',
      'A refundable deposit of 1 night is required at check-in',
      'No pets allowed',
    ],
    roomTypes: [
      { name: 'Deluxe King Room', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 34 },
      { name: 'Deluxe Twin Room', maxOccupancy: 2, bedType: 'Twin beds', sizeSqm: 34 },
      { name: 'Ocean Suite', maxOccupancy: 3, bedType: 'King bed', sizeSqm: 52 },
      { name: 'Pool Villa', maxOccupancy: 4, bedType: 'King bed', sizeSqm: 88 },
    ],
  },
  {
    id: '90002',
    name: 'Kata Rocks Boutique Hotel',
    cityId: '9398',
    city: 'Phuket',
    state: 'Phuket',
    country: 'Thailand',
    countryCode: 'TH',
    street: '186 Kata Road',
    postalCode: '83100',
    latitude: 7.8199,
    longitude: 98.2989,
    starRating: 4,
    category: 'BOUTIQUE',
    description: 'Design hotel a short walk from Kata beach, known for its rooftop bar.',
    imageCount: 3,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Dining', name: 'Rooftop bar' },
      { group: 'General', name: 'Air conditioning' },
    ],
    policies: ['Free cancellation until 2 days before arrival', 'No pets allowed'],
    roomTypes: [
      { name: 'Superior Queen', maxOccupancy: 2, bedType: 'Queen bed', sizeSqm: 24 },
      { name: 'Deluxe Balcony', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 28 },
      { name: 'Family Loft', maxOccupancy: 4, bedType: 'King bed + sofa bed', sizeSqm: 46 },
    ],
  },
  {
    id: '90003',
    name: 'Chiang Mai Old Town Boutique',
    cityId: '9452',
    city: 'Chiang Mai',
    state: 'Chiang Mai',
    country: 'Thailand',
    countryCode: 'TH',
    street: '42 Ratchamanka Road',
    postalCode: '50100',
    latitude: 18.7883,
    longitude: 98.9853,
    starRating: 4,
    category: 'BOUTIQUE',
    description: 'Lanna-style boutique hotel inside the old city moat, with a courtyard garden.',
    imageCount: 3,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Dining', name: 'Breakfast included' },
      { group: 'Wellness', name: 'Yoga deck' },
    ],
    policies: ['Free cancellation until 3 days before arrival'],
    roomTypes: [
      { name: 'Lanna Deluxe', maxOccupancy: 2, bedType: 'Queen bed', sizeSqm: 26 },
      { name: 'Garden Suite', maxOccupancy: 3, bedType: 'King bed', sizeSqm: 38 },
    ],
  },
  {
    id: '90004',
    name: 'Riverside Grand Bangkok',
    cityId: '9391',
    city: 'Bangkok',
    state: 'Bangkok',
    country: 'Thailand',
    countryCode: 'TH',
    street: 'Charoen Krung Road 88',
    postalCode: '10100',
    latitude: 13.7407,
    longitude: 100.5018,
    starRating: 5,
    category: 'CITY_HOTEL',
    description: 'Luxury riverside hotel with a skyline pool and a Michelin-starred restaurant.',
    imageCount: 4,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Pool', name: 'Infinity pool' },
      { group: 'Wellness', name: 'Fitness centre' },
      { group: 'Dining', name: 'Michelin-starred restaurant' },
      { group: 'Business', name: 'Business centre' },
    ],
    policies: [
      'Free cancellation until 1 day before arrival',
      'A refundable deposit of 1 night is required at check-in',
    ],
    roomTypes: [
      { name: 'Deluxe City View', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 36 },
      { name: 'Premier River View', maxOccupancy: 3, bedType: 'King bed', sizeSqm: 42 },
      { name: 'Executive Suite', maxOccupancy: 4, bedType: 'King bed', sizeSqm: 64 },
    ],
  },
  {
    id: '90005',
    name: 'Ubud Jungle Villa Resort',
    cityId: '11119',
    city: 'Ubud',
    state: 'Bali',
    country: 'Indonesia',
    countryCode: 'ID',
    street: 'Jalan Raya Sanggingan',
    postalCode: '80511',
    latitude: -8.4922,
    longitude: 115.2571,
    starRating: 5,
    category: 'RESORT',
    description: 'Jungle valley resort with private pool villas and a floating breakfast restaurant.',
    imageCount: 4,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Pool', name: 'Private pool' },
      { group: 'Wellness', name: 'Yoga pavilion' },
      { group: 'Dining', name: 'Floating breakfast' },
    ],
    policies: ['Free cancellation until 5 days before arrival', 'No pets allowed'],
    roomTypes: [
      { name: 'Valley Villa', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 58 },
      { name: 'Pool Villa', maxOccupancy: 3, bedType: 'King bed', sizeSqm: 72 },
      { name: 'Two Bedroom Pool Villa', maxOccupancy: 5, bedType: '2 king beds', sizeSqm: 120 },
    ],
  },
  {
    id: '90006',
    name: 'Seminyak Beach Club',
    cityId: '11119',
    city: 'Seminyak',
    state: 'Bali',
    country: 'Indonesia',
    countryCode: 'ID',
    street: 'Jalan Kayu Aya 10',
    postalCode: '80361',
    latitude: -8.6913,
    longitude: 115.1681,
    starRating: 4,
    category: 'RESORT',
    description: 'Beach club and resort on the Seminyak strip, adults-oriented with a beachfront pool.',
    imageCount: 3,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Pool', name: 'Beachfront pool' },
      { group: 'Dining', name: 'Beach club restaurant' },
    ],
    policies: ['Free cancellation until 2 days before arrival', 'Adults only'],
    roomTypes: [
      { name: 'Deluxe Room', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 30 },
      { name: 'Ocean Deluxe', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 32 },
    ],
  },
  {
    id: '90007',
    name: 'Shinjuku Garden Tower',
    cityId: '10501',
    city: 'Tokyo',
    state: 'Tokyo',
    country: 'Japan',
    countryCode: 'JP',
    street: 'Kabukicho 2-14-9',
    postalCode: '160-0021',
    latitude: 35.6955,
    longitude: 139.7021,
    starRating: 4,
    category: 'CITY_HOTEL',
    description: 'High-rise hotel above Kabukicho with a public bath on the 12th floor.',
    imageCount: 3,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Wellness', name: 'Public bath' },
      { group: 'Dining', name: 'Japanese restaurant' },
      { group: 'General', name: 'Laundry service' },
    ],
    policies: ['Free cancellation until 1 day before arrival', 'No large luggage storage after check-out'],
    roomTypes: [
      { name: 'Standard Double', maxOccupancy: 2, bedType: 'Double bed', sizeSqm: 18 },
      { name: 'Superior Twin', maxOccupancy: 2, bedType: 'Twin beds', sizeSqm: 22 },
      { name: 'Executive King', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 28 },
    ],
  },
  {
    id: '90008',
    name: 'Kyoto Machiya Inn',
    cityId: '10502',
    city: 'Kyoto',
    state: 'Kyoto',
    country: 'Japan',
    countryCode: 'JP',
    street: 'Gionmachi Minamigawa 611-3',
    postalCode: '605-0074',
    latitude: 35.0037,
    longitude: 135.7788,
    starRating: 3,
    category: 'RYOKAN',
    description: 'Restored machiya townhouse in Gion with a private onsen bath.',
    imageCount: 2,
    checkInTime: '16:00',
    checkOutTime: '10:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Wellness', name: 'Private onsen' },
      { group: 'Dining', name: 'Kaiseki dinner' },
    ],
    policies: ['Free cancellation until 3 days before arrival', 'Dinner must be ordered on arrival day'],
    roomTypes: [
      { name: 'Standard Twin', maxOccupancy: 2, bedType: 'Futon', sizeSqm: 20 },
      { name: 'Garden Room', maxOccupancy: 2, bedType: 'Futon', sizeSqm: 26 },
    ],
  },
  {
    id: '90009',
    name: 'Bund Riverside Hotel Shanghai',
    cityId: '10885',
    city: 'Shanghai',
    state: 'Shanghai',
    country: 'China',
    countryCode: 'CN',
    street: 'Zhongshan Dong Yi Road 108',
    postalCode: '200002',
    latitude: 31.2397,
    longitude: 121.4905,
    starRating: 5,
    category: 'CITY_HOTEL',
    description: 'Heritage tower on the Bund with a jazz bar and a river-view spa.',
    imageCount: 4,
    checkInTime: '14:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Dining', name: 'Jazz bar' },
      { group: 'Wellness', name: 'Spa' },
      { group: 'General', name: 'Airport shuttle' },
    ],
    policies: ['Free cancellation until 1 day before arrival', 'Registration passport details required'],
    roomTypes: [
      { name: 'Deluxe Bund View', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 40 },
      { name: 'Club Twin', maxOccupancy: 2, bedType: 'Twin beds', sizeSqm: 42 },
      { name: 'Grand Suite', maxOccupancy: 4, bedType: 'King bed', sizeSqm: 96 },
    ],
  },
  {
    id: '90010',
    name: 'Marina Bay Skyline Singapore',
    cityId: '15691',
    city: 'Singapore',
    state: 'Singapore',
    country: 'Singapore',
    countryCode: 'SG',
    street: 'Bayfront Avenue 10',
    postalCode: '018956',
    latitude: 1.2834,
    longitude: 103.8607,
    starRating: 5,
    category: 'CITY_HOTEL',
    description: 'Iconic skyline hotel with an infinity pool facing the Marina Bay waterfront.',
    imageCount: 4,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Pool', name: 'Infinity pool' },
      { group: 'Dining', name: 'Sky bar' },
      { group: 'Wellness', name: 'Fitness centre' },
      { group: 'Family', name: 'Kids club' },
    ],
    policies: ['Free cancellation until 1 day before arrival', 'A refundable deposit is required at check-in'],
    roomTypes: [
      { name: 'Deluxe City', maxOccupancy: 2, bedType: 'King bed', sizeSqm: 35 },
      { name: 'Club Harbour View', maxOccupancy: 3, bedType: 'King bed', sizeSqm: 45 },
      { name: 'Premier Suite', maxOccupancy: 4, bedType: 'King bed', sizeSqm: 78 },
    ],
  },
  {
    id: '90011',
    name: 'Montmartre Design Hotel Paris',
    cityId: '14837',
    city: 'Paris',
    state: 'Ile-de-France',
    country: 'France',
    countryCode: 'FR',
    street: '12 Rue des Abbesses',
    postalCode: '75018',
    latitude: 48.8845,
    longitude: 2.3386,
    starRating: 4,
    category: 'BOUTIQUE',
    description: 'Left-bank style design hotel near Sacre-Coeur with a leafy courtyard.',
    imageCount: 3,
    checkInTime: '15:00',
    checkOutTime: '12:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'Dining', name: 'Courtyard cafe' },
      { group: 'Wellness', name: 'Massage room' },
    ],
    policies: ['Free cancellation until 2 days before arrival', 'City tax charged on site'],
    roomTypes: [
      { name: 'Classic Double', maxOccupancy: 2, bedType: 'Queen bed', sizeSqm: 19 },
      { name: 'Superior Twin', maxOccupancy: 2, bedType: 'Twin beds', sizeSqm: 22 },
      { name: 'Atelier Suite', maxOccupancy: 3, bedType: 'Queen bed', sizeSqm: 40 },
    ],
  },
  {
    id: '90012',
    name: 'Manhattan Loft Suites',
    cityId: '16055',
    city: 'New York',
    state: 'New York',
    country: 'United States',
    countryCode: 'US',
    street: '112 West 25th Street',
    postalCode: '10001',
    latitude: 40.7443,
    longitude: -73.9929,
    starRating: 4,
    category: 'APARTMENT',
    description: 'Apartment-style hotel in Chelsea with kitchenettes and a 24h fitness room.',
    imageCount: 3,
    checkInTime: '16:00',
    checkOutTime: '11:00',
    amenities: [
      { group: 'General', name: 'Free WiFi' },
      { group: 'General', name: 'Kitchenette' },
      { group: 'Wellness', name: '24h fitness centre' },
      { group: 'Family', name: 'Cribs on request' },
    ],
    policies: ['Free cancellation until 1 day before arrival', 'Occupancy taxes charged on site'],
    roomTypes: [
      { name: 'Studio Queen', maxOccupancy: 2, bedType: 'Queen bed', sizeSqm: 27 },
      { name: 'One Bedroom Apartment', maxOccupancy: 3, bedType: 'King bed', sizeSqm: 51 },
      { name: 'Two Bedroom Apartment', maxOccupancy: 5, bedType: '2 queen beds', sizeSqm: 78 },
    ],
  },
];

const ROOM_AMENITIES: readonly { group: string; name: string }[] = [
  { group: 'Room', name: 'Air conditioning' },
  { group: 'Room', name: 'Free WiFi' },
  { group: 'Bathroom', name: 'Rain shower' },
  { group: 'Bathroom', name: 'Hair dryer' },
  { group: 'Room', name: 'Minibar' },
  { group: 'Room', name: 'Safe' },
  { group: 'Room', name: 'Smart TV' },
  { group: 'Accessibility', name: 'Accessible shower' },
];

/** Build the deterministic catalogue for a seed. */
export function buildCatalog(seed: number): SupplierHotel[] {
  return HOTEL_SEEDS.map((hotelSeed) => buildHotel(hotelSeed, seed));
}

function buildHotel(seed: HotelSeed, seedValue: number): SupplierHotel {
  const rng = new SeededRandom(hashSeed(seedValue, 'hotel', seed.id));
  const images: SupplierImage[] = Array.from({ length: seed.imageCount }, (_, index) => ({
    url: `https://cdn.agoda.mock/hotels/${seed.id}/${index + 1}.jpg`,
    caption: `${seed.name} - photo ${index + 1}`,
    order: index + 1,
  }));

  const roomTypes: SupplierRoomType[] = seed.roomTypes.map((roomSeed, index) => {
    const roomRng = new SeededRandom(hashSeed(seedValue, 'room', seed.id, String(index)));
    const roomImages: SupplierImage[] = Array.from({ length: 2 }, (_, imageIndex) => ({
      url: `https://cdn.agoda.mock/hotels/${seed.id}/rooms/${index + 1}-${imageIndex + 1}.jpg`,
      caption: `${roomSeed.name} - photo ${imageIndex + 1}`,
      order: imageIndex + 1,
    }));
    const amenityCount = roomRng.int(3, 5);
    const amenities: SupplierAmenity[] = [];
    for (let i = 0; i < amenityCount; i += 1) {
      const amenity = ROOM_AMENITIES[(roomRng.int(0, ROOM_AMENITIES.length - 1) + i) % ROOM_AMENITIES.length];
      if (amenity && !amenities.some((existing) => existing.name === amenity.name)) {
        amenities.push({ ...amenity });
      }
    }
    return {
      id: `${seed.id}-${index + 1}`,
      name: roomSeed.name,
      description: `${roomSeed.name} with ${roomSeed.bedType.toLowerCase()}, ${roomSeed.sizeSqm} m².`,
      maxOccupancy: roomSeed.maxOccupancy,
      bedType: roomSeed.bedType,
      sizeSqm: roomSeed.sizeSqm,
      images: roomImages,
      amenities,
    };
  });

  return {
    id: seed.id,
    name: seed.name,
    starRating: seed.starRating,
    category: seed.category,
    description: seed.description,
    address: {
      street: seed.street,
      city: seed.city,
      state: seed.state,
      country: seed.country,
      countryCode: seed.countryCode,
      postalCode: seed.postalCode,
      timeZone: seed.timeZone ?? COUNTRY_TIME_ZONES[seed.countryCode] ?? 'UTC',
    },
    geo: { latitude: seed.latitude, longitude: seed.longitude },
    images,
    amenities: seed.amenities,
    roomTypes,
    checkInTime: seed.checkInTime,
    checkOutTime: seed.checkOutTime,
    policies: seed.policies,
  };
}

/** The stable hotel ids of the catalogue, in catalogue order. */
export function catalogHotelIds(): string[] {
  return HOTEL_SEEDS.map((seed) => seed.id);
}

/** Deterministic confirmation number derived from the booking key. */
export function confirmationNumberFor(key: string): string {
  const rng = new SeededRandom(hashSeed('confirmation', key));
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = 'AG';
  for (let i = 0; i < 6; i += 1) {
    out += letters[rng.int(0, letters.length - 1)];
  }
  for (let i = 0; i < 4; i += 1) {
    out += String(rng.int(0, 9));
  }
  return out;
}
