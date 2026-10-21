import type { SupplierAdapter, SupplierAdapterConfig } from './contract.js';
import { AgodaLiveAdapter } from './live/adapter.js';
import { AgodaMockAdapter, type AgodaMockOptions } from './mock/adapter.js';

/**
 * Build the Agoda supplier adapter for the requested mode.
 *
 * `mock`  -> the in-process simulator (no credentials, deterministic).
 * `live`  -> the real Agoda Demand API (HTTPS + XML). Credentials are
 *            issued by Agoda after the commercial approval; the live
 *            adapter fails fast with CONFIG_ERROR when they are missing.
 *
 * `mockOptions` only applies to the mock: they are the knobs a demo or a
 * staging environment uses to reproduce the failures the real supplier
 * produces (price drift, sell-outs, a supplier that never confirms).
 */
export function createAgodaAdapter(
  config: SupplierAdapterConfig,
  mockOptions?: Omit<AgodaMockOptions, 'config'>,
): SupplierAdapter {
  if (config.mode === 'mock') {
    return new AgodaMockAdapter({ ...mockOptions, config });
  }
  return new AgodaLiveAdapter({ config });
}
