import winston from 'winston';
import path from 'path';
import fs from 'fs';

const logsDir = path.resolve('./logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Application-wide logger using Winston.
 * Logs to both console (colorized) and file (JSON format).
 */
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
  ),
  defaultMeta: { service: 'job-tracker' },
  transports: [
    /** File transport: JSON format for machine parsing */
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json(),
      ),
      maxsize: 5_242_880, // 5MB
      maxFiles: 3,
    }),
    /** Error-only file for quick error review */
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json(),
      ),
      maxsize: 5_242_880,
      maxFiles: 3,
    }),
    /** Console transport: colorized and human-readable */
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `[${timestamp}] ${level}: ${message}${metaStr}`;
        }),
      ),
    }),
  ],
});
