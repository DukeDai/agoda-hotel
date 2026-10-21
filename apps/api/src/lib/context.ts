import type { PrismaClient } from '@prisma/client';
import type { Logger } from '@ota/core';
import type { SupplierAdapter } from '@ota/agoda-connectivity';
import type { Config } from '../config.js';
import type { Cache, Lock } from './cache.js';
import type { PaymentProvider } from './payment-provider.js';

/**
 * The single dependency container handed to every module.
 * Modules must not import each other's internals; they go through this.
 */
export interface AppContext {
  config: Config;
  logger: Logger;
  prisma: PrismaClient;
  cache: Cache;
  lock: Lock;
  supplier: SupplierAdapter;
  payment: PaymentProvider;
  /** Injectable clock, so tests can control time. */
  now: () => Date;
}
