import { createLogger, format, transports } from 'winston';
import { config } from '../config';

const { combine, timestamp, json, colorize, printf } = format;

const devFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const extras = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${ts} [${level}] ${message}${extras}`;
  }),
);

const prodFormat = combine(timestamp(), json());

export const logger = createLogger({
  level: config.LOG_LEVEL,
  format: config.NODE_ENV === 'production' ? prodFormat : devFormat,
  transports: [new transports.Console()],
  exitOnError: false,
});

/** Child logger with a fixed context object merged into every log entry */
export function childLogger(context: Record<string, unknown>) {
  return logger.child(context);
}