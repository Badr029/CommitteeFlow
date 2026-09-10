import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Booking, SessionPreview } from '@shared/api-types.js';
import { closePool } from '../../src/db/pool.js';
import {
  bookingPayload,
  createBookingVia,
  resetDatabase,
  signIn,
} from '../helpers/harness.js';

/**
 * Shared Committee Sessions — CONFIRMED business rule (spec §46, §78.1).
 *
 * Date + Time + Committee is a grouping, not a uniqueness key. One committee
 * sitting at one date and time reviews several projects; different committees
 * run in parallel. Nothing is ever rejected for joining an occupied session.
 */
describe('shared committee sessions', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  it('accepts many projects into one date + time + committee', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

    const results = [];
    for (const offNo of ['202601066', '202501261', '202601449', '202601401']) {
      results.push(
        await session.post(
          '/api/bookings',
          bookingPayload({ off_no: offNo, booking_time: '09:00', committee: 'South Committee' }),
        ),
      );
    }

    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const plan = await session.get('/api/bookings?month=2026-10');
    expect(plan.body.bookings).toHaveLength(4);
  });

  it('lets concurrent bookings into the same session all succeed', async () => {
    const { session: a } = await signIn({ role: 'PROJECT_ENGINEER' });
    const { session: b } = await signIn({ role: 'PROJECT_ENGINEER' });
    const { session: c } = await signIn({ role: 'PROJECT_ENGINEER' });

    // Three engineers, same session, same instant. All three belong.
    const results = await Promise.all([
      a.post('/api/bookings', bookingPayload({ off_no: 'A' })),
      b.post('/api/bookings', bookingPayload({ off_no: 'B' })),
      c.post('/api/bookings', bookingPayload({ off_no: 'C' })),
    ]);

    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(results.some((r) => r.body?.error?.code === 'SLOT_CONFLICT')).toBe(false);
  });

  it('lets different committees run in parallel at the same date and time', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

    for (const committee of ['North Committee', 'South Committee', 'HV Committee']) {
      const res = await session.post(
        '/api/bookings',
        bookingPayload({ off_no: committee.slice(0, 5), committee }),
      );
      expect(res.status, committee).toBe(201);
    }

    const plan = await session.get('/api/bookings?month=2026-10');
    expect(plan.body.facets.committees).toEqual([
      'HV Committee',
      'North Committee',
      'South Committee',
    ]);
  });

  it('never rejects an edit that moves a booking into an occupied session', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
    await createBookingVia(session, { off_no: 'A', booking_time: '09:00' });
    const second = await createBookingVia(session, { off_no: 'B', booking_time: '14:00' });

    const moved = await session.patch(`/api/bookings/${second.id}`, {
      version: second.version,
      values: { booking_time: '09:00' },
    });

    expect(moved.status).toBe(200);
    expect(moved.body.bookingTime).toBe('09:00');
  });

  describe('session preview', () => {
    it('reports what is already in the session an engineer is joining', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, {
        off_no: '202601066',
        order_name: 'Transformer 2B',
        customer_name: 'Aweer Maintenance',
        serial_no: '010422616B',
      });
      await createBookingVia(session, {
        off_no: '202501261',
        order_name: 'HV Cable Box',
        serial_no: '010422621B',
      });

      const res = await session.get(
        '/api/bookings/session-preview?date=2026-10-06&time=10:00&committee=North%20Committee',
      );

      expect(res.status).toBe(200);
      const preview = res.body as SessionPreview;
      expect(preview).toMatchObject({
        bookingDate: '2026-10-06',
        bookingTime: '10:00',
        committee: 'North Committee',
        count: 2,
      });
      expect(preview.bookings.map((b) => b.offNo)).toEqual(['202601066', '202501261']);
      expect(preview.bookings[0]).toMatchObject({
        orderName: 'Transformer 2B',
        customerName: 'Aweer Maintenance',
        // Every new booking starts planned; nobody types a status.
        status: 'PLANNED',
      });
      expect(preview.bookings[0]?.createdBy.id).toBe(user.id);
    });

    it('reports an empty session as a normal, bookable state', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.get(
        '/api/bookings/session-preview?date=2026-11-03&time=09:00&committee=North%20Committee',
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ count: 0, bookings: [] });
    });

    it('separates sessions by committee and by time', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, { off_no: 'N1', committee: 'North Committee' });
      await createBookingVia(session, { off_no: 'S1', committee: 'South Committee' });
      await createBookingVia(session, {
        off_no: 'N2',
        committee: 'North Committee',
        booking_time: '14:00',
      });

      const north10 = await session.get(
        '/api/bookings/session-preview?date=2026-10-06&time=10:00&committee=North%20Committee',
      );
      const north14 = await session.get(
        '/api/bookings/session-preview?date=2026-10-06&time=14:00&committee=North%20Committee',
      );

      expect(north10.body.count).toBe(1);
      expect(north10.body.bookings[0].offNo).toBe('N1');
      expect(north14.body.count).toBe(1);
      expect(north14.body.bookings[0].offNo).toBe('N2');
    });

    it('leaves a cancelled booking out of the session', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const first: Booking = await createBookingVia(session, { off_no: 'A' });
      await createBookingVia(session, { off_no: 'B' });
      await session.post(`/api/bookings/${first.id}/cancel`, { version: first.version });

      const res = await session.get(
        '/api/bookings/session-preview?date=2026-10-06&time=10:00&committee=North%20Committee',
      );

      expect(res.body.count).toBe(1);
      expect(res.body.bookings[0].offNo).toBe('B');
    });

    it('is readable by a viewer and rejects a malformed query', async () => {
      const { session } = await signIn({ role: 'VIEWER' });

      expect(
        (await session.get('/api/bookings/session-preview?date=2026-10-06&time=10:00')).status,
      ).toBe(200);
      expect(
        (await session.get('/api/bookings/session-preview?date=nonsense&time=10:00')).status,
      ).toBe(400);
      expect(
        (await session.get('/api/bookings/session-preview?date=2026-10-06&time=99:99')).status,
      ).toBe(400);
    });

    it('does not collide with the booking-by-id route', async () => {
      const { session } = await signIn({ role: 'VIEWER' });
      const res = await session.get('/api/bookings/session-preview?date=2026-10-06&time=10:00');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('count');
    });
  });

  describe('confirmed horizon of 6 months (spec §78.3)', () => {
    it('accepts a booking inside the window', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const withinWindow = new Date();
      withinWindow.setMonth(withinWindow.getMonth() + 2);
      const date = withinWindow.toISOString().slice(0, 10);

      const res = await session.post('/api/bookings', bookingPayload({ booking_date: date }));

      expect(res.status).toBe(201);
    });

    it('refuses a booking beyond it, naming the limit', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const beyond = new Date();
      beyond.setMonth(beyond.getMonth() + 9);
      const date = beyond.toISOString().slice(0, 10);

      const res = await session.post('/api/bookings', bookingPayload({ booking_date: date }));

      expect(res.status).toBe(422);
      expect(res.body.error.issues[0]).toMatchObject({ field: 'booking_date' });
      expect(res.body.error.issues[0].message).toMatch(/6 months ahead/);
    });

    it('still allows a booking in a past month, so history can be corrected', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const res = await session.post('/api/bookings', bookingPayload({ booking_date: '2020-05-04' }));

      expect(res.status).toBe(201);
    });
  });
});
