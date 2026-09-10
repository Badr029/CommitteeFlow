import { Router } from 'express';
import type { BookingHistoryResponse } from '@shared/api-types.js';
import { asyncHandler, parseBody, parseQuery, parseUuidParam } from '../../lib/http.js';
import { currentUser, requireAuth, requireEngineer } from '../../middleware/authenticate.js';
import { writeRateLimiter } from '../../middleware/rate-limit.js';
import { listForBooking } from '../audit/booking-history.repository.js';
import * as planFields from '../plan-config/plan-fields.repository.js';
import * as service from './bookings.service.js';

/**
 * Booking endpoints (spec §38).
 *
 * Reads are open to both roles; every write passes `requireEngineer` *and* the
 * object-level check inside the service (spec §41, §42).
 */
export function bookingsRouter(): Router {
  const router = Router();
  const limitWrites = writeRateLimiter();

  router.use(requireAuth);

  // GET /api/bookings?month=2026-09  (or ?from=&to=)
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = parseQuery(service.listBookingsSchema, req.query);
      res.json(await service.listBookings(query));
    }),
  );

  /**
   * What is already inside a shared Committee Session (spec §46, §78.1).
   *
   * Declared before `/:id` so the literal path is not swallowed by the
   * parameterised one.
   */
  router.get(
    '/session-preview',
    asyncHandler(async (req, res) => {
      const query = parseQuery(service.sessionPreviewSchema, req.query);
      res.json(await service.getSessionPreview(query));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'booking id');
      res.json(await service.getBooking(id));
    }),
  );

  /** Booking history (spec §12, §13) — readable by both roles. */
  router.get(
    '/:id/history',
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'booking id');
      // Ensure the booking exists before exposing its history.
      await service.getBooking(id);

      // Labels come from *all* definitions, archived included, so history about
      // an archived field still reads properly (spec §23).
      const fields = await planFields.listAll();
      const labels = new Map(fields.map((field) => [field.fieldKey, field.label]));

      const body: BookingHistoryResponse = { entries: await listForBooking(id, labels) };
      res.json(body);
    }),
  );

  router.post(
    '/',
    limitWrites,
    requireEngineer,
    asyncHandler(async (req, res) => {
      const input = parseBody(service.bookingValuesSchema, req.body);
      const booking = await service.createBooking(input, currentUser(req));
      res.status(201).json(booking);
    }),
  );

  router.patch(
    '/:id',
    limitWrites,
    requireEngineer,
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'booking id');
      const input = parseBody(service.updateBookingSchema, req.body);
      res.json(await service.updateBooking(id, input, currentUser(req)));
    }),
  );

  /**
   * Cancellation, not deletion (spec §15). There is intentionally no DELETE
   * route on this resource.
   */
  router.post(
    '/:id/cancel',
    limitWrites,
    requireEngineer,
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'booking id');
      const input = parseBody(service.cancelBookingSchema, req.body);
      res.json(await service.cancelBooking(id, input, currentUser(req)));
    }),
  );

  /*
   * Delete is a correction, not a cancellation.
   *
   * DELETE rather than a POST action, because unlike cancelling it really does
   * remove the booking from the plan — even though the row survives as a
   * tombstone so the history can still say who removed it. 204: there is no
   * booking left to return.
   */
  router.delete(
    '/:id',
    limitWrites,
    requireEngineer,
    asyncHandler(async (req, res) => {
      const id = parseUuidParam(req.params.id, 'booking id');
      const input = parseBody(service.deleteBookingSchema, req.body);
      await service.deleteBooking(id, input, currentUser(req));
      res.status(204).end();
    }),
  );

  return router;
}
