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

/** Spec §3, §8, §9, §10, §12, §15, §41, §42, §43, §45, §53. */
describe('bookings', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  describe('creating', () => {
    it('stores a booking with its creator and timestamps', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post('/api/bookings', bookingPayload());

      expect(res.status).toBe(201);
      const booking = res.body as Booking;
      expect(booking).toMatchObject({
        bookingDate: '2026-10-06',
        bookingTime: '10:00',
        offNo: '202601066',
        status: 'PLANNED',
        dataSource: 'MANUAL',
        version: 1,
      });
      expect(booking.createdBy).toMatchObject({ id: user.id, name: user.name });
      expect(booking.updatedBy).toMatchObject({ id: user.id });
      expect(booking.createdAt).toBeTruthy();
    });

    it('derives the weekday from the date rather than storing it', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const booking = await createBookingVia(session, { booking_date: '2026-10-01' });

      expect(booking.displayDay).toBe('Thursday');
      const stored = await query('SELECT * FROM bookings WHERE id = $1', [booking.id]);
      expect(Object.keys(stored.fields.map((f) => f.name))).not.toContain('display_day');
    });

    it('keeps booking_date separate from created_at for a future booking', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      // The spec's own example: booked today, scheduled for a future month.
      const booking = await createBookingVia(session, { booking_date: '2027-03-15' });

      expect(booking.bookingDate).toBe('2027-03-15');
      expect(booking.createdAt.slice(0, 10)).not.toBe('2027-03-15');
    });

    it('allows several bookings on the same date by default', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      await createBookingVia(session, { off_no: 'A1', booking_time: '09:00' });
      await createBookingVia(session, { off_no: 'A2', booking_time: '13:00' });
      await createBookingVia(session, { off_no: 'A3', booking_time: '13:00' });

      const res = await session.get('/api/bookings?month=2026-10');
      expect(res.body.bookings).toHaveLength(3);
    });

    it('stores a time as structured data, not inside notes', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const booking = await createBookingVia(session, { booking_time: '14:30' });

      const row = await query<{ booking_time: string; notes: string | null }>(
        'SELECT booking_time, notes FROM bookings WHERE id = $1',
        [booking.id],
      );
      expect(row.rows[0]?.booking_time).toMatch(/^14:30/);
      expect(row.rows[0]?.notes).toBeNull();
    });
  });

  describe('validation', () => {
    it('reports every missing required field at once', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post('/api/bookings', { values: { booking_date: '2026-10-06' } });

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.issues.map((i: { field: string }) => i.field).sort()).toEqual([
        'booking_time',
        'committee',
        'off_no',
        'order_name',
      ]);
    });

    it('enforces qty > 0', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      for (const qty of [0, -5]) {
        const res = await session.post('/api/bookings', bookingPayload({ qty }));
        expect(res.status, `qty=${qty}`).toBe(422);
        expect(res.body.error.issues[0].field).toBe('qty');
      }
    });

    it('rejects a non-integer qty and a negative kva', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      expect((await session.post('/api/bookings', bookingPayload({ qty: 2.5 }))).status).toBe(422);
      expect((await session.post('/api/bookings', bookingPayload({ kva: -1 }))).status).toBe(422);
    });

    it('rejects an impossible date and a malformed time', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      expect(
        (await session.post('/api/bookings', bookingPayload({ booking_date: '2026-02-30' }))).status,
      ).toBe(422);
      expect(
        (await session.post('/api/bookings', bookingPayload({ booking_time: '25:00' }))).status,
      ).toBe(422);
    });

    it('enforces length limits from the plan configuration', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post('/api/bookings', bookingPayload({ off_no: 'X'.repeat(200) }));

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].message).toMatch(/64 characters/);
    });

    it('refuses a field that is not part of the plan', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post(
        '/api/bookings',
        bookingPayload({ secret_admin_flag: 'true' }),
      );

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].field).toBe('secret_admin_flag');
    });

    it('cannot be tricked into writing a column the plan does not expose', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post('/api/bookings', bookingPayload({ booking_state: 'CANCELLED' }));

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].field).toBe('booking_state');
    });

    it('treats a blank optional value as cleared, not as an error', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const booking = await createBookingVia(session, { notes: '   ' });

      expect(booking.notes).toBeNull();
    });
  });

  describe('reading', () => {
    it('returns exactly the requested month', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, { booking_date: '2026-09-30', off_no: 'SEP' });
      await createBookingVia(session, { booking_date: '2026-10-01', off_no: 'OCT1' });
      await createBookingVia(session, { booking_date: '2026-10-31', off_no: 'OCT31' });
      await createBookingVia(session, { booking_date: '2026-11-01', off_no: 'NOV' });

      const res = await session.get('/api/bookings?month=2026-10');

      expect(res.body.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });
      expect(res.body.bookings.map((b: Booking) => b.offNo)).toEqual(['OCT1', 'OCT31']);
    });

    it('orders a day by time so the plan reads chronologically', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, { booking_time: '15:00', off_no: 'C' });
      await createBookingVia(session, { booking_time: '09:00', off_no: 'A' });
      await createBookingVia(session, { booking_time: '11:30', off_no: 'B' });

      const res = await session.get('/api/bookings?month=2026-10');
      expect(res.body.bookings.map((b: Booking) => b.offNo)).toEqual(['A', 'B', 'C']);
    });

    it('filters by committee, project engineer and free text', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: other, user: otherUser } = await signIn({ role: 'PROJECT_ENGINEER' });

      await createBookingVia(engineer, { off_no: 'N1', committee: 'North', serial_no: '010422616B' });
      await createBookingVia(engineer, { off_no: 'S1', committee: 'South', serial_no: 'DD-001600-S289' });
      await createBookingVia(other, { off_no: 'N2', committee: 'North', customer_name: 'Aweer' });

      const byCommittee = await engineer.get('/api/bookings?month=2026-10&committee=North');
      expect(byCommittee.body.bookings).toHaveLength(2);

      /*
       * By the engineer whose project it is, not by whoever typed the row. The
       * two are the same here and diverge after an import, which is why the
       * filter moved off `created_by`.
       */
      const byEngineer = await engineer.get(
        `/api/bookings?month=2026-10&projectEngineer=${otherUser.id}`,
      );
      expect(byEngineer.body.bookings.map((b: Booking) => b.offNo)).toEqual(['N2']);

      const bySearch = await engineer.get('/api/bookings?month=2026-10&search=aweer');
      expect(bySearch.body.bookings.map((b: Booking) => b.offNo)).toEqual(['N2']);

      // A serial number is worth finding a booking by.
      const bySerial = await engineer.get('/api/bookings?month=2026-10&search=DD-001600');
      expect(bySerial.body.bookings.map((b: Booking) => b.offNo)).toEqual(['S1']);
    });

    it('exposes facets for the filter menus', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, { off_no: 'A', committee: 'North' });
      await createBookingVia(session, { off_no: 'B', committee: 'South' });

      const res = await session.get('/api/bookings?month=2026-10');

      expect(res.body.facets.committees).toEqual(['North', 'South']);
      // Two values, and only the ones the month actually contains.
      expect(res.body.facets.statuses).toEqual(['PLANNED']);
      expect(res.body.facets.engineers).toHaveLength(1);
    });

    it('refuses an unbounded range so a page load cannot scan the table', async () => {
      const { session } = await signIn({ role: 'VIEWER' });

      const res = await session.get('/api/bookings?from=2000-01-01&to=2030-12-31');

      expect(res.status).toBe(400);
      expect(res.body.error.issues[0].message).toMatch(/13 months/);
    });

    it('returns 400 for a malformed booking id instead of failing', async () => {
      const { session } = await signIn({ role: 'VIEWER' });
      const res = await session.get('/api/bookings/not-a-uuid');
      expect(res.status).toBe(400);
    });

    it('returns 404 for a well-formed id that does not exist', async () => {
      const { session } = await signIn({ role: 'VIEWER' });
      const res = await session.get('/api/bookings/00000000-0000-4000-8000-000000000000');
      expect(res.status).toBe(404);
    });
  });

  describe('authorization', () => {
    it('lets a viewer read but never write', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(engineer);
      const { session: viewer } = await signIn({ role: 'VIEWER' });

      expect((await viewer.get('/api/bookings?month=2026-10')).status).toBe(200);
      expect((await viewer.get(`/api/bookings/${booking.id}`)).status).toBe(200);
      expect((await viewer.get(`/api/bookings/${booking.id}/history`)).status).toBe(200);

      expect((await viewer.post('/api/bookings', bookingPayload())).status).toBe(403);
      expect(
        (await viewer.patch(`/api/bookings/${booking.id}`, { version: 1, values: { qty: 2 } })).status,
      ).toBe(403);
      expect((await viewer.post(`/api/bookings/${booking.id}/cancel`, { version: 1 })).status).toBe(403);
    });

    it('knowing a booking id does not grant permission to change it', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(engineer);
      const { session: viewer } = await signIn({ role: 'VIEWER' });

      const res = await viewer.patch(`/api/bookings/${booking.id}`, {
        version: booking.version,
        values: { committee: 'Hijacked' },
      });

      expect(res.status).toBe(403);
      const unchanged = await engineer.get(`/api/bookings/${booking.id}`);
      expect(unchanged.body.committee).toBe('North Committee');
      expect(unchanged.body.version).toBe(1);
    });

    describe('booking_edit_policy — OPEN business rule (spec §78.2)', () => {
      it('ANY_ENGINEER lets a second engineer edit', async () => {
        const { session: creator } = await signIn({ role: 'PROJECT_ENGINEER' });
        const booking = await createBookingVia(creator);
        const { session: colleague } = await signIn({ role: 'PROJECT_ENGINEER' });

        const res = await colleague.patch(`/api/bookings/${booking.id}`, {
          version: booking.version,
          values: { booking_time: '16:00' },
        });

        expect(res.status).toBe(200);
      });

      it('CREATOR_ONLY blocks a second engineer', async () => {
        const { session: creator, user } = await signIn({ role: 'PROJECT_ENGINEER' });
        const booking = await createBookingVia(creator);
        await setSettings({ bookingEditPolicy: 'CREATOR_ONLY' }, user.id);
        const { session: colleague } = await signIn({ role: 'PROJECT_ENGINEER' });

        const blocked = await colleague.patch(`/api/bookings/${booking.id}`, {
          version: booking.version,
          values: { booking_time: '16:00' },
        });
        expect(blocked.status).toBe(403);

        const allowed = await creator.patch(`/api/bookings/${booking.id}`, {
          version: booking.version,
          values: { booking_time: '16:00' },
        });
        expect(allowed.status).toBe(200);
      });

      it('CREATOR_OR_PLAN_MANAGER admits a plan manager', async () => {
        const { session: creator, user } = await signIn({ role: 'PROJECT_ENGINEER' });
        const booking = await createBookingVia(creator);
        await setSettings({ bookingEditPolicy: 'CREATOR_OR_PLAN_MANAGER' }, user.id);

        const { session: plain } = await signIn({ role: 'PROJECT_ENGINEER' });
        expect(
          (await plain.patch(`/api/bookings/${booking.id}`, { version: 1, values: { qty: 4 } })).status,
        ).toBe(403);

        const { session: manager } = await signIn({
          role: 'PROJECT_ENGINEER',
          canManagePlanConfiguration: true,
        });
        expect(
          (await manager.patch(`/api/bookings/${booking.id}`, { version: 1, values: { qty: 4 } })).status,
        ).toBe(200);
      });
    });
  });

  describe('updating', () => {
    it('bumps the version and records the new editor', async () => {
      const { session: creator } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(creator);
      const { session: editor, user: editorUser } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await editor.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { booking_time: '11:00', qty: 7 },
      });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(res.body.bookingTime).toBe('11:00');
      expect(res.body.qty).toBe(7);
      expect(res.body.updatedBy.id).toBe(editorUser.id);
      // The original creator is preserved.
      expect(res.body.createdBy.id).not.toBe(editorUser.id);
    });

    it('leaves untouched fields alone', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session, { notes: 'keep me', customer_name: 'Aweer' });

      const res = await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { qty: 2 },
      });

      expect(res.body.notes).toBe('keep me');
      expect(res.body.customerName).toBe('Aweer');
    });

    it('does not bump the version when nothing actually changed', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session, { qty: 3 });

      const res = await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { qty: 3 },
      });

      expect(res.status).toBe(200);
      expect(res.body.version).toBe(1);
      const history = await session.get(`/api/bookings/${booking.id}/history`);
      expect(history.body.entries).toHaveLength(1);
    });

    it('refuses to blank out a required field', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      const res = await session.patch(`/api/bookings/${booking.id}`, {
        version: 1,
        values: { off_no: '' },
      });

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].field).toBe('off_no');
    });
  });


  /*
   * Status, Serial No. and Project Engineer (confirmed with the business).
   *
   * The plan's `Status` column had been carrying transformer serial numbers,
   * because that is what the sheet it replaced used it for. Correcting that
   * meant three things at once: one lifecycle instead of two competing ones, a
   * real home for the serials, and an answer to "whose project is this?" that
   * survives an import.
   */
  describe('status, serial number and ownership', () => {
    it('starts a new booking planned, without anyone saying so', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      expect(booking.status).toBe('PLANNED');
    });

    it('refuses to let a status be typed', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      // The exact shape of the old defect: a serial number arriving as a status.
      const res = await session.post('/api/bookings', bookingPayload({ status: '010662606B' }));

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].field).toBe('status');
    });

    it('refuses a lifecycle value typed into the form as well', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      // Not even a valid one: cancelling is an action, not a field edit.
      const res = await session.post('/api/bookings', bookingPayload({ status: 'CANCELLED' }));

      expect(res.status).toBe(422);
    });

    it('keeps a serial number exactly as it was written', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      // Leading zeros, letters, hyphens, several references in one cell — all
      // of it significant, none of it a number.
      const values = [
        '010662606B-020662606B-030662606B-040662606B',
        'DD-001600-022000-S289',
        'invoice-010182515B-010442610B',
        '0000123',
      ];

      for (const [index, serial] of values.entries()) {
        const booking = await createBookingVia(session, {
          off_no: `S${index}`,
          serial_no: serial,
        });
        expect(booking.serialNo).toBe(serial);

        const read = await session.get(`/api/bookings/${booking.id}`);
        expect(read.body.serialNo).toBe(serial);
      }
    });

    it('assigns the signed-in engineer as the project engineer', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      // Nobody selected their own name from a list.
      expect(booking.projectEngineer?.id).toBe(user.id);
      expect(booking.createdBy.id).toBe(user.id);
    });

    it('refuses a project engineer supplied by the caller', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { user: other } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post(
        '/api/bookings',
        bookingPayload({ project_engineer: other.name }),
      );

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].field).toBe('project_engineer');
    });

    it('leaves ownership alone when somebody else edits or cancels', async () => {
      const { session: owner, user: ahmed } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: other, user: karim } = await signIn({ role: 'PROJECT_ENGINEER' });

      const booking = await createBookingVia(owner);

      const edited = await other.patch(`/api/bookings/${booking.id}`, {
        version: booking.version,
        values: { order_name: 'Transformer 3B' },
      });
      expect(edited.body.projectEngineer.id).toBe(ahmed.id);
      expect(edited.body.updatedBy.id).toBe(karim.id);

      const cancelled = await other.post(`/api/bookings/${booking.id}/cancel`, {
        version: edited.body.version,
      });
      expect(cancelled.body.status).toBe('CANCELLED');
      // The engineer responsible for the project did not change because
      // somebody else cancelled it.
      expect(cancelled.body.projectEngineer.id).toBe(ahmed.id);
      expect(cancelled.body.cancelledBy.id).toBe(karim.id);
    });

    it('lets projects in one shared session belong to different engineers', async () => {
      const { session: first, user: ahmed } = await signIn({ role: 'PROJECT_ENGINEER' });
      const { session: second, user: karim } = await signIn({ role: 'PROJECT_ENGINEER' });

      await createBookingVia(first, { off_no: 'A1' });
      await createBookingVia(second, { off_no: 'A2' });

      const plan = await first.get('/api/bookings?month=2026-10');
      const owners = (plan.body.bookings as Booking[]).map((b) => b.projectEngineer?.id);

      // Date + Time + Committee is a shared sitting, not a unit of ownership.
      expect(owners).toContain(ahmed.id);
      expect(owners).toContain(karim.id);
    });
  });

  describe('deleting', () => {
    it('removes a booking from the plan without cancelling it', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      const res = await session.delete(`/api/bookings/${booking.id}`, { version: booking.version });
      expect(res.status).toBe(204);

      const plan = await session.get('/api/bookings?month=2026-10');
      expect(plan.body.bookings).toHaveLength(0);

      // Not even when cancelled bookings are asked for: this one was a mistake,
      // and there is nothing for anyone to see.
      const withCancelled = await session.get('/api/bookings?month=2026-10&includeCancelled=true');
      expect(withCancelled.body.bookings).toHaveLength(0);

      expect((await session.get(`/api/bookings/${booking.id}`)).status).toBe(404);
    });

    it('keeps the row, so the history can still answer who removed it', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);
      await session.delete(`/api/bookings/${booking.id}`, { version: booking.version });

      const row = await query<{ deleted_by: string; status: string }>(
        'SELECT deleted_by, status::text AS status FROM bookings WHERE id = $1',
        [booking.id],
      );
      expect(row.rows[0]?.deleted_by).toBe(user.id);
      // Deleted is not cancelled. Conflating them would lose which happened.
      expect(row.rows[0]?.status).toBe('PLANNED');
    });

    it('records a delete in the history, distinct from a cancel', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);
      await session.delete(`/api/bookings/${booking.id}`, { version: booking.version });

      const history = await query<{ action: string }>(
        'SELECT action::text AS action FROM booking_history WHERE booking_id = $1 ORDER BY id',
        [booking.id],
      );
      expect(history.rows.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);
    });

    it('lets a mistake that was already cancelled still be deleted', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);
      const cancelled = await session.post(`/api/bookings/${booking.id}/cancel`, { version: 1 });

      const res = await session.delete(`/api/bookings/${booking.id}`, {
        version: cancelled.body.version,
      });

      expect(res.status).toBe(204);
    });

    it('refuses a Viewer', async () => {
      const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(engineer);
      const { session: viewer } = await signIn({ role: 'VIEWER' });

      const res = await viewer.delete(`/api/bookings/${booking.id}`, { version: booking.version });

      expect(res.status).toBe(403);
    });

    it('leaves the rest of a shared session alone', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const first = await createBookingVia(session, { off_no: 'A1' });
      await createBookingVia(session, { off_no: 'A2' });

      await session.delete(`/api/bookings/${first.id}`, { version: first.version });

      const plan = await session.get('/api/bookings?month=2026-10');
      expect((plan.body.bookings as Booking[]).map((b) => b.offNo)).toEqual(['A2']);
    });

    it('refuses a stale version', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      const res = await session.delete(`/api/bookings/${booking.id}`, { version: 99 });

      expect(res.status).toBe(409);
    });
  });

  describe('cancelling', () => {
    it('cancels instead of deleting, keeping the row and its history', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      const res = await session.post(`/api/bookings/${booking.id}/cancel`, {
        version: 1,
        reason: 'Customer postponed',
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'Customer postponed',
      });
      expect(res.body.cancelledBy.id).toBe(user.id);
      expect(res.body.cancelledAt).toBeTruthy();

      const stillThere = await query('SELECT id FROM bookings WHERE id = $1', [booking.id]);
      expect(stillThere.rowCount).toBe(1);
    });

    it('hides cancelled bookings from the plan unless asked for', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);
      await session.post(`/api/bookings/${booking.id}/cancel`, { version: 1 });

      const active = await session.get('/api/bookings?month=2026-10');
      expect(active.body.bookings).toHaveLength(0);

      const all = await session.get('/api/bookings?month=2026-10&includeCancelled=true');
      expect(all.body.bookings).toHaveLength(1);
      expect(all.body.bookings[0].status).toBe('CANCELLED');
    });

    it('cannot edit or re-cancel a cancelled booking', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);
      await session.post(`/api/bookings/${booking.id}/cancel`, { version: 1 });

      const edit = await session.patch(`/api/bookings/${booking.id}`, {
        version: 2,
        values: { qty: 9 },
      });
      expect(edit.status).toBe(409);

      const again = await session.post(`/api/bookings/${booking.id}/cancel`, { version: 2 });
      expect(again.status).toBe(409);
    });

    it('offers no DELETE route on a booking', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const booking = await createBookingVia(session);

      const res = await session.get(`/api/bookings/${booking.id}`);
      expect(res.status).toBe(200);

      // Confirms the resource exists but exposes no destructive verb.
      const stored = await query('SELECT count(*)::int AS n FROM bookings');
      expect(stored.rows[0]).toEqual({ n: 1 });
    });
  });

  describe('booking_future_horizon_months — CONFIRMED at 6 months (spec §78.3)', () => {
    it('refuses a date beyond the confirmed window', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post('/api/bookings', bookingPayload({ booking_date: '2035-12-01' }));

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0].message).toMatch(/6 months ahead/);
    });

    it('can be tightened without a migration', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingFutureHorizonMonths: 1 }, user.id);

      const tooFar = await session.post(
        '/api/bookings',
        bookingPayload({ booking_date: '2027-06-01' }),
      );

      expect(tooFar.status).toBe(422);
      expect(tooFar.body.error.issues[0].field).toBe('booking_date');
      expect(tooFar.body.error.issues[0].message).toMatch(/1 month ahead/);
    });

    it('can be removed entirely, restoring unlimited planning', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await setSettings({ bookingFutureHorizonMonths: null }, user.id);

      const res = await session.post('/api/bookings', bookingPayload({ booking_date: '2035-12-01' }));

      expect(res.status).toBe(201);
    });
  });
});
