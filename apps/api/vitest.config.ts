import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    // The e2e suite talks to a real Postgres and a real Fastify instance;
    // running files sequentially keeps the database deterministic.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://dukedai@localhost:5432/ota_hotel_test?schema=public',      AGODA_MODE: 'mock',
      PAYMENT_PROVIDER: 'mock',
      PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret',
      FULFILLMENT_MODE: 'partner',
      NOTIFY_CHANNELS: 'email',
      NOTIFY_MAX_ATTEMPTS: '3',
      NOTIFY_ESCALATION_THRESHOLD: '2',
      BOOKING_POLL_INTERVAL_SECONDS: '15',
      REDIS_URL: '',
    },
  },
});
