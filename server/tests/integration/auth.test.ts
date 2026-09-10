import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { query } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import {
  Session,
  TEST_PASSWORD,
  createUser,
  resetDatabase,
  signIn,
  testApp,
} from '../helpers/harness.js';

/** Spec §39, §41, §58, §59, §60, §62 — sessions, cookies, CSRF, brute force. */
describe('authentication and session security', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  it('rejects unauthenticated access to every protected endpoint', async () => {
    const app = testApp();
    const protectedGets = [
      '/api/bookings?month=2026-10',
      '/api/plan-fields',
      '/api/activity',
      '/api/settings',
      '/api/export/excel?month=2026-10',
      '/api/export/pdf?month=2026-10',
    ];

    for (const path of protectedGets) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error.code, path).toBe('UNAUTHENTICATED');
    }
  });

  it('leaves /api/health open so a container probe can reach it', async () => {
    const res = await request(testApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'ok' } });
  });

  it('signs a user in and returns their resolved permissions', async () => {
    const user = await createUser({ role: 'PROJECT_ENGINEER', canManagePlanConfiguration: true });
    const session = new Session();
    const res = await session.login(user.email);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      email: user.email,
      role: 'PROJECT_ENGINEER',
      canManagePlanConfiguration: true,
    });
    expect(res.body.user.permissions).toEqual({
      canCreateBooking: true,
      canManagePlanConfiguration: true,
      canExport: true,
    });
    // The password hash must never appear in a response.
    expect(JSON.stringify(res.body)).not.toContain('$argon2');
  });

  it('sets an HttpOnly, SameSite session cookie', async () => {
    const user = await createUser({ role: 'VIEWER' });
    const session = new Session();
    const res = await session.login(user.email);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const sessionCookie = cookies.find((c) => c.startsWith('committeeflow.sid='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Path=/');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    await createUser({ role: 'VIEWER', email: 'known@committeeflow.test' });
    const session = await new Session().bootstrap();

    const wrongPassword = await session.post('/api/auth/login', {
      email: 'known@committeeflow.test',
      password: 'not-the-password',
    });
    const unknownEmail = await session.post('/api/auth/login', {
      email: 'nobody@committeeflow.test',
      password: 'not-the-password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('refuses a deactivated account', async () => {
    const user = await createUser({ role: 'PROJECT_ENGINEER', isActive: false });
    const res = await new Session().login(user.email);
    expect(res.status).toBe(401);
  });

  it('invalidates a live session as soon as the account is deactivated', async () => {
    const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
    expect((await session.get('/api/plan-fields')).status).toBe(200);

    await query('UPDATE users SET is_active = false WHERE id = $1', [user.id]);

    // No waiting for the cookie to expire — the next request is rejected.
    expect((await session.get('/api/plan-fields')).status).toBe(401);
  });

  it('locks an account after repeated failures and reports it distinctly', async () => {
    const user = await createUser({ role: 'VIEWER' });
    const session = await new Session().bootstrap();

    // The env sets the threshold high for other suites; drive it directly.
    await query(
      "UPDATE users SET failed_login_attempts = 99, locked_until = now() + interval '10 minutes' WHERE id = $1",
      [user.id],
    );

    const res = await session.post('/api/auth/login', {
      email: user.email,
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/temporarily locked/i);
  });

  it('clears the lock counter after a successful sign-in', async () => {
    const user = await createUser({ role: 'VIEWER' });
    await query('UPDATE users SET failed_login_attempts = 3 WHERE id = $1', [user.id]);

    const res = await new Session().login(user.email);
    expect(res.status).toBe(200);

    const row = await query<{ failed_login_attempts: number; last_login_at: Date | null }>(
      'SELECT failed_login_attempts, last_login_at FROM users WHERE id = $1',
      [user.id],
    );
    expect(row.rows[0]?.failed_login_attempts).toBe(0);
    expect(row.rows[0]?.last_login_at).not.toBeNull();
  });

  it('issues a new session id on login, defeating session fixation', async () => {
    const user = await createUser({ role: 'VIEWER' });
    const session = new Session();
    await session.bootstrap();

    const beforeRows = await query<{ sid: string }>('SELECT sid FROM "session"');
    const before = new Set(beforeRows.rows.map((r) => r.sid));

    await session.login(user.email);

    const afterRows = await query<{ sid: string }>(
      'SELECT sid FROM "session" WHERE sess::text LIKE $1',
      [`%${user.id}%`],
    );
    expect(afterRows.rows.length).toBe(1);
    expect(before.has(afterRows.rows[0]!.sid)).toBe(false);
  });

  it('rejects a state-changing request with no CSRF token', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

    const res = await session.post('/api/bookings', { values: {} }, { csrf: false });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_CSRF_TOKEN');
  });

  it('rejects a CSRF token belonging to a different session', async () => {
    const { session: alice } = await signIn({ role: 'PROJECT_ENGINEER' });
    const { session: mallory } = await signIn({ role: 'PROJECT_ENGINEER' });

    expect(mallory.token).not.toBe(alice.token);

    // Alice's cookies with Mallory's token.
    const res = await request(testApp())
      .post('/api/bookings')
      .set('X-CSRF-Token', mallory.token ?? '')
      .set('Cookie', alice.cookieHeader)
      .send({ values: {} });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INVALID_CSRF_TOKEN');
  });

  it('does not require a CSRF token for safe methods', async () => {
    const { session } = await signIn({ role: 'VIEWER' });
    const res = await session.get('/api/bookings?month=2026-10');
    expect(res.status).toBe(200);
  });

  it('destroys the session on logout', async () => {
    const { session, user } = await signIn({ role: 'VIEWER' });

    expect((await session.post('/api/auth/logout')).status).toBe(204);
    expect((await session.get('/api/auth/session')).status).toBe(401);

    // The next request mints a fresh anonymous session for the CSRF secret, so
    // assert on identity: no stored session may still carry this user.
    const remaining = await query('SELECT sid FROM "session" WHERE sess::text LIKE $1', [
      `%${user.id}%`,
    ]);
    expect(remaining.rowCount).toBe(0);
  });

  it('never caches an API response', async () => {
    const { session } = await signIn({ role: 'VIEWER' });
    const res = await session.get('/api/bookings?month=2026-10');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('sends the expected security headers', async () => {
    const res = await request(testApp()).get('/api/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
