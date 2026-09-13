import crypto from "node:crypto";
import connectPgSimple from "connect-pg-simple";
import session from "express-session";
import type { RequestHandler } from "express";
import type { UserRole } from "@shared/api-types.js";
import { env } from "../../config/env.js";
import { getPool } from "../../db/pool.js";

/**
 * Session-backed authentication (spec §39).
 *
 * The session id lives in an HttpOnly cookie and the session itself lives in
 * PostgreSQL. Nothing authentication-related is ever placed in localStorage,
 * and the browser never receives a bearer token it could leak.
 */

declare module "express-session" {
  interface SessionData {
    userId?: string;
    /** Cached for cheap authorisation; re-read from the DB on every request. */
    role?: UserRole;
    /** Double-submit CSRF secret, minted per session (spec §60). */
    csrfToken?: string;
    /** Rotated on login so a pre-auth session id cannot be fixed onto a user. */
    loggedInAt?: string;
    /** Whether this browser explicitly requested a persistent login cookie. */
    rememberMe?: boolean;
  }
}

const PgSession = connectPgSimple(session);

export function buildSessionMiddleware(): RequestHandler {
  const config = env();

  return session({
    name: config.SESSION_NAME,
    secret: config.SESSION_SECRET,
    store: new PgSession({
      pool: getPool(),
      tableName: "session",
      // The schema is owned by our migrations, not by the store.
      createTableIfMissing: false,
      pruneSessionInterval: 60 * 15,
      // Session-only browser cookies still need a bounded server-side lifetime.
      ttl: config.SESSION_TTL_HOURS * 60 * 60,
    }),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: config.TRUST_PROXY > 0,
    cookie: {
      httpOnly: true,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAMESITE,
      path: "/",
    },
  });
}

export function applySessionPersistence(
  activeSession: import("express-session").Session &
    Partial<import("express-session").SessionData>,
  rememberMe: boolean,
): void {
  activeSession.rememberMe = rememberMe;
  if (rememberMe) {
    activeSession.cookie.maxAge = env().REMEMBER_ME_TTL_DAYS * 24 * 60 * 60 * 1000;
  } else {
    activeSession.cookie.expires = undefined;
    activeSession.cookie.originalMaxAge = null;
  }
}

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Normalises the store's `err` callback argument into a real Error. */
function asError(cause: unknown, action: string): Error {
  const detail =
    cause instanceof Error && cause.message
      ? `: ${cause.message}`
      : '';

  return new Error(`session ${action} failed${detail}`, {
    cause,
  });
}
/**
 * Regenerates the session id while carrying the CSRF secret across.
 *
 * Called immediately after a successful password check so a session id an
 * attacker planted before login becomes worthless (session fixation).
 */
export async function regenerateSession(req: {
  session: import("express-session").Session &
    Partial<import("express-session").SessionData>;
}): Promise<void> {
  const csrfToken = req.session.csrfToken;
  const rememberMe = req.session.rememberMe ?? false;
  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) =>
      error ? reject(asError(error, "regenerate")) : resolve(),
    );
  });
  req.session.csrfToken = csrfToken ?? generateCsrfToken();
  applySessionPersistence(req.session, rememberMe);
}

export async function destroySession(req: {
  session: import("express-session").Session;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((error) =>
      error ? reject(asError(error, "destroy")) : resolve(),
    );
  });
}

export async function saveSession(req: {
  session: import("express-session").Session;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) =>
      error ? reject(asError(error, "save")) : resolve(),
    );
  });
}
