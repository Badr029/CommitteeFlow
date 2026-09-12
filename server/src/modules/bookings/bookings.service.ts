import { z } from 'zod';
import type {
  Booking,
  BookingFieldChange,
  BookingListResponse,
  PlanFieldValue,
  SessionPreview,
  SlotUniqueness,
} from '@shared/api-types.js';
import { advisoryXactLock, withTransaction } from '../../db/index.js';
import type { Queryable } from '../../db/index.js';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  slotConflict,
  validationFailed,
  versionConflict,
} from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { addMonths, endOfMonth, isAfter, startOfMonth, today } from '../../lib/dates.js';
import { zonedDateTime } from '../../lib/dates.js';
import { env } from '../../config/env.js';
import type { UserRecord } from '../users/users.repository.js';
import * as usersRepository from '../users/users.repository.js';
import { getSettings } from '../plan-config/settings.service.js';
import * as planFields from '../plan-config/plan-fields.repository.js';
import type { PlanFieldRecord } from '../plan-config/plan-fields.repository.js';
import { recordBookingHistory } from '../audit/booking-history.repository.js';
import { enqueueEmail } from '../notifications/outbox.repository.js';
import { buildPayload, buildSubject } from '../notifications/templates.js';
import * as repository from './bookings.repository.js';
import { toValueSnapshot } from './bookings.repository.js';
import {
  ValueValidationError,
  diffValues,
  normalizeBookingValues,
} from './booking-values.js';

/**
 * Booking domain (spec §3, §12, §13, §15, §47, §48, §50, §72).
 *
 * Every write is one transaction containing the booking change, its audit
 * entry and its outbox message. Authorisation is re-checked here, at the object
 * level, not only at the route (spec §42).
 */

const planFieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const bookingValuesSchema = z.object({
  values: z.record(z.string(), planFieldValue),
});

export const updateBookingSchema = bookingValuesSchema.extend({
  version: z.number().int().positive(),
});

export const cancelBookingSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().max(1000).optional(),
});

export const listBookingsSchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'Month must look like 2026-09.')
      .optional(),
    search: z.string().trim().max(200).optional(),
    committee: z.string().trim().max(120).optional(),
    status: z.string().trim().max(80).optional(),
    /*
     * Whose project this is, not who typed it. The old `createdBy` filter
     * answered the second question and was almost always the wrong one: after
     * an import, every row in the month shared a single creator.
     */
    projectEngineer: z.uuid().optional(),
    includeCancelled: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
  })
  .transform((query) => {
    // A month is the primary navigation unit; from/to remain available for
    // exports and any future range view.
    if (query.month) {
      const anchor = `${query.month}-01`;
      return { ...query, from: startOfMonth(anchor), to: endOfMonth(anchor) };
    }
    const anchor = query.from ?? query.to ?? today();
    return {
      ...query,
      from: query.from ?? startOfMonth(anchor),
      to: query.to ?? endOfMonth(anchor),
    };
  })
  .refine((query) => query.from <= query.to, {
    message: 'The start of the range must not be after the end.',
    path: ['from'],
  })
  .refine((query) => rangeDays(query.from, query.to) <= 400, {
    // Bounded so one request can never pull the entire history (spec §53).
    message: 'Ranges longer than about 13 months are not supported.',
    path: ['to'],
  });

function rangeDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export type ListBookingsQuery = z.infer<typeof listBookingsSchema>;

export async function listBookings(query: ListBookingsQuery): Promise<BookingListResponse> {
  const [bookings, facets] = await Promise.all([
    repository.list({
      from: query.from,
      to: query.to,
      search: query.search,
      committee: query.committee,
      status: query.status,
      projectEngineer: query.projectEngineer,
      includeCancelled: query.includeCancelled ?? false,
    }),
    repository.facetsForRange(query.from, query.to),
  ]);

  return { bookings, facets, range: { from: query.from, to: query.to } };
}

/**
 * Preview of a shared Committee Session.
 *
 * CONFIRMED business rule (spec §46, §78.1): a session is a grouping, so this
 * exists purely to tell the engineer what is already in the session they are
 * joining. It never gates the write.
 */
export const sessionPreviewSchema = z.object({
  date: z.iso.date(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Time must look like 14:30.')
    .transform((value) => value.slice(0, 5)),
  committee: z.string().trim().max(120).optional(),
});

export async function getSessionPreview(
  query: z.infer<typeof sessionPreviewSchema>,
): Promise<SessionPreview> {
  return repository.findSessionBookings({
    bookingDate: query.date,
    bookingTime: query.time,
    committee: query.committee && query.committee !== '' ? query.committee : null,
  });
}

export async function getBooking(id: string): Promise<Booking> {
  const booking = await repository.findById(id);
  // A deleted booking is a mistake that was taken back; the history remembers
  // it, the plan does not.
  if (!booking || booking.deletedAt !== null) throw notFound('That booking does not exist.');
  return booking;
}

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

/**
 * Object-level authorisation for editing or cancelling a booking (spec §42).
 *
 * CONFIRMED (§41, §78.2): any Project Engineer may edit or cancel any booking.
 * The policy is still read from settings rather than hardcoded, so ownership
 * can be tightened later without touching this code path.
 */
export async function assertCanModify(user: UserRecord, booking: Booking): Promise<void> {
  if (user.role !== 'PROJECT_ENGINEER') {
    throw forbidden('Only Project Engineers can change bookings.');
  }
  if (booking.deletedAt !== null) {
    throw notFound('That booking does not exist.');
  }
  if (booking.status === 'CANCELLED') {
    throw conflict('This booking has been cancelled and can no longer be changed.');
  }

  await assertMeetsEditPolicy(user, booking);
}

/**
 * The configured ownership rule, on its own.
 *
 * Separated from `assertCanModify` because deleting has to apply the same rule
 * to a booking that may already be cancelled: a row entered by mistake and then
 * cancelled was still entered by mistake, and correcting it is exactly what
 * delete is for.
 */
export async function assertMeetsEditPolicy(user: UserRecord, booking: Booking): Promise<void> {
  const { bookingEditPolicy } = await getSettings();
  const isCreator = booking.createdBy.id === user.id;

  switch (bookingEditPolicy) {
    case 'ANY_ENGINEER':
      return;
    case 'CREATOR_ONLY':
      if (!isCreator) {
        throw forbidden('Only the engineer who created this booking can change it.');
      }
      return;
    case 'CREATOR_OR_PLAN_MANAGER':
      if (!isCreator && !user.canManagePlanConfiguration) {
        throw forbidden('Only the booking’s creator or a plan manager can change it.');
      }
      return;
    default: {
      const never: never = bookingEditPolicy;
      throw new Error(`unhandled booking edit policy: ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Slot exclusivity — CONFIRMED as NONE (spec §46, §47, §78.1)
// ---------------------------------------------------------------------------

/**
 * Committee sessions are shared.
 *
 * The confirmed rule is that Date + Time + Committee groups bookings rather
 * than restricting them: one committee sitting at one time reviews several
 * projects, and different committees may run in parallel. With the setting at
 * its confirmed value `NONE` this returns `null` and no booking is ever
 * rejected for occupying a taken slot.
 *
 * The stricter keys stay implemented, and stay covered by tests, so the rule
 * can be tightened later from Plan Configuration without a migration or a
 * redeploy — and so the concurrency guarantee in §47 is already in place if it
 * ever is. Nothing here is inferred: the parts are exactly what the rule names.
 */
function slotKeyFor(
  rule: SlotUniqueness,
  values: { bookingDate: string; bookingTime: string; committee: string | null },
): { key: string; criteria: { bookingDate: string; bookingTime?: string; committee?: string | null } } | null {
  switch (rule) {
    case 'NONE':
      return null;
    case 'DATE':
      return { key: `slot|${values.bookingDate}`, criteria: { bookingDate: values.bookingDate } };
    case 'DATE_TIME':
      return {
        key: `slot|${values.bookingDate}|${values.bookingTime}`,
        criteria: { bookingDate: values.bookingDate, bookingTime: values.bookingTime },
      };
    case 'DATE_TIME_COMMITTEE':
      return {
        key: `slot|${values.bookingDate}|${values.bookingTime}|${values.committee ?? ''}`,
        criteria: {
          bookingDate: values.bookingDate,
          bookingTime: values.bookingTime,
          committee: values.committee,
        },
      };
    default: {
      const never: never = rule;
      throw new Error(`unhandled slot uniqueness rule: ${String(never)}`);
    }
  }
}

/**
 * Enforces the configured exclusivity rule inside the write transaction.
 *
 * The advisory lock is what makes this safe against the race in spec §47: two
 * engineers submitting the same slot milliseconds apart serialise on the same
 * lock key in PostgreSQL, so the second one sees the first one's row and is
 * rejected. The lock is transaction-scoped and released automatically.
 *
 * Once the rule is confirmed, a partial UNIQUE index should be added as a
 * second line of defence — see docs/open-business-rules.md.
 */
async function enforceSlotRule(
  tx: Queryable,
  rule: SlotUniqueness,
  values: { bookingDate: string; bookingTime: string; committee: string | null },
  excludeBookingId: string | null,
): Promise<void> {
  const slot = slotKeyFor(rule, values);
  if (!slot) return;

  await advisoryXactLock(tx, slot.key);

  const occupants = await repository.findSlotOccupants(slot.criteria, excludeBookingId, tx);
  if (occupants.length === 0) return;

  throw slotConflict(describeSlotConflict(rule, values, occupants.length), occupants);
}

function describeSlotConflict(
  rule: SlotUniqueness,
  values: { bookingDate: string; bookingTime: string; committee: string | null },
  count: number,
): string {
  const plural = count === 1 ? 'booking' : 'bookings';
  switch (rule) {
    case 'DATE':
      return `${values.bookingDate} already has ${count} ${plural}, and the plan allows only one booking per date.`;
    case 'DATE_TIME':
      return `${values.bookingDate} at ${values.bookingTime} is already taken.`;
    case 'DATE_TIME_COMMITTEE':
      return `${values.committee ?? 'That committee'} is already booked on ${values.bookingDate} at ${values.bookingTime}.`;
    default:
      return 'That committee slot is already taken.';
  }
}

// ---------------------------------------------------------------------------
// Booking-date policy (spec §9, §78.3)
// ---------------------------------------------------------------------------

/**
 * Future-month booking is confirmed (§9), and the horizon is now confirmed at
 * 6 months (§78.3). It stays a setting so the window can be changed without a
 * redeploy; `null` restores unlimited.
 */
async function assertDateWithinHorizon(bookingDate: string): Promise<void> {
  const { bookingFutureHorizonMonths } = await getSettings();
  if (bookingFutureHorizonMonths === null) return;

  const limit = endOfMonth(addMonths(today(), bookingFutureHorizonMonths));
  if (isAfter(bookingDate, limit)) {
    throw validationFailed([
      {
        field: 'booking_date',
        message: `Bookings can be made up to ${bookingFutureHorizonMonths} month${
          bookingFutureHorizonMonths === 1 ? '' : 's'
        } ahead (through ${limit}).`,
      },
    ]);
  }
}

function assertNotInPast(bookingDate: string, bookingTime: string): void {
  const now = zonedDateTime(env().APP_TIME_ZONE);
  if (bookingDate < now.date || (bookingDate === now.date && bookingTime.slice(0, 5) < now.time)) {
    throw validationFailed([
      { field: 'booking_date', message: 'Choose a date and time that has not passed.' },
      { field: 'booking_time', message: 'Choose a date and time that has not passed.' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function requireDateAndTime(values: Record<string, PlanFieldValue>): {
  bookingDate: string;
  bookingTime: string;
} {
  const bookingDate = values['booking_date'];
  const bookingTime = values['booking_time'];
  if (typeof bookingDate !== 'string' || typeof bookingTime !== 'string') {
    throw validationFailed([
      { field: 'booking_date', message: 'A booking needs a date and a time.' },
    ]);
  }
  return { bookingDate, bookingTime };
}

function labelMap(fields: readonly PlanFieldRecord[]): Map<string, string> {
  return new Map(fields.map((field) => [field.fieldKey, field.label]));
}

function toChanges(
  keys: string[],
  before: Record<string, PlanFieldValue>,
  after: Record<string, PlanFieldValue>,
  labels: ReadonlyMap<string, string>,
): BookingFieldChange[] {
  return keys.map((fieldKey) => ({
    fieldKey,
    label: labels.get(fieldKey) ?? fieldKey,
    from: before[fieldKey] ?? null,
    to: after[fieldKey] ?? null,
  }));
}

export async function createBooking(
  input: { values: Record<string, unknown> },
  actor: UserRecord,
): Promise<Booking> {
  if (actor.role !== 'PROJECT_ENGINEER') {
    throw forbidden('Only Project Engineers can create bookings.');
  }

  const activeFields = await planFields.listActive();
  const normalized = normalizeValues(input.values, activeFields, 'create');
  const { bookingDate, bookingTime } = requireDateAndTime(normalized.flat);
  assertNotInPast(bookingDate, bookingTime);
  await assertDateWithinHorizon(bookingDate);

  const settings = await getSettings();
  const recipients = await usersRepository.listNotificationRecipients(settings.notificationAudience);

  const booking = await withTransaction(async (tx) => {
    await enforceSlotRule(
      tx,
      settings.bookingSlotUniqueness,
      {
        bookingDate,
        bookingTime,
        committee: asNullableString(normalized.flat['committee']),
      },
      null,
    );

    const created = await repository.insert(
      {
        columns: normalized.columns,
        customFields: normalized.customFields,
        actorId: actor.id,
        /*
         * The engineer arranging the booking is the engineer who owns it, so
         * nobody is asked to select their own name from a list. It is stored
         * separately from `created_by` because the two diverge as soon as
         * anyone imports a sheet or books on a colleague's behalf, and only one
         * of them is a business fact.
         */
        projectEngineerId: actor.id,
      },
      tx,
    );

    await recordBookingHistory(
      {
        bookingId: created.id,
        action: 'CREATE',
        actorId: actor.id,
        oldValues: null,
        newValues: normalized.flat,
        changedKeys: Object.keys(normalized.flat),
        bookingVersion: created.version,
      },
      tx,
    );

    const payload = buildPayload('BOOKING_CREATED', created, actor.name, []);
    await enqueueEmail(
      {
        eventType: 'BOOKING_CREATED',
        bookingId: created.id,
        recipients,
        subject: buildSubject(payload),
        payload: payload as unknown as Record<string, unknown>,
      },
      tx,
    );

    return created;
  });

  logger.info(
    { bookingId: booking.id, actorId: actor.id, bookingDate: booking.bookingDate },
    'booking created',
  );
  return booking;
}

export async function updateBooking(
  id: string,
  input: { values: Record<string, unknown>; version: number },
  actor: UserRecord,
): Promise<Booking> {
  const activeFields = await planFields.listActive();
  const allFields = await planFields.listAll();
  const normalized = normalizeValues(input.values, activeFields, 'update');
  const settings = await getSettings();
  const recipients = await usersRepository.listNotificationRecipients(settings.notificationAudience);

  const result = await withTransaction(async (tx) => {
    const existing = await repository.findByIdForUpdate(id, tx);
    if (!existing) throw notFound('That booking does not exist.');

    await assertCanModify(actor, existing);

    if (existing.version !== input.version) {
      throw versionConflict(existing.version);
    }

    const before = repository.toValueSnapshot(existing);
    const after = { ...before, ...normalized.flat };
    const diff = diffValues(before, after);

    if (diff.changedKeys.length === 0) {
      // Nothing actually changed — do not manufacture history or an email.
      return { booking: existing, changes: [] as BookingFieldChange[] };
    }

    const bookingDate = String(after['booking_date']);
    const bookingTime = String(after['booking_time']);

    if (diff.changedKeys.includes('booking_date')) {
      await assertDateWithinHorizon(bookingDate);
    }
    if (diff.changedKeys.some((key) => key === 'booking_date' || key === 'booking_time')) {
      assertNotInPast(bookingDate, bookingTime);
    }

    // Re-check exclusivity whenever any part of the slot key moved.
    if (
      diff.changedKeys.some((key) => ['booking_date', 'booking_time', 'committee'].includes(key))
    ) {
      await enforceSlotRule(
        tx,
        settings.bookingSlotUniqueness,
        { bookingDate, bookingTime, committee: asNullableString(after['committee']) },
        existing.id,
      );
    }

    const updated = await repository.update(
      {
        id,
        expectedVersion: input.version,
        columns: normalized.columns,
        customFields: normalized.customFields,
        actorId: actor.id,
      },
      tx,
    );
    if (!updated) {
      // Lost the race between the read and the write.
      const current = await repository.currentVersion(id, tx);
      throw versionConflict(current ?? input.version);
    }

    await recordBookingHistory(
      {
        bookingId: updated.id,
        action: 'UPDATE',
        actorId: actor.id,
        oldValues: diff.oldValues,
        newValues: diff.newValues,
        changedKeys: diff.changedKeys,
        bookingVersion: updated.version,
      },
      tx,
    );

    const changes = toChanges(diff.changedKeys, diff.oldValues, diff.newValues, labelMap(allFields));
    const payload = buildPayload('BOOKING_UPDATED', updated, actor.name, changes);
    await enqueueEmail(
      {
        eventType: 'BOOKING_UPDATED',
        bookingId: updated.id,
        recipients,
        subject: buildSubject(payload),
        payload: payload as unknown as Record<string, unknown>,
      },
      tx,
    );

    return { booking: updated, changes };
  });

  if (result.changes.length > 0) {
    logger.info(
      { bookingId: id, actorId: actor.id, changed: result.changes.map((c) => c.fieldKey) },
      'booking updated',
    );
  }
  return result.booking;
}

export async function cancelBooking(
  id: string,
  input: { version: number; reason?: string | undefined },
  actor: UserRecord,
): Promise<Booking> {
  const settings = await getSettings();
  const recipients = await usersRepository.listNotificationRecipients(settings.notificationAudience);

  const booking = await withTransaction(async (tx) => {
    const existing = await repository.findByIdForUpdate(id, tx);
    if (!existing) throw notFound('That booking does not exist.');

    await assertCanModify(actor, existing);

    if (existing.version !== input.version) {
      throw versionConflict(existing.version);
    }

    const cancelled = await repository.cancel(
      { id, expectedVersion: input.version, actorId: actor.id, reason: input.reason ?? null },
      tx,
    );
    if (!cancelled) {
      const current = await repository.currentVersion(id, tx);
      throw versionConflict(current ?? input.version);
    }

    await recordBookingHistory(
      {
        bookingId: cancelled.id,
        action: 'CANCEL',
        actorId: actor.id,
        oldValues: { status: 'PLANNED' },
        newValues: {
          status: 'CANCELLED',
          cancellation_reason: input.reason ?? null,
        },
        changedKeys: ['status'],
        bookingVersion: cancelled.version,
      },
      tx,
    );

    const payload = buildPayload('BOOKING_CANCELLED', cancelled, actor.name, []);
    await enqueueEmail(
      {
        eventType: 'BOOKING_CANCELLED',
        bookingId: cancelled.id,
        recipients,
        subject: buildSubject(payload),
        payload: payload as unknown as Record<string, unknown>,
      },
      tx,
    );

    return cancelled;
  });

  logger.info({ bookingId: id, actorId: actor.id }, 'booking cancelled');
  return booking;
}

export const deleteBookingSchema = z.object({
  version: z.number().int().positive(),
});

/**
 * Removes a booking that should never have been made.
 *
 * Distinct from cancelling, and the distinction is the point. A cancellation
 * says a real committee is no longer coming, and the booking stays on the plan
 * struck through so nobody prepares a transformer for it. A deletion says the
 * row itself was wrong — a duplicate, the wrong project — and there is nothing
 * for anyone to see.
 *
 * So the two are separate events with separate history entries, and deleting
 * never sets the status to CANCELLED: conflating them would make the plan
 * unable to answer which of the two actually happened.
 *
 * The row is kept. `deleted_at` and `deleted_by` are a tombstone, so "who
 * removed this, and when" survives a mistake being taken back.
 */
export async function deleteBooking(
  id: string,
  input: { version: number },
  actor: UserRecord,
): Promise<void> {
  const settings = await getSettings();
  const recipients = await usersRepository.listNotificationRecipients(settings.notificationAudience);

  const deleted = await withTransaction(async (tx) => {
    const existing = await repository.findByIdForUpdate(id, tx);
    if (!existing || existing.deletedAt !== null) {
      throw notFound('That booking does not exist.');
    }

    /*
     * Deleting is a correction, so a cancelled booking may still be deleted —
     * a booking entered by mistake and then cancelled was still entered by
     * mistake. `assertCanModify` refuses cancelled bookings, which is right for
     * editing and wrong here, so the role and policy checks are made directly.
     */
    if (actor.role !== 'PROJECT_ENGINEER') {
      throw forbidden('Only Project Engineers can delete bookings.');
    }
    await assertMeetsEditPolicy(actor, existing);

    if (existing.version !== input.version) {
      throw versionConflict(existing.version);
    }

    const removed = await repository.softDelete(
      { id, expectedVersion: input.version, actorId: actor.id },
      tx,
    );
    if (!removed) {
      const current = await repository.currentVersion(id, tx);
      throw versionConflict(current ?? input.version);
    }

    await recordBookingHistory(
      {
        bookingId: removed.id,
        action: 'DELETE',
        actorId: actor.id,
        // The values as they stood, so the history can still show what was
        // removed rather than only that something was.
        oldValues: toValueSnapshot(existing),
        newValues: null,
        changedKeys: [],
        bookingVersion: removed.version,
      },
      tx,
    );

    /*
     * People who saw the booking on the plan need to know it has gone, for the
     * same reason a cancellation is announced: they may be acting on it.
     */
    const payload = buildPayload('BOOKING_DELETED', removed, actor.name, []);
    await enqueueEmail(
      {
        eventType: 'BOOKING_DELETED',
        bookingId: removed.id,
        recipients,
        subject: buildSubject(payload),
        payload: payload as unknown as Record<string, unknown>,
      },
      tx,
    );

    return removed;
  });

  logger.info({ bookingId: deleted.id, actorId: actor.id }, 'booking deleted');
}

function normalizeValues(
  values: Record<string, unknown>,
  activeFields: readonly PlanFieldRecord[],
  mode: 'create' | 'update',
) {
  try {
    return normalizeBookingValues(values, activeFields, { mode });
  } catch (error) {
    if (error instanceof ValueValidationError) {
      throw validationFailed(error.issues);
    }
    throw error;
  }
}

function asNullableString(value: PlanFieldValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export { badRequest };
