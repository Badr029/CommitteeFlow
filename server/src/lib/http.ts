import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { FieldIssue } from '@shared/api-types.js';
import { badRequest, validationFailed } from './errors.js';

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 *
 * Express 5 forwards rejections automatically, but being explicit keeps the
 * behaviour obvious at every call site and survives a future downgrade.
 */
export function asyncHandler<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as unknown as Req, res, next).catch(next);
  };
}

/** Turns a Zod failure into the API's flat issue list. */
export function zodIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : '(request)',
    message: issue.message,
  }));
}

/** Validates a request body, throwing the standard 422 on failure (spec §43). */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw validationFailed(zodIssues(result.error));
  }
  return result.data;
}

/** Validates a query string, throwing the standard 400 on failure. */
export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw badRequest('Invalid query parameters.', zodIssues(result.error));
  }
  return result.data;
}

/** UUID path parameter guard — a malformed id is a 400, never a 500. */
export const uuidParam = z.uuid({ message: 'Must be a valid id.' });

export function parseUuidParam(value: unknown, name = 'id'): string {
  const result = uuidParam.safeParse(value);
  if (!result.success) {
    throw badRequest(`Invalid ${name}.`);
  }
  return result.data;
}

/**
 * Responses that must never be cached.
 *
 * Applied to every `/api` response: plan data is live, and a cached authorised
 * response sitting in a shared proxy is a real disclosure risk.
 */
export function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
}
