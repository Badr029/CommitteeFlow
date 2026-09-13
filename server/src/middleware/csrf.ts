import crypto from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { generateCsrfToken } from '../modules/auth/session.js';

/**
 * CSRF protection for a cookie-session application (spec §60).
 *
 * Synchroniser-token pattern: the secret lives in the server-side session, and
 * the client must echo it in a request header. A cross-site form post carries
 * the session cookie but cannot read the token, so it fails here.
 *
 * CORS is explicitly *not* treated as CSRF protection — a simple form post is
 * not preflighted, so a permissive CORS policy would never have blocked it.
 */

export const CSRF_HEADER = 'x-csrf-token';
/** Mirror cookie, readable by JS purely so the SPA can bootstrap the header. */
export const CSRF_COOKIE = 'committeeflow.csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function issueCsrfCookie(res: Response, token: string, rememberMe = false): void {
  const config = env();
  res.cookie(CSRF_COOKIE, token, {
    // Intentionally readable by the SPA — the secret's protection is that a
    // cross-origin page cannot read it, not that JS cannot.
    httpOnly: false,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    path: '/',
    ...(rememberMe
      ? { maxAge: config.REMEMBER_ME_TTL_DAYS * 24 * 60 * 60 * 1000 }
      : {}),
  });
}

/** Ensures the session has a CSRF secret and keeps the mirror cookie in sync. */
export const attachCsrfToken: RequestHandler = (req, res, next) => {
  if (!req.session) return next();

  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  if (req.cookies?.[CSRF_COOKIE] !== req.session.csrfToken) {
    issueCsrfCookie(res, req.session.csrfToken, req.session.rememberMe);
  }
  next();
};

/** Rejects unsafe methods whose header token does not match the session's. */
export const verifyCsrf: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();

  const expected = req.session?.csrfToken;
  const provided = req.get(CSRF_HEADER);

  if (!expected || !provided || !timingSafeEqual(expected, provided)) {
    return next(
      new AppError(
        403,
        'INVALID_CSRF_TOKEN',
        'Your session security token is missing or stale. Reload the page and try again.',
      ),
    );
  }
  return next();
};
