import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Booking } from '@shared/api-types.js';
import { query } from '../../src/db/index.js';
import { closePool } from '../../src/db/pool.js';
import {
  bookingPayload,
  createBookingVia,
  resetDatabase,
  setSettings,
  signIn,
} from '../helpers/harness.js';

/**
 * Spec §47, §48 — real multi-user behaviour.
 *
 * These tests fire genuinely simultaneous requests rather than asserting on a
 * mocked lock: the guarantee only means something if PostgreSQL provides it.
 */
describe('concurrency', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  describe('optimistic locking on edit (spec §48)', () => {
    it('rejects a stale version with 409 and the current version number', async () => {
      const { session: ahmed } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: mohamed } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(ahmed);

      // Both open version 1. Mohamed saves first.
      const first = await mohamed.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '11:00' },
      });
      expect(first.status).toBe(200);
      expect(first.body.version).toBe(2);

      // Ahmed submits the version he opened.
      const second = await ahmed.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '12:00' },
      });

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('VERSION_CONFLICT');
      expect(second.body.error.currentVersion).toBe(2);
      expect(second.body.error.message).toMatch(/changed by another user/i);
    });

    it('does not apply the losing write', async () => {
      const { session: a } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: b } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(a);

      await b.patch(`/api/bookings/${booking.id}`, { version: 1, values: { booking_time: '11:00' } });
      await a.patch(`/api/bookings/${booking.id}`, { version: 1, values: { booking_time: '12:00' } });

      const current = await a.get(`/api/bookings/${booking.id}`);
      expect(current.body.bookingTime).toBe('11:00');
      expect(current.body.version).toBe(2);
    });

    it('lets exactly one of two simultaneous edits win', async () => {
      const { session: a } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: b } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(a);

      const [first, second] = await Promise.all([
        a.patch(`/api/bookings/${booking.id}`, { version: 1, values: { booking_time: '11:00' } }),
        b.patch(`/api/bookings/${booking.id}`, { version: 1, values: { booking_time: '12:00' } }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await query<{ version: number }>('SELECT version FROM bookings WHERE id = $1', [
        booking.id,
      ]);
      expect(row.rows[0]?.version).toBe(2);
    });

    it('applies the same protection to cancellation', async () => {
      const { session: a } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: b } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(a);

      const [first, second] = await Promise.all([
        a.post(`/api/bookings/${booking.id}/cancel`, { version: 1 }),
        b.post(`/api/bookings/${booking.id}/cancel`, { version: 1 }),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 409]);
    });
  });

  /**
   * Spec §46 leaves the exclusivity key OPEN and forbids inventing it, so the
   * rule is a runtime setting. These tests prove the enforcement is correct at
   * every possible value the business might confirm.
   */
  describe('slot exclusivity — OPEN business rule (spec §46, §47, §78.1)', () => {
    it('NONE (the default) enforces nothing, matching the known plan behaviour', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const results = await Promise.all([
        session.post('/api/bookings', bookingPayload({ off_no: 'A' })),
        session.post('/api/bookings', bookingPayload({ off_no: 'B' })),
        session.post('/api/bookings', bookingPayload({ off_no: 'C' })),
      ]);

      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    });

    it('DATE_TIME_COMMITTEE lets only one of three simultaneous identical bookings through', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);

      const { session: a } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: b } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: c } = await signIn({ role: 'PROJECT_ENGINEER' });

      // The spec's exact race: three engineers, same slot, same instant.
      const results = await Promise.all([
        a.post('/api/bookings', bookingPayload({ off_no: 'A' })),
        b.post('/api/bookings', bookingPayload({ off_no: 'B' })),
        c.post('/api/bookings', bookingPayload({ off_no: 'C' })),
      ]);

      const created = results.filter((r) => r.status === 201);
      const rejected = results.filter((r) => r.status === 409);

      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(2);
      expect(rejected[0]?.body.error.code).toBe('SLOT_CONFLICT');
      expect(rejected[0]?.body.error.conflictingBookings).toHaveLength(1);

      const stored = await session.get('/api/bookings?month=2026-10');
      expect(stored.body.bookings).toHaveLength(1);
    });

    it('DATE_TIME_COMMITTEE still allows the same time for a different committee', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);

      expect(
        (await session.post('/api/bookings', bookingPayload({ off_no: 'N', committee: 'North' })))
          .status,
      ).toBe(201);
      expect(
        (await session.post('/api/bookings', bookingPayload({ off_no: 'S', committee: 'South' })))
          .status,
      ).toBe(201);
    });

    it('DATE_TIME blocks the same time regardless of committee', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME' }, user.id);

      expect(
        (await session.post('/api/bookings', bookingPayload({ off_no: 'N', committee: 'North' })))
          .status,
      ).toBe(201);

      const clash = await session.post(
        '/api/bookings',
        bookingPayload({ off_no: 'S', committee: 'South' }),
      );
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SLOT_CONFLICT');

      // A different time on the same day is fine.
      expect(
        (await session.post('/api/bookings', bookingPayload({ off_no: 'L', booking_time: '15:00' })))
          .status,
      ).toBe(201);
    });

    it('DATE allows a single booking per day', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE' }, user.id);

      expect((await session.post('/api/bookings', bookingPayload({ off_no: 'A' }))).status).toBe(201);
      expect(
        (await session.post('/api/bookings', bookingPayload({ off_no: 'B', booking_time: '16:00' })))
          .status,
      ).toBe(409);
      expect(
        (await session.post(
          '/api/bookings',
          bookingPayload({ off_no: 'C', booking_date: '2026-10-07' }),
        )).status,
      ).toBe(201);
    });

    it('re-checks exclusivity when an edit moves a booking into a taken slot', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);

      await createBookingVia(session, { off_no: 'A', booking_time: '09:00' });
      const second = await createBookingVia(session, { off_no: 'B', booking_time: '14:00' });

      const clash = await session.patch(`/api/bookings/${second.id}`, {
        version: second.version,
        values: { booking_time: '09:00' },
      });

      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SLOT_CONFLICT');
    });

    it('does not treat a booking as clashing with itself', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);
      const booking = await createBookingVia(session);

      // Same slot, different business field.
      const res = await session.patch(`/api/bookings/${booking.id}`, {
        version: booking.version,
        values: { booking_time: '10:00', qty: 5 },
      });

      expect(res.status).toBe(200);
    });

    it('frees the slot again once the occupying booking is cancelled', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);

      const first = await createBookingVia(session, { off_no: 'A' });
      expect((await session.post('/api/bookings', bookingPayload({ off_no: 'B' }))).status).toBe(409);

      await session.post(`/api/bookings/${first.id}/cancel`, { version: first.version });

      expect((await session.post('/api/bookings', bookingPayload({ off_no: 'B' }))).status).toBe(201);
    });

    it('reports which bookings occupy the slot so the UI can show them', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);
      const existing = await createBookingVia(session, { off_no: 'TAKEN' });

      const clash = await session.post('/api/bookings', bookingPayload({ off_no: 'NEW' }));

      expect(clash.body.error.conflictingBookings).toEqual([
        {
          id: existing.id,
          offNo: 'TAKEN',
          bookingDate: '2026-10-06',
          bookingTime: '10:00',
          committee: 'North Committee',
        },
      ]);
    });
  });

  describe('transaction atomicity (spec §72)', () => {
    it('writes the booking, its history and its outbox message together', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const booking = await createBookingVia(session);

      const counts = await query<{ bookings: number; history: number; outbox: number }>(`
        SELECT (SELECT count(*)::int FROM bookings)        AS bookings,
               (SELECT count(*)::int FROM booking_history) AS history,
               (SELECT count(*)::int FROM email_outbox)    AS outbox
      `);
      expect(counts.rows[0]).toEqual({ bookings: 1, history: 1, outbox: 1 });

      const linked = await query<{ n: number }>(
        'SELECT count(*)::int AS n FROM email_outbox WHERE booking_id = $1',
        [booking.id],
      );
      expect(linked.rows[0]?.n).toBe(1);
    });

    it('leaves nothing behind when a slot conflict aborts the transaction', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingSlotUniqueness: 'DATE_TIME_COMMITTEE' }, user.id);
      await createBookingVia(session, { off_no: 'A' });

      const rejected = await session.post('/api/bookings', bookingPayload({ off_no: 'B' }));
      expect(rejected.status).toBe(409);

      // Exactly one of each — the failed attempt wrote no history and no email.
      const counts = await query<{ bookings: number; history: number; outbox: number }>(`
        SELECT (SELECT count(*)::int FROM bookings)        AS bookings,
               (SELECT count(*)::int FROM booking_history) AS history,
               (SELECT count(*)::int FROM email_outbox)    AS outbox
      `);
      expect(counts.rows[0]).toEqual({ bookings: 1, history: 1, outbox: 1 });
    });

    it('leaves nothing behind when a version conflict aborts an update', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking: Booking = await createBookingVia(session);

      const stale = await session.patch(`/api/bookings/${booking.id}`, {
        version: 99,
        values: { qty: 5 },
      });
      expect(stale.status).toBe(409);

      const counts = await query<{ history: number; outbox: number }>(`
        SELECT (SELECT count(*)::int FROM booking_history) AS history,
               (SELECT count(*)::int FROM email_outbox)    AS outbox
      `);
      expect(counts.rows[0]).toEqual({ history: 1, outbox: 1 });
    });
  });
});
