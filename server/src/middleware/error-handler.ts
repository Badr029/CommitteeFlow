import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { AppError, isAppError, notFound } from '../lib/errors.js';
import { zodIssues } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { isProduction } from '../config/env.js';

/** 404 for any unmatched `/api` route. */
export const apiNotFound: RequestHandler = (_req, _res, next) => {
  next(notFound('That endpoint does not exist.'));
};

/**
 * Single exit point for every error.
 *
 * Clients receive a stable, typed body and nothing else — no stack, no SQL, no
 * driver text. The full detail goes to the structured log (spec §70).
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  // A body-parser failure arrives as a plain Error with a status.
  const normalized = normalizeError(error);

  const logContext = {
    err: error,
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    userId: req.user?.id,
    code: normalized.code,
    status: normalized.status,
  };

  if (normalized.expected) {
    logger.warn(logContext, normalized.message);
  } else {
    logger.error(logContext, 'unhandled request error');
  }

  if (res.headersSent) {
    // Streaming exports can fail mid-response; the connection must be dropped
    // rather than appending JSON to a half-written file.
    res.destroy();
    return;
  }

  const body = normalized.toBody();
  if (!isProduction() && !normalized.expected && error instanceof Error) {
    // Development convenience only; never present in production responses.
    (body.error as Record<string, unknown>).debug = error.message;
  }

  res.status(normalized.status).json(body);
};

function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof z.ZodError) {
    return new AppError(422, 'VALIDATION_FAILED', 'Some fields need attention.', {
      issues: zodIssues(error),
    });
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: number; statusCode?: number; type?: string; message?: string };
    const status = candidate.status ?? candidate.statusCode;

    // express.json() rejects malformed or oversized bodies before our handlers.
    if (status === 400 && candidate.type === 'entity.parse.failed') {
      return new AppError(400, 'BAD_REQUEST', 'The request body is not valid JSON.');
    }
    if (status === 413) {
      return new AppError(400, 'BAD_REQUEST', 'The request body is too large.');
    }
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.', {
    expected: false,
    cause: error,
  });
}
