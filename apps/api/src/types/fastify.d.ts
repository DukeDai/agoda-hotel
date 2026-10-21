import 'fastify';
import type { AppContext } from '../lib/context.js';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }

  interface FastifyRequest {
    /** The exact bytes received, used for webhook signature verification. */
    rawBody?: string;
  }
}
