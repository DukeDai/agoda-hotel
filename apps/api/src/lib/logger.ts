import pino from 'pino';
import type { Logger } from '@ota/core';
import type { Config } from '../config.js';

/**
 * pino instance wrapped behind the core `Logger` interface, so that every
 * package logs through the same port and no package depends on pino directly.
 */
export function createPinoLogger(config: Config): pino.Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'ota-api' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'password',
        '*.password',
        'guestEmail',
        '*.guestEmail',
        'email',
        '*.email',
        'phone',
        '*.phone',
      ],
      censor: '[redacted]',
    },
  });
}

export function createLogger(config: Config): Logger {
  const pinoLogger = createPinoLogger(config);

  const wrap = (l: pino.Logger): Logger => ({
    debug: (msg, fields) => l.debug(fields ?? {}, msg),
    info: (msg, fields) => l.info(fields ?? {}, msg),
    warn: (msg, fields) => l.warn(fields ?? {}, msg),
    error: (msg, fields) => l.error(fields ?? {}, msg),
    child: (fields) => wrap(l.child(fields)),
  });

  return wrap(pinoLogger);
}
