import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgodaXmlCodec } from '../src/xml/codec.js';
import { escapeXml } from '../src/xml/builder.js';
import { decimalToMinor, minorToDecimalString } from '../src/xml/parse.js';
import type { SupplierBookingInput, SupplierSearchQuery } from '../src/contract.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/xml/fixtures/${name}`, import.meta.url)), 'utf8');
}

const codec = new AgodaXmlCodec();

const query: SupplierSearchQuery = {
  destination: { cityId: '9398', name: 'Phuket', countryCode: 'TH' },
  checkIn: '2026-11-01',
  checkOut: '2026-11-03',
  rooms: 1,
  adults: 2,
  childAges: [],
  currency: 'USD',
  nationality: 'CN',
};

const bookingInput: SupplierBookingInput = {
  supplierHotelId: '90001',
  offerId: 'AGODA-OFFER|90001|90001-1|90001-1-RP1|2026-11-01|2026-11-03|1|2||USD',
  checkIn: '2026-11-01',
  checkOut: '2026-11-03',
  rooms: 1,
  adults: 2,
  childAges: [],
  currency: 'USD',
  nationality: 'CN',
  guests: [
    {
      firstName: 'Ann & Bob',
      lastName: "<O'Brien>",
      email: 'ann@example.com',
      phone: '+66 2 000 0000',
      nationality: 'CN',
      isLead: true,
    },
  ],
  specialRequests: ['Late arrival & extra pillows'],
  allowDuplication: true,
  idempotencyKey: 'idem-20261101-0001',
  contextFingerprint: '3f1c0a9d2b8e4c7a',
  expectedTotal: { amount: 44000, currency: 'USD' },
};

describe('AgodaXmlCodec', () => {
  it('encodes a search request with the stay, occupancy, currency and fingerprint', () => {
    const xml = codec.encodeSearchRequest(query);

    expect(xml).toContain('<OTA_HotelAvailRQ>');
    expect(xml).toContain('<CityID>9398</CityID>');
    expect(xml).toContain('<CountryCode>TH</CountryCode>');
    expect(xml).toContain('<TimeSpan Start="2026-11-01" End="2026-11-03"/>');
    expect(xml).toContain('<AdultCount>2</AdultCount>');
    expect(xml).toContain('<Currency>USD</Currency>');
    expect(xml).toContain('<Nationality>CN</Nationality>');
    expect(xml).toContain('<Rooms>1</Rooms>');
  });

  it('decodes an availability fixture into supplier DTOs', () => {
    const [availability] = codec.decodeAvailabilityResponse(fixture('availability-response.xml'));

    expect(availability?.supplierHotelId).toBe('90001');
    expect(availability?.currency).toBe('USD');
    expect(availability?.quotes).toHaveLength(1);

    const quote = availability?.quotes[0];
    expect(quote?.offerId).toBe('AGODA-OFFER|90001|90001-1|90001-1-RP1|2026-11-01|2026-11-03|1|2||USD');
    expect(quote?.roomTypeId).toBe('90001-1');
    expect(quote?.ratePlanId).toBe('90001-1-RP1');
    expect(quote?.roomTypeName).toBe('Deluxe King Room');
    expect(quote?.bedType).toBe('King bed');
    expect(quote?.maxOccupancy).toBe(2);
    expect(quote?.nights).toBe(2);
    expect(quote?.allotment).toBe(3);
    expect(quote?.mealPlan).toBe('BREAKFAST_AVAILABLE');
    expect(quote?.payAtHotel).toBe(true);
    expect(quote?.instantConfirmation).toBe(true);
    expect(quote?.taxesIncluded).toBe(false);

    // Money is integer minor units, never a float.
    expect(quote?.nightly.total).toEqual({ amount: 22000, currency: 'USD' });
    expect(quote?.nightly.net).toEqual({ amount: 19643, currency: 'USD' });
    expect(quote?.nightly.taxes).toEqual({ amount: 2357, currency: 'USD' });
    expect(quote?.stayTotal.total).toEqual({ amount: 44000, currency: 'USD' });

    const policy = quote?.cancellationPolicy;
    expect(policy?.type).toBe('FULL_REFUND');
    expect(policy?.refundable).toBe(true);
    expect(policy?.freeCancellationUntil).toBe('2026-10-29');
    expect(policy?.penaltyAmount).toEqual({ amount: 0, currency: 'USD' });
  });

  it('decodes a search fixture into hotel summaries', () => {
    const result = codec.decodeSearchResponse(fixture('availability-response.xml'));

    expect(result.total).toBe(2);
    expect(result.currency).toBe('USD');
    expect(result.hotels).toHaveLength(2);
    expect(result.hotels[0]?.name).toBe('Patong Bayview Resort');
    expect(result.hotels[0]?.starRating).toBe(5);
    expect(result.hotels[0]?.address.city).toBe('Phuket');
    expect(result.hotels[0]?.address.countryCode).toBe('TH');
    expect(result.hotels[0]?.lowestNightlyTotal).toEqual({ amount: 22000, currency: 'USD' });
    expect(result.hotels[0]?.lowestStayTotal).toEqual({ amount: 44000, currency: 'USD' });
    expect(result.hotels[0]?.thumbnail).toBe('https://cdn.agoda.mock/hotels/90001/1.jpg');
  });

  it('surfaces the processing flag faithfully', () => {
    const result = codec.decodeBookingResponse(fixture('booking-processing-response.xml'));

    expect(result.status).toBe('PROCESSING');
    expect(result.processing).toBe(true);
    expect(result.confirmationNumber).toBeUndefined();
    expect(result.total).toEqual({ amount: 44000, currency: 'USD' });
  });

  it('decodes a confirmed booking', () => {
    const result = codec.decodeBookingResponse(fixture('booking-confirmed-response.xml'));

    expect(result.status).toBe('CONFIRMED');
    expect(result.processing).toBe(false);
    expect(result.confirmationNumber).toBe('AGX7K2P441');
  });

  it('decodes a rejected booking with the supplier error code', () => {
    const result = codec.decodeBookingResponse(fixture('booking-rejected-response.xml'));

    expect(result.status).toBe('REJECTED');
    expect(result.errorCode).toBe('DUPLICATE_BOOKING');
    expect(result.errorMessage).toContain('overlapping dates');
  });

  it('decodes a cancellation response', () => {
    const result = codec.decodeCancelResponse(fixture('cancel-response.xml'));

    expect(result.cancelled).toBe(true);
    expect(result.refundAmount).toEqual({ amount: 44000, currency: 'USD' });
    expect(result.penaltyAmount).toEqual({ amount: 0, currency: 'USD' });
  });
});

describe('XML escaping', () => {
  it('escapes the five predefined entities', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });

  it('escapes guest names and special requests in the booking request', () => {
    const xml = codec.encodeBookingRequest(bookingInput);

    expect(xml).toContain('<GivenName>Ann &amp; Bob</GivenName>');
    expect(xml).toContain('<Surname>&lt;O&apos;Brien&gt;</Surname>');
    expect(xml).toContain('<SpecialRequest>Late arrival &amp; extra pillows</SpecialRequest>');

    // The raw metacharacters must never reach the body unescaped.
    expect(xml).not.toContain('Ann & Bob');
    expect(xml).not.toContain("<O'Brien>");
  });

  it('round trips a guest name with metacharacters through a request', () => {
    const xml = codec.encodeBookingRequest(bookingInput);
    const parsed = new AgodaXmlCodec().decodeBookingDetailResponse(
      xml.replace(/<OTA_HotelResRQ>/, '<OTA_HotelResRS>').replace(/<\/OTA_HotelResRQ>/, '</OTA_HotelResRS>'),
    );

    expect(parsed.guests[0]?.firstName).toBe('Ann & Bob');
    expect(parsed.guests[0]?.lastName).toBe("<O'Brien>");
  });
});

describe('defensive parsing', () => {
  it('does not throw on malformed XML', () => {
    expect(() => codec.decodeAvailabilityResponse('<OTA_HotelAvailRS><broken')).not.toThrow();
    expect(() => codec.decodeBookingResponse('not xml at all')).not.toThrow();
    expect(() => codec.decodeHotelListResponse('')).not.toThrow();
  });

  it('returns an empty result for a malformed document', () => {
    expect(codec.decodeAvailabilityResponse('<OTA_HotelAvailRS><broken')).toEqual([]);
    expect(codec.decodeHotelListResponse('<<<>>>')).toEqual([]);
  });

  it('never produces NaN money', () => {
    const broken = `<OTA_HotelAvailRS><AvailResponseSegments><AvailResponseSegment>
      <HotelID>90001</HotelID>
      <AdditionalInfo><Currency>USD</Currency></AdditionalInfo>
      <RoomStays><RoomStay><Rates><RatePlan>
        <OfferId>OFFER-1</OfferId>
        <RatePlanCode>RP-1</RatePlanCode>
        <Rates><Rate>
          <Nightly><Amount>abc</Amount><NetAmount>NaN</NetAmount><TaxAmount></TaxAmount><Currency>USD</Currency></Nightly>
          <Stay><Amount>100.00</Amount><Currency>USD</Currency></Stay>
        </Rate></Rates>
      </RatePlan></Rates></RoomStay></RoomStays>
    </AvailResponseSegment></AvailResponseSegments></OTA_HotelAvailRS>`;

    const [availability] = codec.decodeAvailabilityResponse(broken);
    const quote = availability?.quotes[0];

    // The nightly amount is malformed -> the quote is dropped, not NaN.
    expect(quote).toBeUndefined();
    expect(JSON.stringify(availability)).not.toContain('null,null');
  });

  it('rejects dates that are not YYYY-MM-DD', () => {
    const broken = `<OTA_HotelAvailRS><AvailResponseSegments><AvailResponseSegment>
      <HotelID>90001</HotelID>
      <AdditionalInfo><Currency>USD</Currency></AdditionalInfo>
      <RoomStays><RoomStay><Rates><RatePlan>
        <OfferId>OFFER-1</OfferId>
        <RatePlanCode>RP-1</RatePlanCode>
        <Rates><Rate>
          <Nightly><Amount>100.00</Amount><Currency>USD</Currency></Nightly>
          <Stay><Amount>200.00</Amount><Currency>USD</Currency></Stay>
        </Rate></Rates>
        <CancellationPolicy>
          <CancellationPolicyType>FULL_REFUND</CancellationPolicyType>
          <FreeCancellationUntil>01/11/2026</FreeCancellationUntil>
        </CancellationPolicy>
      </RatePlan></Rates></RoomStay></RoomStays>
    </AvailResponseSegment></AvailResponseSegments></OTA_HotelAvailRS>`;

    const [availability] = codec.decodeAvailabilityResponse(broken);
    expect(availability?.quotes[0]?.cancellationPolicy.freeCancellationUntil).toBeUndefined();
  });

  it('converts decimal strings to integer minor units without floats', () => {
    expect(decimalToMinor('12.50', 2)).toBe(1250);
    expect(decimalToMinor('12.5', 2)).toBe(1250);
    expect(decimalToMinor('12', 2)).toBe(1200);
    expect(decimalToMinor('0.005', 2)).toBe(1);
    expect(decimalToMinor('12.345', 2)).toBe(1235);
    expect(decimalToMinor('12', 0)).toBe(12);
    expect(decimalToMinor('abc', 2)).toBeUndefined();
    expect(decimalToMinor('', 2)).toBeUndefined();
    expect(decimalToMinor('NaN', 2)).toBeUndefined();
    expect(decimalToMinor('Infinity', 2)).toBeUndefined();
  });

  it('renders minor units back to a decimal string', () => {
    expect(minorToDecimalString(22000, 'USD')).toBe('220.00');
    expect(minorToDecimalString(22000, 'JPY')).toBe('22000');
    expect(minorToDecimalString(0, 'USD')).toBe('0.00');
  });
});
