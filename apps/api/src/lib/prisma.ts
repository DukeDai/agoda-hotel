import { PrismaClient } from '@prisma/client';
import type { Config } from '../config.js';

let client: PrismaClient | undefined;

export function getPrisma(config?: Config): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: config?.DATABASE_URL ?? process.env.DATABASE_URL } },
      log: config?.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
