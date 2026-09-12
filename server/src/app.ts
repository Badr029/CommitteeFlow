import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express, { type Express,type RequestHandler, Router } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import * as helmetModule from 'helmet';
import type { HelmetOptions } from 'helmet';
import crypto from 'node:crypto';
import { processOutboxBatch } from './modules/notifications/outbox.worker.js';
import { pinoHttp } from 'pino-http';
import type { HealthResponse } from '@shared/api-types.js';
import { env, isProduction } from './config/env.js';
import { getPool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { asyncHandler, noStore } from './lib/http.js';
import { apiNotFound, errorHandler } from './middleware/error-handler.js';
import { attachCsrfToken, verifyCsrf } from './middleware/csrf.js';
import { buildSessionMiddleware } from './modules/auth/session.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { requireAuth, requirePasswordChangeComplete } from './middleware/authenticate.js';
import { bookingsRouter } from './modules/bookings/bookings.routes.js';
import { planFieldsRouter, settingsRouter } from './modules/plan-config/plan-config.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { activityRouter } from './modules/audit/activity.routes.js';
import { exportRouter } from './modules/export/export.routes.js';
import { planImportRouter } from './modules/plan-import/plan-import.routes.js';



const APP_VERSION = process.env['npm_package_version'] ?? '0.1.0';
const helmet = helmetModule.default as unknown as (
  options?: Readonly<HelmetOptions>
) => RequestHandler;
/**
 * The Express application.
 *
 * One process serves the API under `/api` and the built React SPA from the same
 * origin (spec §29). Same-origin delivery is also why the session cookie can be
 * `SameSite=Lax` and CORS is only needed for local development.
 */
export function createApp(): Express {
  const config = env();
  const app = express();

  // Behind a company reverse proxy, `secure` cookies and client IPs for the
  // rate limiter both depend on trusting exactly the hops that exist.
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(
    pinoHttp({
      logger,
      // Health checks would otherwise dominate the log at info level.
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(helmet(helmetOptions()));
  app.use(compression());
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  /*
   * Health sits in front of the session middleware.
   *
   * Its job is to report whether this process can reach the database — so it
   * must still answer when the database is the thing that is broken. Behind the
   * session store it would fail with a 500 instead of a useful "degraded".
   */
  app.get('/api/health', healthHandler);

  app.post(
  '/api/internal/process-outbox',
  asyncHandler(async (req, res) => {
      const expected = process.env.CRON_SECRET;
      const authorization = req.get('authorization');

      if (!expected || !authorization?.startsWith('Bearer ')) {
        res.status(401).json({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required.',
          },
        });
        return;
      }

      const provided = authorization.slice('Bearer '.length);

      const expectedBuffer = Buffer.from(expected);
      const providedBuffer = Buffer.from(provided);

      if (
        expectedBuffer.length !== providedBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
      ) {
        res.status(401).json({
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required.',
          },
        });
        return;
      }

      const result = await processOutboxBatch();

      res.status(200).json({
        ok: true,
        ...result,
      });
    }),
  );

  app.use(buildSessionMiddleware());
  app.use(attachCsrfToken);

  if (!isProduction() && config.CORS_ORIGINS.length > 0) {
    app.use(devCors(config.CORS_ORIGINS));
  }

  app.use('/api', apiRouter());
  app.use('/api', apiNotFound);

  mountSpa(app);

  app.use(errorHandler);
  return app;
}

/**
 * Health check (spec §69).
 *
 * Unauthenticated and CSRF-exempt so a container orchestrator can call it, and
 * deliberately shallow: it reports whether this process can reach the database,
 * nothing that would help someone map the system.
 */
const healthHandler = asyncHandler(async (_req, res) => {
  noStore(res);

  let database: 'ok' | 'error' = 'ok';
  try {
    await getPool().query('SELECT 1');
  } catch (error) {
    database = 'error';
    logger.error({ err: error }, 'health check: database unreachable');
  }

  const body: HealthResponse = {
    status: database === 'ok' ? 'ok' : 'degraded',
    version: APP_VERSION,
    checks: { database },
  };
  res.status(database === 'ok' ? 200 : 503).json(body);
});

function apiRouter(): Router {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  // Every state-changing request past this point carries a CSRF token.
  router.use(verifyCsrf);

  router.use('/auth', authRouter());
  router.use(requireAuth, requirePasswordChangeComplete);
  router.use('/bookings', bookingsRouter());
  router.use('/plan-fields', planFieldsRouter());
  router.use('/settings', settingsRouter());
  router.use('/users', usersRouter());
  router.use('/activity', activityRouter());
  router.use('/export', exportRouter());
  router.use('/imports', planImportRouter());

  return router;
}

/**
 * Security headers (spec §61).
 *
 * The CSP is strict on scripts: Vite emits hashed external files, so no inline
 * script is ever needed. `style-src` allows inline styles because React and
 * Radix set them for positioning; that is a far smaller surface than inline
 * script execution.
 */
function helmetOptions(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        ...(isProduction() ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'same-origin' },
    hsts: isProduction() ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  };
}

/** Development-only CORS for the Vite dev server. Never a CSRF control (§60). */
function devCors(origins: string[]) {
  const allowed = new Set(origins);
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const origin = req.get('origin');
    if (origin && allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * Serves the built SPA.
 *
 * Hashed assets are immutable and cached for a year; `index.html` never is, so
 * a deploy takes effect on the next navigation.
 */
function mountSpa(app: Express): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath =
    env().CLIENT_DIST_PATH ?? path.resolve(here, '..', '..', 'client', 'dist');

  if (!fs.existsSync(path.join(distPath, 'index.html'))) {
    logger.warn({ distPath }, 'client build not found — API only (run `npm run build`)');
    return;
  }

  app.use(
    express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  // Client-side routing: anything not matched above returns the shell.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distPath, 'index.html'));
  });

  logger.info({ distPath }, 'serving client build');
}

const app = createApp();

export default app;
