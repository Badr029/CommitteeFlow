import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntry, BookingHistoryEntry } from '@shared/api-types.js';
import { query } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import { processOutboxBatch } from '../../src/modules/notifications/outbox.worker.js';
import {
  createBookingVia,
  createUser,
  resetDatabase,
  restoreMailer,
  setSettings,
  signIn,
  useRecordingMailer,
} from '../helpers/harness.js';

/** Spec §13, §14, §16, §50, §51, §56, §67. */
describe('audit trail and notifications', () => {
  beforeEach(resetDatabase);
  afterEach(restoreMailer);
  afterAll(async () => {
    await closePool();
  });

  describe('booking history (spec §13)', () => {
    it('answers who created it and when', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      const res = await session.get(`/api/bookings/${booking.id}/history`);

      expect(res.status).toBe(200);
      const entries = res.body.entries as BookingHistoryEntry[];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ action: 'CREATE', bookingVersion: 1 });
      expect(entries[0]?.actor).toMatchObject({ id: user.id, name: user.name });
      expect(entries[0]?.createdAt).toBeTruthy();
    });

    it('answers what changed, from what, to what', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session, { booking_time: '10:00', qty: 3 });

      await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '11:00', qty: 5 },
      });

      const res = await session.get(`/api/bookings/${booking.id}/history`);
      const update = (res.body.entries as BookingHistoryEntry[]).find((e) => e.action === 'UPDATE');

      expect(update?.changes).toEqual(
        expect.arrayContaining([
          { fieldKey: 'booking_time', label: 'Time', from: '10:00', to: '11:00' },
          { fieldKey: 'qty', label: 'Qty', from: 3, to: 5 },
        ]),
      );
      // Only what changed — untouched fields are not in the entry.
      expect(update?.changes).toHaveLength(2);
    });

    it('answers who cancelled it', async () => {
      const { session: creator } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(creator);
      const { session: canceller, user: cancellerUser } = await signIn({ role: 'PROJECT_ENGINEER' });

      await canceller.post(`/api/bookings/${booking.id}/cancel`, { version: 1, reason: 'Postponed' });

      const res = await creator.get(`/api/bookings/${booking.id}/history`);
      const cancel = (res.body.entries as BookingHistoryEntry[]).find((e) => e.action === 'CANCEL');

      expect(cancel?.actor?.id).toBe(cancellerUser.id);
      expect(cancel?.changes[0]).toMatchObject({ fieldKey: 'status', to: 'CANCELLED' });
    });

    it('keeps history readable after the field is renamed', async () => {
      const { session: manager, user } = await signIn({
        role: 'PROJECT_ENGINEER',
        canManagePlanConfiguration: true,
      });
      const booking = await createBookingVia(manager, { customer_name: 'Aweer' });
      await manager.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { customer_name: 'Aweer Maintenance' },
      });

      // Rename the field after the change was recorded.
      const fields = await manager.get('/api/plan-fields');
      const customerField = fields.body.fields.find(
        (f: { fieldKey: string }) => f.fieldKey === 'customer_name',
      );
      await manager.patch(`/api/plan-fields/${customerField.id}`, { label: 'Client Name' });
      expect(user.id).toBeTruthy();

      const res = await manager.get(`/api/bookings/${booking.id}/history`);
      const update = (res.body.entries as BookingHistoryEntry[]).find((e) => e.action === 'UPDATE');

      // The stable key never moved; the label reads as it is configured today.
      expect(update?.changes[0]).toMatchObject({
        fieldKey: 'customer_name',
        label: 'Client Name',
        from: 'Aweer',
        to: 'Aweer Maintenance',
      });
    });

    it('is readable by a viewer', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(engineer);
      const { session: viewer } = await signIn({ role: 'VIEWER' });

      expect((await viewer.get(`/api/bookings/${booking.id}/history`)).status).toBe(200);
    });

    it('exposes no endpoint that modifies or deletes history (spec §67)', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER', canManagePlanConfiguration: true });
      const booking = await createBookingVia(session);

      const attempts = [
        await session.post(`/api/bookings/${booking.id}/history`, { action: 'CREATE' }),
        await session.patch(`/api/bookings/${booking.id}/history`, { action: 'CREATE' }),
        await session.post('/api/activity', {}),
        await session.patch('/api/activity', {}),
      ];

      for (const res of attempts) {
        expect([404, 405]).toContain(res.status);
      }

      const rows = await query('SELECT count(*)::int AS n FROM booking_history');
      expect(rows.rows[0]).toEqual({ n: 1 });
    });
  });

  describe('activity feed (spec §14, §56)', () => {
    it('returns newest first with booking context', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session, { off_no: '202601066' });
      await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '11:00' },
      });

      const res = await session.get('/api/activity');

      const entries = res.body.entries as ActivityEntry[];
      expect(entries[0]?.action).toBe('UPDATE');
      expect(entries[1]?.action).toBe('CREATE');
      expect(entries[0]?.actor?.name).toBe(user.name);
      expect(entries[0]?.booking).toMatchObject({ offNo: '202601066', bookingDate: '2026-10-06' });
    });

    it('paginates rather than returning everything', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      for (let i = 0; i < 6; i += 1) {
        await createBookingVia(session, { off_no: `OFF${i}`, booking_time: '09:00' });
      }

      const page1 = await session.get('/api/activity?page=1&limit=4');
      expect(page1.body.entries).toHaveLength(4);
      expect(page1.body.hasMore).toBe(true);

      const page2 = await session.get('/api/activity?page=2&limit=4');
      expect(page2.body.entries).toHaveLength(2);
      expect(page2.body.hasMore).toBe(false);

      const ids = new Set([...page1.body.entries, ...page2.body.entries].map((e: ActivityEntry) => e.id));
      expect(ids.size).toBe(6);
    });

    it('caps the page size a client can ask for', async () => {
      const { session } = await signIn({ role: 'VIEWER' });
      expect((await session.get('/api/activity?limit=100000')).status).toBe(400);
    });

    it('can be filtered to one booking', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const a = await createBookingVia(session, { off_no: 'A' });
      await createBookingVia(session, { off_no: 'B', booking_time: '11:00' });

      const res = await session.get(`/api/activity?bookingId=${a.id}`);

      expect(res.body.entries).toHaveLength(1);
      expect(res.body.entries[0].booking.offNo).toBe('A');
    });
  });

  describe('email outbox (spec §16, §50, §51)', () => {
    it('queues a message for create, update and cancel — not only create', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);
      await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '11:00' },
      });
      await session.post(`/api/bookings/${booking.id}/cancel`, { version: 2 });

      const rows = await query<{ event_type: string }>(
        'SELECT event_type FROM email_outbox ORDER BY id',
      );
      expect(rows.rows.map((r) => r.event_type)).toEqual([
        'BOOKING_CREATED',
        'BOOKING_UPDATED',
        'BOOKING_CANCELLED',
      ]);
    });

    it('does not block the booking response on delivery', async () => {
      const mailer = useRecordingMailer();
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      await createBookingVia(session);

      // Queued, but nothing has been sent yet — the worker has not run.
      expect(mailer.sent).toHaveLength(0);
      const pending = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM email_outbox WHERE status = 'PENDING'",
      );
      expect(pending.rows[0]?.n).toBe(1);
    });

    it('delivers to every active user who has not opted out', async () => {
      const mailer = useRecordingMailer();
      const { session } = await signIn({ role: 'PROJECT_ENGINEER', email: 'eng@x.test' });
      await createUser({ role: 'VIEWER', email: 'viewer@x.test' });
      await createUser({ role: 'VIEWER', email: 'optedout@x.test', notifyByEmail: false });
      await createUser({ role: 'VIEWER', email: 'inactive@x.test', isActive: false });

      await createBookingVia(session);
      await processOutboxBatch();

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]?.to.sort()).toEqual(['eng@x.test', 'viewer@x.test']);
    });

    it('honours the ENGINEERS_ONLY audience setting', async () => {
      const mailer = useRecordingMailer();
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER', email: 'eng@x.test' });
      await createUser({ role: 'VIEWER', email: 'viewer@x.test' });
      await setSettings({ notificationAudience: 'ENGINEERS_ONLY' }, user.id);

      await createBookingVia(session);
      await processOutboxBatch();

      expect(mailer.sent[0]?.to).toEqual(['eng@x.test']);
    });

    it('says what changed and links to the live plan, with no attachment', async () => {
      const mailer = useRecordingMailer();
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session, { off_no: '202601066' });
      await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '11:00' },
      });

      await processOutboxBatch();

      const update = mailer.sent.find((m) => m.subject.includes('updated'));
      expect(update?.subject).toContain('202601066');
      expect(update?.text).toContain('Time: 10:00 → 11:00');
      expect(update?.text).toContain('/plan?month=2026-10');
      expect(update?.html).toContain('View the current plan');
      // The workflow this replaces mailed a new spreadsheet every time (§17).
      expect(update).not.toHaveProperty('attachments');
      expect(update?.text).not.toMatch(/\.xlsx/);
    });

    it('escapes user-supplied text in the HTML body', async () => {
      const mailer = useRecordingMailer();
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      await createBookingVia(session, { order_name: '<script>alert(1)</script>' });
      await processOutboxBatch();

      expect(mailer.sent[0]?.html).not.toContain('<script>alert(1)</script>');
      expect(mailer.sent[0]?.html).toContain('&lt;script&gt;');
    });

    it('marks a message sent and does not resend it', async () => {
      const mailer = useRecordingMailer();
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session);

      expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
      expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
      expect(mailer.sent).toHaveLength(1);

      const row = await query<{ status: string; sent_at: Date | null }>(
        'SELECT status, sent_at FROM email_outbox',
      );
      expect(row.rows[0]?.status).toBe('SENT');
      expect(row.rows[0]?.sent_at).not.toBeNull();
    });

    it('records the failure and schedules a retry when SMTP fails', async () => {
      const mailer = useRecordingMailer();
      mailer.shouldFail = true;
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session);

      expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 1 });

      const row = await query<{
        status: string;
        attempt_count: number;
        last_error: string;
        next_attempt_at: Date;
      }>('SELECT status, attempt_count, last_error, next_attempt_at FROM email_outbox');
      expect(row.rows[0]?.status).toBe('FAILED');
      expect(row.rows[0]?.attempt_count).toBe(1);
      expect(row.rows[0]?.last_error).toContain('simulated SMTP failure');
      expect(row.rows[0]?.next_attempt_at.getTime()).toBeGreaterThan(Date.now());

      // Not due yet, so a second pass leaves it alone.
      expect(await processOutboxBatch()).toEqual({ sent: 0, failed: 0 });
    });

    it('delivers a previously failed message once it is due again', async () => {
      const mailer = useRecordingMailer();
      mailer.shouldFail = true;
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session);
      await processOutboxBatch();

      mailer.shouldFail = false;
      await query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 minute'");

      expect(await processOutboxBatch()).toEqual({ sent: 1, failed: 0 });
      expect(mailer.sent).toHaveLength(1);
    });

    it('does not queue anything when nothing changed', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session, { qty: 3 });

      await session.patch(`/api/bookings/${booking.id}`, { version: 1, values: { qty: 3 } });

      const rows = await query<{ n: number }>('SELECT count(*)::int AS n FROM email_outbox');
      expect(rows.rows[0]?.n).toBe(1);
    });
  });
});
