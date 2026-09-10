import type { ApiErrorBody, ApiErrorCode, FieldIssue } from '@shared/api-types';

/**
 * The single place the SPA talks to the API.
 *
 * Authentication rides on the session cookie, so nothing here reads or stores a
 * token. The CSRF token is echoed from a readable mirror cookie the server
 * keeps in sync (see server/src/middleware/csrf.ts).
 */

const CSRF_COOKIE = 'committeeflow.csrf';
const CSRF_HEADER = 'X-CSRF-Token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues: FieldIssue[];
  readonly currentVersion: number | undefined;
  readonly conflictingBookings:
    | NonNullable<ApiErrorBody['error']['conflictingBookings']>
    | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    issues: FieldIssue[] = [],
    currentVersion?: number,
    conflictingBookings?: NonNullable<ApiErrorBody['error']['conflictingBookings']>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.currentVersion = currentVersion;
    this.conflictingBookings = conflictingBookings;
  }

  /** A stale-edit conflict the UI offers to resolve by reloading (spec §48). */
  get isVersionConflict(): boolean {
    return this.code === 'VERSION_CONFLICT';
  }

  get isUnauthenticated(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }

  /** Field-level messages keyed by plan field key, for the booking form. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const issue of this.issues) {
      map[issue.field] ??= issue.message;
    }
    return map;
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function toError(response: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // A non-JSON error (a proxy timeout page, say) still has to reach the UI
    // as something a person can read.
  }

  const error = body?.error;
  return new ApiError(
    response.status,
    error?.code ?? 'INTERNAL_ERROR',
    error?.message ?? fallbackMessage(response.status),
    error?.issues ?? [],
    error?.currentVersion,
    error?.conflictingBookings,
  );
}

function fallbackMessage(status: number): string {
  if (status === 0) return 'Cannot reach the server. Check your connection and try again.';
  if (status >= 500) return 'The server had a problem. Try again in a moment.';
  return 'That request could not be completed.';
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (method !== 'GET') {
    const token = readCookie(CSRF_COOKIE);
    if (token) headers[CSRF_HEADER] = token;
  }

  return fetch(path, {
    method,
    headers,
    // Same-origin in production; the Vite proxy keeps it same-origin in dev.
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await send(path, options);
  } catch {
    throw new ApiError(0, 'INTERNAL_ERROR', fallbackMessage(0), [], undefined, undefined);
  }

  /*
   * One automatic retry on a stale CSRF token.
   *
   * A session that expired while the tab sat open leaves the browser holding a
   * token the new server-side session does not know. The rejected response
   * carries a fresh token cookie, so retrying once succeeds — otherwise a user
   * returning to a long-open tab would have to reload before they could sign
   * in. Only ever retried once, and never for anything but this one code.
   */
  if (response.status === 403 && !options.signal?.aborted) {
    const error = await toError(response.clone());
    if (error.code === 'INVALID_CSRF_TOKEN') {
      response = await send(path, options);
    }
  }

  if (!response.ok) {
    throw await toError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Multipart upload.
 *
 * `FormData` sets its own `Content-Type` with the boundary, so this deliberately
 * does not go through `send()` — setting the header by hand would produce a body
 * the server cannot split. The CSRF token still travels in its header, exactly
 * as it does for a JSON write.
 */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = readCookie(CSRF_COOKIE);
  if (token) headers[CSRF_HEADER] = token;

  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: form,
    });
  } catch {
    throw new ApiError(0, 'INTERNAL_ERROR', fallbackMessage(0), [], undefined, undefined);
  }

  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    request<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
  upload,
};

/**
 * Triggers a file download for an export.
 *
 * Goes through fetch rather than a bare link so an error comes back as a
 * readable message instead of navigating the tab to a JSON error body.
 */
export async function downloadExport(path: string, fallbackName: string): Promise<void> {
  const response = await send(path, {});
  if (!response.ok) {
    throw await toError(response);
  }

  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Builds a query string, dropping empty values so URLs stay readable. */
export function queryString(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
