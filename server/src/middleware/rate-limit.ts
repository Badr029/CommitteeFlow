import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

/**
 * Rate limiting (spec §62).
 *
 * Two tiers: an aggressive one on login to blunt credential stuffing, and a
 * looser one across write endpoints so a runaway client or a scripted abuse
 * attempt cannot saturate the database.
 *
 * The in-memory store is deliberate — the MVP runs a single app container and
 * the spec rules out Redis (§74). Scaling to multiple containers means either a
 * shared store or limiting at the reverse proxy; both are noted in the README.
 */

const tooMany = (message: string) => new AppError(429, 'RATE_LIMITED', message);

export function loginRateLimiter(): RequestHandler {
  const config = env();
  return rateLimit({
    windowMs: config.LOGIN_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: config.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Successful sign-ins should not count towards the limit.
    skipSuccessfulRequests: true,
    // Bucket per source address *and* per submitted account, so one attacker
    // cannot lock every colleague out by guessing their addresses from one IP.
    keyGenerator: (req) => {
      // `req.body` is `any` by Express's own typing; narrow it before use.
      const body = req.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
      return `${ipKeyGenerator(req.ip ?? '')}|${email}`;
    },
    handler: (_req, _res, next) => {
      next(tooMany('Too many sign-in attempts. Please wait a few minutes and try again.'));
    },
  });
}

export function writeRateLimiter(): RequestHandler {
  const config = env();
  return rateLimit({
    windowMs: config.WRITE_RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    limit: config.WRITE_RATE_LIMIT_MAX,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Authenticated users get their own bucket; anonymous traffic shares by IP.
    keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''),
    handler: (_req, _res, next) => {
      next(tooMany('You are making changes very quickly. Please slow down.'));
    },
  });
}
