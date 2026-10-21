import { describe, expect, it } from 'vitest';
import { AppError } from '@ota/core';
import type { LogFields, Logger } from '@ota/core';
import { AgodaLiveAdapter, DEFAULT_TIMEOUTS } from '../src/live/adapter.js';
import type { FetchInitLike, FetchLike } from '../src/live/transport.js';
import type { SupplierBookingInput } from '../src/contract.js';

interface CapturedLog {
  level: string;
  msg: string;
  fields: LogFields;
}

const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quietLogger,
};

function capturingLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const push = (level: string) => (msg: string, fields?: LogFields) => {
    logs.push({ level, msg, fields: fields ?? {} });
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return { logger, logs };
}

const credentials = {
  mode: 'live' as const,
  apiKey: 'test-api-key',
  username: 'test-user',
  password: 'test-password',
  baseUrl: 'https://agoda.test',
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
      firstName: 'Ann',
      lastName: 'Lee',
      email: 'ann@example.com',
      phone: '+66 2 000 0000',
      nationality: 'CN',
      isLead: true,
    },
  ],
  specialRequests: ['Late arrival'],
  allowDuplication: true,
  idempotencyKey: 'idem-1',
  contextFingerprint: 'fp-1',
  expectedTotal: { amount: 44000, currency: 'USD' },
};

function respondWith(status: number, body: string): FetchLike {
  return async () => ({ status, text: async () => body });
}

describe('AgodaLiveAdapter - configuration', () => {
  it('fails with CONFIG_ERROR when the credentials are missing', () => {
    expect(() => new AgodaLiveAdapter({ config: { mode: 'live' } })).toThrow(AppError);

    try {
      // eslint-disable-next-line no-new
      new AgodaLiveAdapter({ config: { mode: 'live' } });
      throw new Error('should have thrown');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe('CONFIG_ERROR');
      expect((error as AppError).message).toMatch(/credentials/i);
    }
  });

  it('does not require credentials at import time', async () => {
    const module = await import('../src/index.js');
    expect(typeof module.createAgodaAdapter).toBe('function');
    expect(typeof module.AgodaLiveAdapter).toBe('function');
    expect(typeof module.AgodaMockAdapter).toBe('function');
    expect(typeof module.AgodaXmlCodec).toBe('function');
  });
});

describe('AgodaLiveAdapter - timeouts', () => {
  it('uses one timeout per endpoint, never a single global value', () => {
    const adapter = new AgodaLiveAdapter({ config: credentials });

    expect(adapter.timeouts.precheck).toBe(60_000);
    expect(adapter.timeouts.booking).toBe(120_000);
    expect(adapter.timeouts.search).toBe(30_000);
    expect(adapter.timeouts.content).toBe(30_000);
    expect(adapter.timeouts.detail).toBe(30_000);
    expect(adapter.timeouts.cancel).toBe(30_000);
    expect(DEFAULT_TIMEOUTS.precheck).toBe(60_000);
    expect(DEFAULT_TIMEOUTS.booking).toBe(120_000);
  });

  it('lets the configuration override a single endpoint timeout', () => {
    const adapter = new AgodaLiveAdapter({
      config: { ...credentials, timeouts: { precheck: 5_000 } },
    });

    expect(adapter.timeouts.precheck).toBe(5_000);
    expect(adapter.timeouts.booking).toBe(120_000);
  });

  it('aborts the upstream call through the AbortSignal when the budget is exhausted', async () => {
    const adapter = new AgodaLiveAdapter({
      config: { ...credentials, timeouts: { precheck: 40 }, maxRetries: 0 },
      logger: quietLogger,
      fetchImpl: (_url, init: FetchInitLike) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
    });

    const started = Date.now();
    await expect(
      adapter.precheck({
        supplierHotelId: '90001',
        offerId: bookingInput.offerId,
        checkIn: bookingInput.checkIn,
        checkOut: bookingInput.checkOut,
        rooms: bookingInput.rooms,
        adults: bookingInput.adults,
        childAges: bookingInput.childAges,
        currency: bookingInput.currency,
        nationality: bookingInput.nationality,
        contextFingerprint: bookingInput.contextFingerprint,
      }),
    ).rejects.toMatchObject({ code: 'SUPPLIER_TIMEOUT' });

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('AgodaLiveAdapter - booking is never blindly retried', () => {
  it('performs exactly ONE upstream attempt when the booking call fails', async () => {
    let attempts = 0;
    const adapter = new AgodaLiveAdapter({
      config: { ...credentials, maxRetries: 5 },
      logger: quietLogger,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error('socket hang up');
      },
    });

    await expect(adapter.book(bookingInput)).rejects.toMatchObject({ code: 'SUPPLIER_ERROR' });
    expect(attempts).toBe(1);
  });

  it('does not retry a booking that comes back as a 500', async () => {
    let attempts = 0;
    const adapter = new AgodaLiveAdapter({
      config: { ...credentials, maxRetries: 5 },
      logger: quietLogger,
      fetchImpl: async () => {
        attempts += 1;
        return { status: 500, text: async () => '<OTA_HotelResRS><Error>boom</Error></OTA_HotelResRS>' };
      },
    });

    await expect(adapter.book(bookingInput)).rejects.toMatchObject({ code: 'SUPPLIER_ERROR' });
    expect(attempts).toBe(1);
  });

  it('still retries the SAFE read calls', async () => {
    let attempts = 0;
    const adapter = new AgodaLiveAdapter({
      config: { ...credentials, maxRetries: 2 },
      logger: quietLogger,
      retryBaseDelayMs: 1,
      fetchImpl: async () => {
        attempts += 1;
        return { status: 503, text: async () => '' };
      },
    });

    await expect(adapter.searchHotels({
      destination: { cityId: '9398' },
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'USD',
      nationality: 'CN',
    })).rejects.toMatchObject({ code: 'SUPPLIER_ERROR' });

    expect(attempts).toBe(3); // 1 initial attempt + 2 retries
  });
});

describe('AgodaLiveAdapter - error mapping', () => {
  const cases: { status: number; code: string }[] = [
    { status: 401, code: 'SUPPLIER_AUTH_ERROR' },
    { status: 403, code: 'SUPPLIER_AUTH_ERROR' },
    { status: 429, code: 'SUPPLIER_RATE_LIMITED' },
    { status: 500, code: 'SUPPLIER_ERROR' },
    { status: 404, code: 'NOT_FOUND' },
  ];

  for (const { status, code } of cases) {
    it(`maps HTTP ${status} to ${code}`, async () => {
      const adapter = new AgodaLiveAdapter({
        config: { ...credentials, maxRetries: 0 },
        logger: quietLogger,
        fetchImpl: respondWith(status, ''),
      });

      await expect(
        adapter.getBooking('AGBK-1'),
      ).rejects.toMatchObject({ code });
    });
  }

  it('maps a supplier business error code to the matching AppError', async () => {
    const adapter = new AgodaLiveAdapter({
      config: { ...credentials, maxRetries: 0 },
      logger: quietLogger,
      fetchImpl: respondWith(409, '<OTA_HotelResRS><Error Code="ROOM_UNAVAILABLE">sold out</Error></OTA_HotelResRS>'),
    });

    await expect(adapter.getBooking('AGBK-1')).rejects.toMatchObject({ code: 'ROOM_UNAVAILABLE' });
  });

  it('turns a rejected booking into BOOKING_REJECTED with the supplier code', async () => {
    const adapter = new AgodaLiveAdapter({
      config: credentials,
      logger: quietLogger,
      fetchImpl: respondWith(
        200,
        `<OTA_HotelResRS><HotelReservations><HotelReservation>
           <UniqueID Id="" CompanyName="Agoda"/>
           <ResStatus>Rejected</ResStatus>
           <ResGlobalInfo><Error Code="DUPLICATE_BOOKING">duplicate</Error></ResGlobalInfo>
         </HotelReservation></HotelReservations></OTA_HotelResRS>`,
      ),
    });

    await expect(adapter.book(bookingInput)).rejects.toMatchObject({
      code: 'BOOKING_REJECTED',
      details: { supplierCode: 'DUPLICATE_BOOKING' },
    });
  });

  it('raises PRICE_CHANGED when the supplier charges more than expected', async () => {
    const adapter = new AgodaLiveAdapter({
      config: credentials,
      logger: quietLogger,
      fetchImpl: respondWith(
        200,
        `<OTA_HotelResRS><HotelReservations><HotelReservation>
           <UniqueID Id="AGBK-1" CompanyName="Agoda"/>
           <ResStatus>Confirmed</ResStatus>
           <ResGlobalInfo><Processing>false</Processing></ResGlobalInfo>
           <ResConfirmation><ConfirmationNumber>AG123</ConfirmationNumber></ResConfirmation>
           <Total><TotalAmount>500.00</TotalAmount><Currency>USD</Currency></Total>
         </HotelReservation></HotelReservations></OTA_HotelResRS>`,
      ),
    });

    await expect(adapter.book(bookingInput)).rejects.toMatchObject({ code: 'PRICE_CHANGED' });
  });
});

describe('AgodaLiveAdapter - logging', () => {
  it('logs the upstream call with endpoint, duration, status and correlation id', async () => {
    const { logger, logs } = capturingLogger();
    const adapter = new AgodaLiveAdapter({
      config: credentials,
      logger,
      fetchImpl: respondWith(
        200,
        '<OTA_HotelResRS><HotelReservations><HotelReservation><UniqueID Id="AGBK-1" CompanyName="Agoda"/><ResStatus>Confirmed</ResStatus></HotelReservation></HotelReservations></OTA_HotelResRS>',
      ),
    });

    await adapter.getBooking('AGBK-1');

    const entry = logs.find((log) => log.msg === 'agoda.upstream.ok');
    expect(entry).toBeDefined();
    expect(entry?.fields.endpoint).toBe('detail');
    expect(entry?.fields.status).toBe(200);
    expect(typeof entry?.fields.durationMs).toBe('number');
    expect(typeof entry?.fields.correlationId).toBe('string');
  });

  it('never logs the guest email or phone', async () => {
    const { logger, logs } = capturingLogger();
    const adapter = new AgodaLiveAdapter({
      config: credentials,
      logger,
      fetchImpl: respondWith(
        200,
        '<OTA_HotelResRS><HotelReservations><HotelReservation><UniqueID Id="AGBK-1" CompanyName="Agoda"/><ResStatus>Confirmed</ResStatus><ResGlobalInfo><Processing>false</Processing></ResGlobalInfo><Total><TotalAmount>440.00</TotalAmount><Currency>USD</Currency></Total></HotelReservation></HotelReservations></OTA_HotelResRS>',
      ),
    });

    await adapter.book(bookingInput);

    const dumped = JSON.stringify(logs);
    expect(dumped).not.toContain('ann@example.com');
    expect(dumped).not.toContain('+66 2 000 0000');
  });
});
