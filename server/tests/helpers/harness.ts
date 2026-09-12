import type { Express } from 'express';
import request from 'supertest';
import type { AppSettings, Booking, PlanFieldValue, UserRole } from '@shared/api-types.js';
import { createApp } from '../../src/app.js';
import { query } from '../../src/db/index.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import * as usersRepository from '../../src/modules/users/users.repository.js';
import {
  invalidateSettingsCache,
  updateSettings,
} from '../../src/modules/plan-config/settings.service.js';
import { setMailer, type Mailer, type OutgoingEmail } from '../../src/modules/notifications/mailer.js';

/**
 * Shared test harness.
 *
 * Drives the real Express app over HTTP with supertest, so every test exercises
 * the same middleware stack production does — session, CSRF, authorisation and
 * error handling included.
 */

export const TEST_PASSWORD = 'TestPassword!2026';

let app: Express | undefined;

export function testApp(): Express {
  app ??= createApp();
  return app;
}

/** Wipes all mutable data between tests, keeping the seeded plan configuration. */
export async function resetDatabase(): Promise<void> {
  await query(`
    TRUNCATE booking_history, configuration_history, email_outbox, bookings, import_batches, "session"
      RESTART IDENTITY CASCADE
  `);
  await query('DELETE FROM users');
  // Restore the confirmed business-rule values (migration 1700000000002).
  await query(`
    UPDATE app_settings SET value = CASE key
      WHEN 'booking_slot_uniqueness'       THEN '"NONE"'::jsonb
      WHEN 'booking_edit_policy'           THEN '"ANY_ENGINEER"'::jsonb
      WHEN 'booking_future_horizon_months' THEN '6'::jsonb
      WHEN 'notification_audience'         THEN '"ALL_ACTIVE_USERS"'::jsonb
      ELSE value END
  `);
  // Undo anything a plan-configuration test changed.
  await query(`DELETE FROM plan_field_definitions WHERE field_class = 'CUSTOM'`);
  await query(`
    UPDATE plan_field_definitions
       SET is_visible = true,
           is_active = true,
           archived_at = NULL,
           field_type = CASE field_key
             WHEN 'booking_date' THEN 'DATE'::plan_field_type
             WHEN 'booking_time' THEN 'TIME'::plan_field_type
             WHEN 'notes' THEN 'LONG_TEXT'::plan_field_type
             WHEN 'qty' THEN 'NUMBER'::plan_field_type
             WHEN 'kva' THEN 'NUMBER'::plan_field_type
             WHEN 'kv' THEN 'TEXT'::plan_field_type
             WHEN 'status' THEN 'SELECT'::plan_field_type
             ELSE 'TEXT'::plan_field_type END,
           options = CASE field_key
             WHEN 'status' THEN '["PLANNED", "CANCELLED"]'::jsonb
             ELSE '[]'::jsonb END,
           label = CASE field_key
             WHEN 'booking_date' THEN 'Date'
             WHEN 'booking_time' THEN 'Time'
             WHEN 'off_no' THEN 'OFF No.'
             WHEN 'order_name' THEN 'Order Name'
             WHEN 'committee' THEN 'Committee'
             WHEN 'qty' THEN 'Qty'
             WHEN 'kva' THEN 'KVA'
             WHEN 'kv' THEN 'KV'
             WHEN 'status' THEN 'Status'
             WHEN 'serial_no' THEN 'Serial No.'
             WHEN 'project_engineer' THEN 'Project Engineer'
             WHEN 'notes' THEN 'Notes'
             WHEN 'customer_name' THEN 'Customer Name'
             ELSE label END,
           is_required = field_key IN ('booking_date', 'booking_time', 'off_no', 'order_name', 'committee'),
           display_order = CASE field_key
             WHEN 'booking_date' THEN 10
             WHEN 'booking_time' THEN 20
             WHEN 'off_no' THEN 30
             WHEN 'order_name' THEN 40
             WHEN 'committee' THEN 50
             WHEN 'qty' THEN 60
             WHEN 'kva' THEN 70
             WHEN 'kv' THEN 80
             WHEN 'status' THEN 90
             WHEN 'serial_no' THEN 95
             WHEN 'project_engineer' THEN 97
             WHEN 'notes' THEN 100
             WHEN 'customer_name' THEN 110
             ELSE display_order END
  `);
  invalidateSettingsCache();
}

export interface CreatedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

let userCounter = 0;

export async function createUser(options: {
  role: UserRole;
  name?: string;
  email?: string;
  canManagePlanConfiguration?: boolean;
  isActive?: boolean;
  notifyByEmail?: boolean;
}): Promise<CreatedUser> {
  userCounter += 1;
  const email = options.email ?? `user${userCounter}@committeeflow.test`;
  const name = options.name ?? `Test User ${userCounter}`;

  const user = await usersRepository.createUser({
    name,
    email,
    passwordHash: await hashPassword(TEST_PASSWORD),
    role: options.role,
    canManagePlanConfiguration: options.canManagePlanConfiguration ?? false,
    notifyByEmail: options.notifyByEmail ?? true,
  });

  if (options.isActive === false) {
    await query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);
  }

  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/**
 * A signed-in HTTP client.
 *
 * Carries the session cookie and the CSRF token exactly as the browser does, so
 * a route that forgets its CSRF or auth guard fails these tests.
 */
export class Session {
  private cookies: string[] = [];
  private csrfToken: string | null = null;

  constructor(private readonly application: Express = testApp()) {}

  private absorb(res: request.Response): void {
    const raw = res.headers['set-cookie'];
    if (!raw) return;
    const incoming = Array.isArray(raw) ? raw : [raw];
    for (const cookie of incoming) {
      const [pair] = cookie.split(';');
      if (!pair) continue;
      const name = pair.slice(0, pair.indexOf('='));
      this.cookies = this.cookies.filter((existing) => !existing.startsWith(`${name}=`));
      this.cookies.push(pair);
      if (name === 'committeeflow.csrf') {
        this.csrfToken = pair.slice(pair.indexOf('=') + 1);
      }
    }
  }

  private apply(req: request.Test, withCsrf: boolean): request.Test {
    if (this.cookies.length > 0) req.set('Cookie', this.cookies.join('; '));
    if (withCsrf && this.csrfToken) req.set('X-CSRF-Token', this.csrfToken);
    return req;
  }

  /** Mints a CSRF secret the way the SPA's first load does. */
  async bootstrap(): Promise<this> {
    const res = await this.apply(request(this.application).get('/api/auth/session'), false);
    this.absorb(res);
    return this;
  }

  async login(email: string, password = TEST_PASSWORD): Promise<request.Response> {
    if (!this.csrfToken) await this.bootstrap();
    const res = await this.apply(
      request(this.application).post('/api/auth/login').send({ email, password }),
      true,
    );
    this.absorb(res);
    return res;
  }

  async get(path: string): Promise<request.Response> {
    const res = await this.apply(request(this.application).get(path), false);
    this.absorb(res);
    return res;
  }

  /**
   * A GET whose body is binary (an export).
   *
   * supertest only buffers text bodies by default, so without `responseType`
   * an .xlsx arrives as an empty object and assertions on it pass vacuously.
   */
  async getBinary(path: string): Promise<request.Response> {
    const res = await this.apply(request(this.application).get(path), false).responseType('blob');
    this.absorb(res);
    return res;
  }

  async post(path: string, body?: unknown, options: { csrf?: boolean } = {}): Promise<request.Response> {
    const req = request(this.application).post(path);
    if (body !== undefined) req.send(body as object);
    const res = await this.apply(req, options.csrf ?? true);
    this.absorb(res);
    return res;
  }

  /**
   * A multipart upload, the way the import endpoints are actually called.
   *
   * Fields are attached as strings because that is what a browser's FormData
   * sends — a test that posted JSON here would exercise a path the client never
   * takes.
   */
  async upload(
    path: string,
    file: { filename: string; buffer: Buffer; contentType?: string },
    fields: Record<string, string> = {},
    options: { csrf?: boolean } = {},
  ): Promise<request.Response> {
    const req = request(this.application).post(path);
    for (const [name, value] of Object.entries(fields)) req.field(name, value);
    req.attach('file', file.buffer, {
      filename: file.filename,
      ...(file.contentType ? { contentType: file.contentType } : {}),
    });
    const res = await this.apply(req, options.csrf ?? true);
    this.absorb(res);
    return res;
  }

  async patch(path: string, body?: unknown, options: { csrf?: boolean } = {}): Promise<request.Response> {
    const req = request(this.application).patch(path);
    if (body !== undefined) req.send(body as object);
    const res = await this.apply(req, options.csrf ?? true);
    this.absorb(res);
    return res;
  }

  async delete(path: string, body?: unknown, options: { csrf?: boolean } = {}): Promise<request.Response> {
    const req = request(this.application).delete(path);
    if (body !== undefined) req.send(body as object);
    const res = await this.apply(req, options.csrf ?? true);
    this.absorb(res);
    return res;
  }

  get token(): string | null {
    return this.csrfToken;
  }

  /** The raw Cookie header, for tests that craft a request by hand. */
  get cookieHeader(): string {
    return this.cookies.join('; ');
  }
}

export async function signIn(options: Parameters<typeof createUser>[0]): Promise<{
  session: Session;
  user: CreatedUser;
}> {
  const user = await createUser(options);
  const session = new Session();
  const res = await session.login(user.email);
  if (res.status !== 200) {
    throw new Error(`login failed for ${user.email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { session, user };
}

/** A complete, valid booking payload; override any field per test. */
export function bookingPayload(
  overrides: Record<string, PlanFieldValue> = {},
): { values: Record<string, PlanFieldValue> } {
  return {
    values: {
      booking_date: '2026-10-06',
      booking_time: '10:00',
      off_no: '202601066',
      order_name: 'Transformer 2B',
      committee: 'North Committee',
      ...overrides,
    },
  };
}

export async function createBookingVia(
  session: Session,
  overrides: Record<string, PlanFieldValue> = {},
): Promise<Booking> {
  const res = await session.post('/api/bookings', bookingPayload(overrides));
  if (res.status !== 201) {
    throw new Error(`booking create failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body as Booking;
}

export async function setSettings(patch: Partial<AppSettings>, actorId: string): Promise<void> {
  await updateSettings(patch, actorId);
}

/** Records what the outbox worker would have sent. */
export class RecordingMailer implements Mailer {
  readonly mode = 'log' as const;
  readonly sent: OutgoingEmail[] = [];
  shouldFail = false;

  async send(email: OutgoingEmail): Promise<void> {
    if (this.shouldFail) throw Object.assign(new Error('simulated SMTP failure'), { code: 'ECONNECTION' });
    this.sent.push(email);
  }
  async verify(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {
    /* nothing to close */
  }
}

export function useRecordingMailer(): RecordingMailer {
  const mailer = new RecordingMailer();
  setMailer(mailer);
  return mailer;
}

export function restoreMailer(): void {
  setMailer(undefined);
}
