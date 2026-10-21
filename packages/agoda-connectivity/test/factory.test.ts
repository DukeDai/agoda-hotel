import { describe, expect, it } from 'vitest';
import { AppError } from '@ota/core';
import { createAgodaAdapter } from '../src/factory.js';
import { AgodaLiveAdapter } from '../src/live/adapter.js';
import { AgodaMockAdapter } from '../src/mock/adapter.js';
import { AgodaXmlCodec } from '../src/xml/codec.js';

describe('createAgodaAdapter', () => {
  it('builds the mock adapter in mock mode', async () => {
    const adapter = createAgodaAdapter({ mode: 'mock' });

    expect(adapter).toBeInstanceOf(AgodaMockAdapter);
    expect(adapter.mode).toBe('mock');

    const result = await adapter.searchHotels({
      destination: { cityId: '9398' },
      checkIn: '2026-11-01',
      checkOut: '2026-11-03',
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'USD',
      nationality: 'CN',
    });
    expect(result.hotels.length).toBeGreaterThan(0);
  });

  it('builds the live adapter in live mode', () => {
    const adapter = createAgodaAdapter({
      mode: 'live',
      apiKey: 'k',
      username: 'u',
      password: 'p',
    });

    expect(adapter).toBeInstanceOf(AgodaLiveAdapter);
    expect(adapter.mode).toBe('live');
  });

  it('fails with CONFIG_ERROR when the live credentials are missing', () => {
    try {
      createAgodaAdapter({ mode: 'live' });
      throw new Error('should have thrown');
    } catch (error) {
      expect(AppError.is(error)).toBe(true);
      expect((error as AppError).code).toBe('CONFIG_ERROR');
    }
  });

  it('exposes the whole public surface from the barrel', () => {
    expect(typeof createAgodaAdapter).toBe('function');
    expect(typeof AgodaMockAdapter).toBe('function');
    expect(typeof AgodaLiveAdapter).toBe('function');
    expect(typeof AgodaXmlCodec).toBe('function');
  });
});
