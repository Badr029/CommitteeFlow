import { Router } from 'express';
import { z } from 'zod';
import type { ChangePasswordRequest, SessionResponse } from '@shared/api-types.js';
import { asyncHandler, parseBody } from '../../lib/http.js';
import { unauthenticated, validationFailed } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { requireAuth, toCurrentUser } from '../../middleware/authenticate.js';
import { CSRF_COOKIE, issueCsrfCookie } from '../../middleware/csrf.js';
import { loginRateLimiter } from '../../middleware/rate-limit.js';
import { getSettings } from '../plan-config/settings.service.js';
import * as usersRepository from '../users/users.repository.js';
import { fakeVerify, hashPassword, passwordPolicyIssues, verifyPassword } from './password.js';
import {
  applySessionPersistence,
  destroySession,
  generateCsrfToken,
  regenerateSession,
  saveSession,
} from './session.js';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').max(320),
  password: z.string().min(1, 'Enter your password.').max(256),
  rememberMe: z.boolean().default(false),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().max(256).optional(),
  newPassword: z.string().min(1, 'Enter a new password.').max(256),
});

/** How long an account stays locked after too many failed attempts. */
const ACCOUNT_LOCK_MINUTES = 15;

export function authRouter(): Router {
  const router = Router();

  /**
   * POST /api/auth/login
   *
   * Rate limited per address+account (spec §62). Failures are deliberately
   * indistinguishable — unknown email, wrong password and disabled account all
   * return the same message and burn comparable CPU, so the endpoint cannot be
   * used to enumerate who works here.
   */
  router.post(
    '/login',
    loginRateLimiter(),
    asyncHandler(async (req, res) => {
      const { email, password, rememberMe } = parseBody(loginSchema, req.body);
      const genericFailure = unauthenticated('That email or password is not correct.');

      const user = await usersRepository.findByEmail(email);

      if (!user || !user.isActive || !user.passwordHash) {
        await fakeVerify();
        logger.warn({ email, reason: user ? 'inactive_or_no_password' : 'unknown_email' }, 'login failed');
        throw genericFailure;
      }

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        await fakeVerify();
        logger.warn({ userId: user.id }, 'login attempt on locked account');
        throw unauthenticated(
          'This account is temporarily locked after several failed attempts. Try again shortly.',
        );
      }

      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid) {
        await usersRepository.recordFailedLogin(
          user.id,
          env().LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
          ACCOUNT_LOCK_MINUTES,
        );
        logger.warn({ userId: user.id, reason: 'bad_password' }, 'login failed');
        throw genericFailure;
      }

      // New session id on privilege change, defeating session fixation.
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.loggedInAt = new Date().toISOString();
      req.session.csrfToken ??= generateCsrfToken();
      applySessionPersistence(req.session, rememberMe);
      await saveSession(req);

      issueCsrfCookie(res, req.session.csrfToken, rememberMe);
      await usersRepository.recordSuccessfulLogin(user.id);
      logger.info({ userId: user.id, role: user.role }, 'login succeeded');

      const body: SessionResponse = {
        user: toCurrentUser(user),
        settings: await getSettings(),
        csrfToken: req.session.csrfToken,
      };
      res.status(200).json(body);
    }),
  );

  /**
   * GET /api/auth/session
   *
   * The SPA's bootstrap call. Returns 401 when there is no valid session, which
   * the client treats as "show the sign-in screen" rather than as an error.
   */
  router.get(
    '/session',
    requireAuth,
    asyncHandler(async (req, res) => {
      const user = req.user!;
      req.session.csrfToken ??= generateCsrfToken();
      issueCsrfCookie(res, req.session.csrfToken, req.session.rememberMe);

      const body: SessionResponse = {
        user: toCurrentUser(user),
        settings: await getSettings(),
        csrfToken: req.session.csrfToken,
      };
      res.json(body);
    }),
  );

  router.post(
    '/change-password',
    requireAuth,
    asyncHandler(async (req, res) => {
      const input: ChangePasswordRequest = parseBody(changePasswordSchema, req.body);
      const user = req.user!;
      const mustVerifyCurrent = !user.mustChangePassword;
      const validCurrent = input.currentPassword
        ? user.passwordHash && await verifyPassword(user.passwordHash, input.currentPassword)
        : false;
      if (mustVerifyCurrent && !validCurrent) {
        throw validationFailed(
          [{
            field: 'currentPassword',
            message: input.currentPassword
              ? 'Your current password is not correct.'
              : 'Enter your current password.',
          }],
          'Check your current password.',
        );
      }

      const policy = passwordPolicyIssues(input.newPassword);
      if (policy.length > 0) {
        throw validationFailed(
          [{ field: 'newPassword', message: `Use ${policy.join(', ')}.` }],
          'The new password does not meet the password rules.',
        );
      }
      if (await verifyPassword(user.passwordHash!, input.newPassword)) {
        throw validationFailed(
          [{ field: 'newPassword', message: 'Choose a password different from your current password.' }],
          'Choose a different password.',
        );
      }

      await usersRepository.setPasswordHash(user.id, await hashPassword(input.newPassword), false);
      const refreshed = await usersRepository.findById(user.id);
      if (!refreshed) throw unauthenticated();

      await regenerateSession(req);
      req.session.userId = refreshed.id;
      req.session.role = refreshed.role;
      req.session.loggedInAt = new Date().toISOString();
      req.session.csrfToken = generateCsrfToken();
      await saveSession(req);
      issueCsrfCookie(res, req.session.csrfToken, req.session.rememberMe);

      logger.info({ userId: refreshed.id }, 'password changed');
      const body: SessionResponse = {
        user: toCurrentUser(refreshed),
        settings: await getSettings(),
        csrfToken: req.session.csrfToken,
      };
      res.status(200).json(body);
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const userId = req.session?.userId;
      if (req.session) {
        await destroySession(req);
      }
      res.clearCookie(env().SESSION_NAME, { path: '/' });
      res.clearCookie(CSRF_COOKIE, { path: '/' });
      if (userId) logger.info({ userId }, 'logout');
      res.status(204).end();
    }),
  );

  return router;
}
