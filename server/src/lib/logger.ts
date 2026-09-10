import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Structured logging (spec §70).
 *
 * `redact` is the safety net: passwords, session values and secrets must never
 * reach the log stream even if a caller passes a whole request or config object.
 */
export const logger = pino({
  level: env().LOG_LEVEL,
  base: { service: 'committeeflow' },
  redact: {
    paths: [
      'password',
      'passwordHash',
      'password_hash',
      '*.password',
      '*.passwordHash',
      '*.password_hash',
      'req.body.password',
      'req.body.currentPassword',
      'req.body.newPassword',
      'req.headers.cookie',
      'req.headers.authorization',
      'res.headers["set-cookie"]',
      'SESSION_SECRET',
      'SMTP_PASSWORD',
      'DATABASE_URL',
    ],
    censor: '[redacted]',
  },
  transport:
    env().NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});

export type Logger = typeof logger;
