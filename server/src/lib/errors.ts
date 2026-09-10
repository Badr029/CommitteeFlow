import type { ApiErrorBody, ApiErrorCode, FieldIssue } from '@shared/api-types.js';

/**
 * Application errors.
 *
 * Every failure the API reports deliberately goes through one of these so the
 * response body shape is identical everywhere and no internal detail (SQL text,
 * stack, driver message) can leak to a client by accident.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues?: FieldIssue[];
  readonly extra?: Omit<ApiErrorBody['error'], 'code' | 'message' | 'issues'>;
  /** `true` for errors that are part of normal operation, so we log at warn. */
  readonly expected: boolean;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    options: {
      issues?: FieldIssue[];
      extra?: Omit<ApiErrorBody['error'], 'code' | 'message' | 'issues'>;
      expected?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (options.issues) this.issues = options.issues;
    if (options.extra) this.extra = options.extra;
    this.expected = options.expected ?? true;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.issues ? { issues: this.issues } : {}),
        ...(this.extra ?? {}),
      },
    };
  }
}

export const badRequest = (message: string, issues?: FieldIssue[]) =>
  new AppError(400, 'BAD_REQUEST', message, issues ? { issues } : {});

export const validationFailed = (issues: FieldIssue[], message = 'Some fields need attention.') =>
  new AppError(422, 'VALIDATION_FAILED', message, { issues });

export const unauthenticated = (message = 'You need to sign in to continue.') =>
  new AppError(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'You do not have permission to do that.') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'That record does not exist.') =>
  new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

/**
 * Optimistic-concurrency failure (spec §48). The client is told the version it
 * should reload so the UI can offer "refresh and try again" rather than a
 * generic error.
 */
export const versionConflict = (currentVersion: number) =>
  new AppError(
    409,
    'VERSION_CONFLICT',
    'This booking was changed by another user. Refresh before saving.',
    { extra: { currentVersion } },
  );

/** Slot exclusivity failure, shape of the rule decided at runtime (spec §46). */
export const slotConflict = (
  message: string,
  conflictingBookings: NonNullable<ApiErrorBody['error']['conflictingBookings']>,
) => new AppError(409, 'SLOT_CONFLICT', message, { extra: { conflictingBookings } });

export const internalError = (cause?: unknown) =>
  new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.', {
    expected: false,
    cause,
  });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
