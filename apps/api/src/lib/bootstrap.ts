import type { PrismaClient } from '@prisma/client';
import { createAgodaAdapter } from '@ota/agoda-connectivity';
import type { Config } from '../config.js';
import { createLogger } from './logger.js';
import { getPrisma } from './prisma.js';
import { createCacheBundle } from './cache.js';
import { createPaymentProvider } from '../modules/payment/index.js';
import type { AppContext } from './context.js';

/**
 * Build the dependency container. Shared by the HTTP server and by scripts
 * (seed, backfills) so that everything sees the same wiring.
 */
export function createContext(config: Config, prismaOverride?: PrismaClient): AppContext {
  const logger = createLogger(config);
  const { cache, lock } = createCacheBundle(config.REDIS_URL || undefined);

  const supplier = createAgodaAdapter({
    mode: config.AGODA_MODE,
    baseUrl: config.AGODA_BASE_URL,
    apiKey: config.AGODA_API_KEY,
    username: config.AGODA_USERNAME,
    password: config.AGODA_PASSWORD,
    contentLanguage: config.AGODA_CONTENT_LANGUAGE,
    maxRetries: config.AGODA_MAX_RETRIES,
    rateLimitRpm: config.AGODA_RATE_LIMIT_RPM,
    rateLimitBurst: config.AGODA_RATE_LIMIT_BURST,
    timeouts: {
      content: config.AGODA_TIMEOUT_CONTENT_SECONDS,
      search: config.AGODA_TIMEOUT_SEARCH_SECONDS,
      precheck: config.AGODA_TIMEOUT_PRECHECK_SECONDS,
      booking: config.AGODA_TIMEOUT_BOOKING_SECONDS,
    },
  }, {
    // Only the mock reacts to these; they make the failure paths
    // reproducible against a running system.
    priceDriftRate: config.AGODA_MOCK_PRICE_DRIFT_RATE,
  });

  return {
    config,
    logger,
    prisma: prismaOverride ?? getPrisma(config),
    cache,
    lock,
    supplier,
    payment: createPaymentProvider(config, logger),
    now: () => new Date(),
  };
}
