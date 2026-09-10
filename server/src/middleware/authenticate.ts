import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { CurrentUser } from '@shared/api-types.js';
import { forbidden, unauthenticated } from '../lib/errors.js';
import { asyncHandler } from '../lib/http.js';
import * as usersRepository from '../modules/users/users.repository.js';
import type { UserRecord } from '../modules/users/users.repository.js';

/**
 * Authentication and role gates.
 *
 * Hiding a button in React is UX, not security (spec §41): every write route
 * passes through these guards, and object-level checks happen additionally in
 * the services that own the object (spec §42).
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present only after `requireAuth` has run. */
      user?: UserRecord;
    }
  }
}

export function toCurrentUser(user: UserRecord): CurrentUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    canManagePlanConfiguration: user.canManagePlanConfiguration,
    notifyByEmail: user.notifyByEmail,
    permissions: {
      canCreateBooking: user.role === 'PROJECT_ENGINEER',
      canManagePlanConfiguration: user.canManagePlanConfiguration,
      canExport: true,
    },
  };
}

/**
 * Loads the session's user from the database on every request.
 *
 * Deliberately not cached in the session: a deactivated account or a revoked
 * permission must take effect on the next request, not when the cookie expires.
 */
export const requireAuth: RequestHandler = asyncHandler(async (req, _res, next) => {
  const userId = req.session?.userId;
  if (!userId) {
    throw unauthenticated();
  }

  const user = await usersRepository.findById(userId);
  if (!user || !user.isActive) {
    // The account is gone or disabled — drop the session rather than 403 loop.
    req.session.destroy(() => undefined);
    throw unauthenticated('Your session is no longer valid. Please sign in again.');
  }

  req.user = user;
  next();
});

/** The authenticated user, or a hard failure if a route forgot `requireAuth`. */
export function currentUser(req: Request): UserRecord {
  if (!req.user) {
    throw unauthenticated();
  }
  return req.user;
}

/** Write access to bookings (spec §4.1, §41). */
export const requireEngineer: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const user = currentUser(req);
  if (user.role !== 'PROJECT_ENGINEER') {
    return next(forbidden('Only Project Engineers can change bookings.'));
  }
  return next();
};

/**
 * Plan Configuration access (spec §5).
 *
 * A permission flag, not a third role — the MVP deliberately keeps two roles.
 */
export const requirePlanManager: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const user = currentUser(req);
  if (!user.canManagePlanConfiguration) {
    return next(forbidden('You do not have permission to manage the plan configuration.'));
  }
  return next();
};
