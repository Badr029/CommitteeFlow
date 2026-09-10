import type {
  ActivityEntry,
  BookingFieldChange,
  BookingHistoryAction,
  BookingHistoryEntry,
  BookingStatus,
  PlanFieldValue,
  UserRef,
} from '@shared/api-types.js';
import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';

/**
 * Booking audit trail (spec §13).
 *
 * Every entry is written inside the same transaction as the change it records
 * (spec §72), so history can never disagree with the booking it describes.
 * Nothing in the API updates or deletes these rows (spec §67).
 */

export interface RecordHistoryInput {
  bookingId: string;
  action: BookingHistoryAction;
  actorId: string;
  oldValues: Record<string, PlanFieldValue> | null;
  newValues: Record<string, PlanFieldValue> | null;
  changedKeys: string[];
  bookingVersion: number;
}

export async function recordBookingHistory(
  input: RecordHistoryInput,
  executor?: Queryable,
): Promise<void> {
  await queryOne(
    `INSERT INTO booking_history
       (booking_id, action, actor_id, old_values, new_values, changed_keys, booking_version)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::text[], $7)`,
    [
      input.bookingId,
      input.action,
      input.actorId,
      input.oldValues === null ? null : JSON.stringify(input.oldValues),
      input.newValues === null ? null : JSON.stringify(input.newValues),
      input.changedKeys,
      input.bookingVersion,
    ],
    executor,
  );
}

interface HistoryRow {
  id: number;
  booking_id: string;
  action: BookingHistoryAction;
  old_values: Record<string, PlanFieldValue> | null;
  new_values: Record<string, PlanFieldValue> | null;
  changed_keys: string[];
  booking_version: number;
  created_at: Date;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
}

const HISTORY_SELECT = `
  SELECT bh.id,
         bh.booking_id,
         bh.action,
         bh.old_values,
         bh.new_values,
         bh.changed_keys,
         bh.booking_version,
         bh.created_at,
         u.id    AS actor_id,
         u.name  AS actor_name,
         u.email AS actor_email
    FROM booking_history bh
    LEFT JOIN users u ON u.id = bh.actor_id
`;

function toActor(row: HistoryRow): UserRef | null {
  return row.actor_id && row.actor_name && row.actor_email
    ? { id: row.actor_id, name: row.actor_name, email: row.actor_email }
    : null;
}

/**
 * Renders an entry's raw before/after snapshots into labelled changes.
 *
 * Labels are resolved at read time from the *current* plan configuration, so a
 * renamed field reads correctly in old history rather than showing a stale
 * caption (spec §20). A field archived since the change still resolves, because
 * the caller passes archived definitions too.
 */
function toChanges(row: HistoryRow, labels: ReadonlyMap<string, string>): BookingFieldChange[] {
  const keys =
    row.changed_keys.length > 0
      ? row.changed_keys
      : Object.keys(row.new_values ?? row.old_values ?? {});

  return keys.map((fieldKey) => ({
    fieldKey,
    label: labels.get(fieldKey) ?? fieldKey,
    from: row.old_values?.[fieldKey] ?? null,
    to: row.new_values?.[fieldKey] ?? null,
  }));
}

export async function listForBooking(
  bookingId: string,
  labels: ReadonlyMap<string, string>,
  executor?: Queryable,
): Promise<BookingHistoryEntry[]> {
  const rows = await queryRows<HistoryRow>(
    `${HISTORY_SELECT} WHERE bh.booking_id = $1 ORDER BY bh.id DESC`,
    [bookingId],
    executor,
  );

  return rows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    action: row.action,
    actor: toActor(row),
    bookingVersion: row.booking_version,
    changes: toChanges(row, labels),
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * The Activity feed (spec §14).
 *
 * Paginated by design — the feed must never load every audit row ever written
 * (spec §56). One extra row is fetched to determine `hasMore` without a second
 * COUNT query over a table that only grows.
 */
export async function listActivity(
  options: { limit: number; offset: number; bookingId?: string; actorId?: string },
  labels: ReadonlyMap<string, string>,
  executor?: Queryable,
): Promise<{ entries: ActivityEntry[]; hasMore: boolean }> {
  const filters: string[] = [];
  const values: unknown[] = [];

  if (options.bookingId) {
    values.push(options.bookingId);
    filters.push(`bh.booking_id = $${values.length}`);
  }
  if (options.actorId) {
    values.push(options.actorId);
    filters.push(`bh.actor_id = $${values.length}`);
  }

  values.push(options.limit + 1, options.offset);
  const limitPlaceholder = `$${values.length - 1}`;
  const offsetPlaceholder = `$${values.length}`;

  const rows = await queryRows<
    HistoryRow & {
      b_id: string | null;
      b_off_no: string | null;
      b_order_name: string | null;
      b_committee: string | null;
      b_booking_date: string | null;
      b_status: BookingStatus | null;
      b_deleted_at: Date | null;
    }
  >(
    `SELECT bh.id,
            bh.booking_id,
            bh.action,
            bh.old_values,
            bh.new_values,
            bh.changed_keys,
            bh.booking_version,
            bh.created_at,
            u.id    AS actor_id,
            u.name  AS actor_name,
            u.email AS actor_email,
            b.id            AS b_id,
            b.off_no        AS b_off_no,
            b.order_name    AS b_order_name,
            b.committee     AS b_committee,
            b.booking_date  AS b_booking_date,
            b.status AS b_status,
            b.deleted_at AS b_deleted_at
       FROM booking_history bh
       LEFT JOIN users u    ON u.id = bh.actor_id
       LEFT JOIN bookings b ON b.id = bh.booking_id
      ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY bh.created_at DESC, bh.id DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
    values,
    executor,
  );

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;

  return {
    hasMore,
    entries: page.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      action: row.action,
      actor: toActor(row),
      bookingVersion: row.booking_version,
      changes: toChanges(row, labels),
      createdAt: row.created_at.toISOString(),
      booking:
        row.b_id && row.b_booking_date && row.b_status
          ? {
              id: row.b_id,
              offNo: row.b_off_no,
              orderName: row.b_order_name,
              committee: row.b_committee,
              bookingDate: row.b_booking_date,
              status: row.b_status,
              deleted: row.b_deleted_at !== null,
            }
          : null,
    })),
  };
}
