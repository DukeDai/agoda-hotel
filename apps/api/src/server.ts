import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { loadConfig, type Config } from './config.js';
import { createPinoLogger } from './lib/logger.js';
import { registerErrorHandler } from './lib/errors.js';
import type { AppContext } from './lib/context.js';
import { createContext } from './lib/bootstrap.js';
import { registerCatalogRoutes } from './modules/catalog/index.js';
import { registerSearchRoutes } from './modules/search/index.js';
import { registerBookingRoutes } from './modules/booking/index.js';
import { registerPaymentRoutes } from './modules/payment/index.js';
import { registerNotifyRoutes } from './modules/notify/index.js';
import { registerAdminRoutes } from './modules/admin/index.js';

export interface BuildServerOptions {
  config?: Config;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  // The pino-backed instance is typed with a concrete logger generic; the
  // route registrars take the default `FastifyInstance` shape. One cast here
  // keeps every module free of logger-generic noise.
  const app = Fastify({
    loggerInstance: createPinoLogger(config),
    trustProxy: true,
  }) as unknown as FastifyInstance;

  // Keep the raw body so the payment webhook can verify its signature
  // against the exact bytes the gateway signed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    (req as unknown as { rawBody?: string }).rawBody = raw;
    if (!raw) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      const error = err as Error & { statusCode?: number };
      error.statusCode = 400;
      done(error, undefined);
    }
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'OTA Hotel API', version: '0.1.0' },
      tags: [{ name: 'catalog' }, { name: 'search' }, { name: 'booking' }, { name: 'payment' }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  registerErrorHandler(app);

  const ctx: AppContext = createContext(config);

  app.decorate('ctx', ctx);

  await registerCatalogRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerBookingRoutes(app, ctx);
  await registerPaymentRoutes(app, ctx);
  await registerNotifyRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);

  app.get('/health', async () => ({
    status: 'ok',
    supplier: ctx.supplier.name,
    supplierMode: ctx.supplier.mode,
    time: ctx.now().toISOString(),
  }));

  return app;
}
