import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { startOutboxWorker } from './modules/notify/index.js';
import { pollPendingBookings } from './modules/booking/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildServer({ config });

  // Background pumps. They are intentionally simple intervals: the outbox
  // table is the source of truth, so a restart never loses work.
  const outbox = startOutboxWorker(app.ctx);
  const pollTimer = setInterval(() => {
    void pollPendingBookings(app.ctx).catch((err) => {
      app.ctx.logger.error('booking poll cycle failed', { err });
    });
  }, config.BOOKING_POLL_INTERVAL_SECONDS * 1000);
  pollTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.ctx.logger.info('shutting down', { signal });
    clearInterval(pollTimer);
    outbox.stop();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.ctx.logger.info('ota api listening', {
    port: config.PORT,
    supplierMode: config.AGODA_MODE,
    payment: config.PAYMENT_PROVIDER,
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('failed to start ota api', err);
  process.exit(1);
});
