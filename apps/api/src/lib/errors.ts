import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, toAppError } from '@ota/core';

/**
 * One error shape for the whole API.
 * Business errors carry a stable code; unexpected errors are logged with a
 * stack and returned as a generic INTERNAL_ERROR (no internals leaked).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const appError = toAppError(err);
    const level = appError.status >= 500 ? 'error' : 'warn';

    req.log[level](
      { err: appError, code: appError.code, status: appError.status },
      `request failed: ${appError.message}`,
    );

    // Fastify validation errors (schema) are business errors.
    if (isFastifyValidationError(err)) {
      const validation = new AppError('VALIDATION_ERROR', 'Request validation failed', {
        details: { issues: err.validation },
      });
      void reply.status(400).send(validation.toJSON());
      return;
    }

    void reply.status(appError.status).send(appError.toJSON());
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url} not found`,
        retryable: false,
        details: {},
      },
    });
  });
}

function isFastifyValidationError(err: unknown): err is { validation: unknown } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'validation' in err &&
    'statusCode' in err &&
    (err as { statusCode?: number }).statusCode === 400
  );
}
