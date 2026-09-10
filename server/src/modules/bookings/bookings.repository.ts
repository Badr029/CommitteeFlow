import type {
  Booking,
  BookingDataSource,
  BookingStatus,
  PlanFieldValue,
  SessionPreview,
  UserRef,
} from '@shared/api-types.js';
import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';
import { displayDayFor, normalizeTime } from '../../lib/dates.js';
import { COLUMN_FIELD_KEYS, assertColumnKey, columnFor } from '../plan-config/field-keys.js';

/**
 * Booking persistence.
 *
 * Every value reaches PostgreSQL as a bound parameter. Column *names* are only
 * ever taken from the closed COLUMN_FIELD_KEYS allow-list (spec §44).
 */

interface BookingRow {
  id: string;
  booking_date: string;
  booking_time: string;
  off_no: string | null;
  order_name: string | null;
  committee: string | null;
  qty: number | null;
  kva: number | null;
  kv: string | null;
  status: BookingStatus;
  serial_no: string | null;
  notes: string | null;
  customer_name: string | null;
  custom_fields: Record<string, PlanFieldValue> | null;
  cancelled_at: Date | null;
  cancellation_reason: string | null;
  deleted_at: Date | null;
  data_source: BookingDataSource;
  external_reference: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  created_by_id: string;
  created_by_name: string;
  created_by_email: string;
  updated_by_id: string;
  updated_by_name: string;
  updated_by_email: string;
  cancelled_by_id: string | null;
  cancelled_by_name: string | null;
  cancelled_by_email: string | null;
  deleted_by_id: string | null;
  deleted_by_name: string | null;
  deleted_by_email: string | null;
  project_engineer_id: string | null;
  project_engineer_name: string | null;
  project_engineer_email: string | null;
}

const SELECT_BOOKING = `
  SELECT b.id,
         b.booking_date,
         b.booking_time,
         b.off_no,
         b.order_name,
         b.committee,
         b.qty,
         b.kva,
         b.kv,
         b.status,
         b.serial_no,
         b.notes,
         b.customer_name,
         b.custom_fields,
         b.cancelled_at,
         b.cancellation_reason,
         b.deleted_at,
         b.data_source,
         b.external_reference,
         b.created_at,
         b.updated_at,
         b.version,
         cu.id    AS created_by_id,
         cu.name  AS created_by_name,
         cu.email AS created_by_email,
         uu.id    AS updated_by_id,
         uu.name  AS updated_by_name,
         uu.email AS updated_by_email,
         xu.id    AS cancelled_by_id,
         xu.name  AS cancelled_by_name,
         xu.email AS cancelled_by_email,
         du.id    AS deleted_by_id,
         du.name  AS deleted_by_name,
         du.email AS deleted_by_email,
         pe.id    AS project_engineer_id,
         pe.name  AS project_engineer_name,
         pe.email AS project_engineer_email
    FROM bookings b
    JOIN users cu      ON cu.id = b.created_by
    JOIN users uu      ON uu.id = b.updated_by
    LEFT JOIN users xu ON xu.id = b.cancelled_by
    LEFT JOIN users du ON du.id = b.deleted_by
    LEFT JOIN users pe ON pe.id = b.project_engineer_id
`;

function userRef(id: string, name: string, email: string): UserRef {
  return { id, name, email };
}

export function toApi(row: BookingRow): Booking {
  return {
    id: row.id,
    bookingDate: row.booking_date,
    bookingTime: normalizeTime(row.booking_time),
    displayDay: displayDayFor(row.booking_date),
    offNo: row.off_no,
    orderName: row.order_name,
    committee: row.committee,
    qty: row.qty,
    kva: row.kva,
    kv: row.kv,
    status: row.status,
    serialNo: row.serial_no,
    notes: row.notes,
    customerName: row.customer_name,
    customFields: row.custom_fields ?? {},
    projectEngineer:
      row.project_engineer_id && row.project_engineer_name && row.project_engineer_email
        ? userRef(row.project_engineer_id, row.project_engineer_name, row.project_engineer_email)
        : null,
    cancelledBy:
      row.cancelled_by_id && row.cancelled_by_name && row.cancelled_by_email
        ? userRef(row.cancelled_by_id, row.cancelled_by_name, row.cancelled_by_email)
        : null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancellationReason: row.cancellation_reason,
    deletedBy:
      row.deleted_by_id && row.deleted_by_name && row.deleted_by_email
        ? userRef(row.deleted_by_id, row.deleted_by_name, row.deleted_by_email)
        : null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    dataSource: row.data_source,
    externalReference: row.external_reference,
    createdBy: userRef(row.created_by_id, row.created_by_name, row.created_by_email),
    createdAt: row.created_at.toISOString(),
    updatedBy: userRef(row.updated_by_id, row.updated_by_name, row.updated_by_email),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

/** The flat value snapshot used for audit diffs, keyed by plan field key. */
export function toValueSnapshot(booking: Booking): Record<string, PlanFieldValue> {
  return {
    booking_date: booking.bookingDate,
    booking_time: booking.bookingTime,
    off_no: booking.offNo,
    order_name: booking.orderName,
    committee: booking.committee,
    qty: booking.qty,
    kva: booking.kva,
    kv: booking.kv,
    status: booking.status,
    serial_no: booking.serialNo,
    // The engineer's name, not their id: a history entry is read by a person,
    // and "Ahmed Hassan → Karim Ayman" says more than two UUIDs would.
    project_engineer: booking.projectEngineer?.name ?? null,
    notes: booking.notes,
    customer_name: booking.customerName,
    ...booking.customFields,
  };
}

export async function findById(
  id: string,
  executor?: Queryable,
): Promise<Booking | undefined> {
  const row = await queryOne<BookingRow>(`${SELECT_BOOKING} WHERE b.id = $1`, [id], executor);
  return row ? toApi(row) : undefined;
}

/** Locks the row for the duration of the transaction, for safe read-modify-write. */
export async function findByIdForUpdate(
  id: string,
  tx: Queryable,
): Promise<Booking | undefined> {
  // FOR UPDATE cannot be applied to the outer join, so lock the row first.
  const locked = await queryOne<{ id: string }>(
    'SELECT id FROM bookings WHERE id = $1 FOR UPDATE',
    [id],
    tx,
  );
  if (!locked) return undefined;
  return findById(id, tx);
}

export interface ListBookingsFilters {
  from: string;
  to: string;
  search?: string | undefined;
  committee?: string | undefined;
  status?: string | undefined;
  /**
   * The engineer a project belongs to — not the account that typed it.
   *
   * This used to filter on `created_by`, which answered a question nobody was
   * asking: after an import, every row in the month was "created by" whoever
   * uploaded the file.
   */
  projectEngineer?: string | undefined;
  includeCancelled: boolean;
}

/**
 * One month of the plan (spec §53).
 *
 * Always bounded by a date range — the endpoint has no "everything" mode, so a
 * page load can never turn into a full table scan.
 */
export async function list(
  filters: ListBookingsFilters,
  executor?: Queryable,
): Promise<Booking[]> {
  const conditions = ['b.booking_date BETWEEN $1 AND $2'];
  const values: unknown[] = [filters.from, filters.to];

  /*
   * A deleted booking is gone from the plan whatever else is asked for: it was
   * entered by mistake, and unlike a cancelled one there is nothing to see.
   */
  conditions.push('b.deleted_at IS NULL');

  if (!filters.includeCancelled) {
    conditions.push("b.status = 'PLANNED'");
  }
  if (filters.committee) {
    values.push(filters.committee);
    conditions.push(`b.committee = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`b.status = $${values.length}`);
  }
  if (filters.projectEngineer) {
    values.push(filters.projectEngineer);
    conditions.push(`b.project_engineer_id = $${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search}%`);
    const placeholder = `$${values.length}`;
    conditions.push(`(
      b.off_no ILIKE ${placeholder}
      OR b.order_name ILIKE ${placeholder}
      OR b.customer_name ILIKE ${placeholder}
      OR b.committee ILIKE ${placeholder}
      OR b.notes ILIKE ${placeholder}
      OR b.serial_no ILIKE ${placeholder}
    )`);
  }

  const rows = await queryRows<BookingRow>(
    `${SELECT_BOOKING}
      WHERE ${conditions.join(' AND ')}
      ORDER BY b.booking_date, b.booking_time, b.off_no NULLS LAST, b.created_at`,
    values,
    executor,
  );
  return rows.map(toApi);
}

/** Distinct values in a range, used to populate the filter menus (spec §6). */
export async function facetsForRange(
  from: string,
  to: string,
  executor?: Queryable,
): Promise<{ committees: string[]; statuses: string[]; engineers: UserRef[] }> {
  const [committees, statuses, engineers] = await Promise.all([
    queryRows<{ value: string }>(
      `SELECT DISTINCT committee AS value
         FROM bookings
        WHERE booking_date BETWEEN $1 AND $2
          AND deleted_at IS NULL
          AND committee IS NOT NULL AND committee <> ''
        ORDER BY value`,
      [from, to],
      executor,
    ),
    /*
     * Status has two values now, so this asks which of them the month actually
     * contains rather than collecting whatever text was typed. A month with
     * nothing cancelled offers no Cancelled filter, which is the same rule the
     * committee facet has always followed.
     */
    queryRows<{ value: string }>(
      `SELECT DISTINCT status::text AS value
         FROM bookings
        WHERE booking_date BETWEEN $1 AND $2 AND deleted_at IS NULL
        ORDER BY value`,
      [from, to],
      executor,
    ),
    queryRows<UserRef>(
      `SELECT DISTINCT u.id, u.name, u.email
         FROM bookings b
         JOIN users u ON u.id = b.project_engineer_id
        WHERE b.booking_date BETWEEN $1 AND $2 AND b.deleted_at IS NULL
        ORDER BY u.name`,
      [from, to],
      executor,
    ),
  ]);

  return {
    committees: committees.map((row) => row.value),
    statuses: statuses.map((row) => row.value),
    engineers,
  };
}

export interface InsertBookingInput {
  columns: Record<string, PlanFieldValue>;
  customFields: Record<string, PlanFieldValue>;
  actorId: string;
  /**
   * Provenance (spec §33). Defaults to a hand-entered booking; an import passes
   * IMPORT together with the batch that created the row, so the two can never
   * disagree about where a booking came from.
   */
  dataSource?: 'MANUAL' | 'ERP' | 'IMPORT';
  importBatchId?: string;
  /**
   * The engineer this project belongs to.
   *
   * For an ordinary booking this is whoever is signed in, and equals `actorId`.
   * An import passes it only when the file named someone the system could match
   * to a single account — otherwise it stays null, because the alternative is
   * to record that the person who ran the import owns every project in it.
   */
  projectEngineerId?: string | null;
}

export async function insert(input: InsertBookingInput, tx: Queryable): Promise<Booking> {
  const names: string[] = [];
  const placeholders: string[] = [];
  const values: unknown[] = [];

  for (const key of COLUMN_FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input.columns, key)) continue;
    assertColumnKey(key);
    values.push(input.columns[key]);
    names.push(`"${columnFor(key)}"`);
    placeholders.push(`$${values.length}`);
  }

  values.push(JSON.stringify(input.customFields));
  names.push('custom_fields');
  placeholders.push(`$${values.length}::jsonb`);

  if (input.dataSource && input.dataSource !== 'MANUAL') {
    values.push(input.dataSource);
    names.push('data_source');
    placeholders.push(`$${values.length}::booking_data_source`);
  }

  if (input.importBatchId) {
    values.push(input.importBatchId);
    names.push('import_batch_id');
    placeholders.push(`$${values.length}`);
  }

  if (input.projectEngineerId !== undefined) {
    values.push(input.projectEngineerId);
    names.push('project_engineer_id');
    placeholders.push(`$${values.length}`);
  }

  values.push(input.actorId);
  const actorPlaceholder = `$${values.length}`;
  names.push('created_by', 'updated_by');
  placeholders.push(actorPlaceholder, actorPlaceholder);

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO bookings (${names.join(', ')})
     VALUES (${placeholders.join(', ')})
     RETURNING id`,
    values,
    tx,
  );
  if (!inserted) throw new Error('booking insert returned no row');

  const booking = await findById(inserted.id, tx);
  if (!booking) throw new Error('booking disappeared immediately after insert');
  return booking;
}

export interface UpdateBookingInput {
  id: string;
  expectedVersion: number;
  columns: Record<string, PlanFieldValue>;
  /** Merged into the existing JSONB object, so untouched keys survive. */
  customFields: Record<string, PlanFieldValue>;
  actorId: string;
}

/**
 * Applies an update only if the caller's version still matches (spec §48).
 *
 * Returns `undefined` when the version moved on, which the service turns into a
 * 409. The check is in the WHERE clause, so it is atomic with the write.
 */
export async function update(
  input: UpdateBookingInput,
  tx: Queryable,
): Promise<Booking | undefined> {
  const assignments: string[] = [];
  const values: unknown[] = [input.id, input.expectedVersion];

  for (const key of COLUMN_FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input.columns, key)) continue;
    assertColumnKey(key);
    values.push(input.columns[key]);
    assignments.push(`"${columnFor(key)}" = $${values.length}`);
  }

  if (Object.keys(input.customFields).length > 0) {
    values.push(JSON.stringify(input.customFields));
    assignments.push(`custom_fields = custom_fields || $${values.length}::jsonb`);
  }

  values.push(input.actorId);
  assignments.push(`updated_by = $${values.length}`);
  assignments.push('updated_at = now()');
  assignments.push('version = version + 1');

  const updated = await queryOne<{ id: string }>(
    `UPDATE bookings
        SET ${assignments.join(', ')}
      WHERE id = $1 AND version = $2
      RETURNING id`,
    values,
    tx,
  );
  if (!updated) return undefined;

  return findById(updated.id, tx);
}

export async function cancel(
  input: { id: string; expectedVersion: number; actorId: string; reason: string | null },
  tx: Queryable,
): Promise<Booking | undefined> {
  const cancelled = await queryOne<{ id: string }>(
    `UPDATE bookings
        SET status = 'CANCELLED',
            cancelled_by = $3,
            cancelled_at = now(),
            cancellation_reason = $4,
            updated_by = $3,
            updated_at = now(),
            version = version + 1
      WHERE id = $1 AND version = $2 AND status = 'PLANNED' AND deleted_at IS NULL
      RETURNING id`,
    [input.id, input.expectedVersion, input.actorId, input.reason],
    tx,
  );
  if (!cancelled) return undefined;
  return findById(cancelled.id, tx);
}

/**
 * Removes a booking that should never have existed.
 *
 * A tombstone rather than a DELETE, and deliberately not a cancellation: the
 * two answer different questions. Cancelling says the committee is no longer
 * coming, and the booking stays on the plan struck through so nobody moves a
 * transformer for it. Deleting says the row was a mistake — a duplicate, the
 * wrong project — and it leaves the plan entirely.
 *
 * The row survives because "who removed this, and when" is a question the plan
 * has to be able to answer; only the reading of it stops.
 *
 * The status is left alone on purpose. A deleted booking is not a cancelled
 * one, and overwriting it would lose the distinction the moment anyone looked
 * at the history.
 */
export async function softDelete(
  input: { id: string; expectedVersion: number; actorId: string },
  tx: Queryable,
): Promise<Booking | undefined> {
  const deleted = await queryOne<{ id: string }>(
    `UPDATE bookings
        SET deleted_by = $3,
            deleted_at = now(),
            updated_by = $3,
            updated_at = now(),
            version = version + 1
      WHERE id = $1 AND version = $2 AND deleted_at IS NULL
      RETURNING id`,
    [input.id, input.expectedVersion, input.actorId],
    tx,
  );
  if (!deleted) return undefined;
  return findById(deleted.id, tx);
}

export async function currentVersion(
  id: string,
  executor?: Queryable,
): Promise<number | undefined> {
  const row = await queryOne<{ version: number }>(
    'SELECT version FROM bookings WHERE id = $1',
    [id],
    executor,
  );
  return row?.version;
}

/**
 * Active bookings that occupy the same exclusive slot.
 *
 * The exclusivity key is whatever the confirmed business rule says it is
 * (spec §46) — this query composes it from the parts the rule names.
 */
export async function findSlotOccupants(
  criteria: { bookingDate: string; bookingTime?: string; committee?: string | null },
  excludeBookingId: string | null,
  tx: Queryable,
): Promise<Array<{ id: string; offNo: string | null; bookingDate: string; bookingTime: string; committee: string | null }>> {
  // A cancelled or deleted booking occupies nothing.
  const conditions = ["b.status = 'PLANNED'", 'b.deleted_at IS NULL', 'b.booking_date = $1'];
  const values: unknown[] = [criteria.bookingDate];

  if (criteria.bookingTime !== undefined) {
    values.push(criteria.bookingTime);
    conditions.push(`b.booking_time = $${values.length}::time`);
  }
  if (criteria.committee !== undefined) {
    values.push(criteria.committee);
    // A NULL committee must collide with another NULL committee, so compare
    // with IS NOT DISTINCT FROM rather than `=`.
    conditions.push(`b.committee IS NOT DISTINCT FROM $${values.length}`);
  }
  if (excludeBookingId) {
    values.push(excludeBookingId);
    conditions.push(`b.id <> $${values.length}`);
  }

  const rows = await queryRows<{
    id: string;
    off_no: string | null;
    booking_date: string;
    booking_time: string;
    committee: string | null;
  }>(
    `SELECT b.id, b.off_no, b.booking_date, b.booking_time, b.committee
       FROM bookings b
      WHERE ${conditions.join(' AND ')}
      ORDER BY b.booking_time
      LIMIT 20`,
    values,
    tx,
  );

  return rows.map((row) => ({
    id: row.id,
    offNo: row.off_no,
    bookingDate: row.booking_date,
    bookingTime: normalizeTime(row.booking_time),
    committee: row.committee,
  }));
}

/**
 * The active bookings already inside a shared Committee Session.
 *
 * CONFIRMED business rule (spec §46, §78.1): Date + Time + Committee groups
 * bookings, it does not restrict them. This query exists so the booking form
 * can tell an engineer "this session already holds 2 projects" — information,
 * never a block.
 */
export async function findSessionBookings(
  criteria: { bookingDate: string; bookingTime: string; committee: string | null },
  executor?: Queryable,
): Promise<SessionPreview> {
  const rows = await queryRows<{
    id: string;
    off_no: string | null;
    order_name: string | null;
    customer_name: string | null;
    status: string | null;
    created_by_id: string;
    created_by_name: string;
    created_by_email: string;
  }>(
    `SELECT b.id,
            b.off_no,
            b.order_name,
            b.customer_name,
            b.status,
            u.id    AS created_by_id,
            u.name  AS created_by_name,
            u.email AS created_by_email
       FROM bookings b
       JOIN users u ON u.id = b.created_by
      WHERE b.status = 'PLANNED'
        AND b.deleted_at IS NULL
        AND b.booking_date = $1
        AND b.booking_time = $2::time
        AND b.committee IS NOT DISTINCT FROM $3
      ORDER BY b.created_at
      LIMIT 100`,
    [criteria.bookingDate, criteria.bookingTime, criteria.committee],
    executor,
  );

  return {
    bookingDate: criteria.bookingDate,
    bookingTime: criteria.bookingTime,
    committee: criteria.committee,
    count: rows.length,
    bookings: rows.map((row) => ({
      id: row.id,
      offNo: row.off_no,
      orderName: row.order_name,
      customerName: row.customer_name,
      status: row.status,
      createdBy: userRef(row.created_by_id, row.created_by_name, row.created_by_email),
    })),
  };
}
