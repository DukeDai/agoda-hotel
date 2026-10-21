export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface ConsoleLoggerOptions {
  level?: LogLevel;
  name?: string;
  sink?: (line: string) => void;
}

/** Structured JSON logger. The API wires pino to this interface. */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const min = LEVELS[level];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const emit = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[lvl] < min) return;
    const payload = {
      ts: new Date().toISOString(),
      level: lvl,
      name: options.name,
      msg,
      ...fields,
    };
    sink(JSON.stringify(payload));
  };

  const base: Logger = {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => {
      const parent = base;
      return {
        debug: (msg, f) => parent.debug(msg, { ...fields, ...f }),
        info: (msg, f) => parent.info(msg, { ...fields, ...f }),
        warn: (msg, f) => parent.warn(msg, { ...fields, ...f }),
        error: (msg, f) => parent.error(msg, { ...fields, ...f }),
        child: (more) => base.child({ ...fields, ...more }),
      };
    },
  };
  return base;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
