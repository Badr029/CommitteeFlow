import type { PlanFieldValue } from '@shared/api-types.js';
import { queryRows } from '../../db/index.js';

/**
 * Possible-duplicate detection (§24, §25).
 *
 * The thing this must never do is confuse a shared Committee Session with a
 * duplicate. Date + Time + Committee is a *grouping* — one committee sitting
 * once, reviewing several projects (§46, §78.1) — so four rows sharing that
 * triple is the normal case an import exists to load, not a problem.
 *
 * What makes two rows plausibly the same booking is the project identity on top
 * of the schedule: the same OFF number, on the same date, at the same time,
 * with the same committee. Even then it is only ever a *warning*, because the
 * plan legitimately contains one order across several technical lines (§17) —
 * repeated OFF numbers are expected, and deleting one would destroy real work.
 *
 * So: never blocked, never skipped automatically, always the user's call.
 */

export interface DuplicateMatch {
  /** Existing booking that looks like this row. */
  bookingId: string;
  offNo: string | null;
  bookingDate: string;
  bookingTime: string;
  committee: string | null;
  message: string;
}

interface CandidateRow {
  id: string;
  off_no: string | null;
  booking_date: Date | string;
  booking_time: string;
  committee: string | null;
  order_name: string | null;
  qty: number | null;
  kva: string | number | null;
  kv: string | number | null;
}

function toDateString(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
    value.getUTCDate(),
  ).padStart(2, '0')}`;
}

function text(value: PlanFieldValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const asString = String(value).trim();
  return asString === '' ? null : asString;
}

/**
 * A calendar date, or nothing.
 *
 * Rows that failed validation still reach this function — they are part of the
 * preview — and they carry whatever the spreadsheet said, which may be the
 * literal text `not a date`. Sending that to `ANY($1::date[])` makes PostgreSQL
 * reject the whole query, so a single bad cell would take down duplicate
 * detection for the entire sheet.
 */
function calendarDate(value: PlanFieldValue | undefined): string | null {
  const asString = text(value);
  if (asString === null) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(asString) ? asString : null;
}

/** Times reach the same query shape, so they get the same guard. */
function clockTime(value: PlanFieldValue | undefined): string | null {
  const asString = text(value);
  if (asString === null) return null;
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(asString) ? asString.slice(0, 5) : null;
}

/** Committee names vary in case and spacing between sheets; identity does not. */
function fold(value: string | null): string {
  return value === null ? '' : value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function numeric(value: PlanFieldValue | string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Finds existing bookings that plausibly already are the rows being imported.
 *
 * One query for the whole sheet: every candidate booking on any of the dates
 * involved is fetched once, then matched in memory. A per-row query would mean
 * one round trip per spreadsheet line.
 */
export async function findPossibleDuplicates(
  rows: readonly Record<string, PlanFieldValue>[],
): Promise<Map<number, DuplicateMatch>> {
  const matches = new Map<number, DuplicateMatch>();

  // Only rows carrying both a date and an OFF number can be judged at all.
  const dates = new Set<string>();
  for (const row of rows) {
    const date = calendarDate(row['booking_date']);
    const offNo = text(row['off_no']);
    if (date && offNo) dates.add(date);
  }
  if (dates.size === 0) return matches;

  const candidates = await queryRows<CandidateRow>(
    `SELECT id, off_no, booking_date, booking_time, committee, order_name, qty, kva, kv
       FROM bookings
      WHERE status = 'PLANNED'
        AND deleted_at IS NULL
        AND off_no IS NOT NULL
        AND booking_date = ANY($1::date[])`,
    [[...dates]],
  );
  if (candidates.length === 0) return matches;

  // Keyed on the schedule plus the project identity — deliberately not on the
  // session triple alone.
  const byKey = new Map<string, CandidateRow[]>();
  for (const candidate of candidates) {
    const key = [
      toDateString(candidate.booking_date),
      String(candidate.booking_time).slice(0, 5),
      fold(candidate.committee),
      fold(candidate.off_no),
    ].join('|');
    const bucket = byKey.get(key);
    if (bucket) bucket.push(candidate);
    else byKey.set(key, [candidate]);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;

    const date = calendarDate(row['booking_date']);
    const time = clockTime(row['booking_time']);
    const offNo = text(row['off_no']);
    if (!date || !time || !offNo) continue;

    const key = [date, time, fold(text(row['committee'])), fold(offNo)].join('|');
    const bucket = byKey.get(key);
    if (!bucket || bucket.length === 0) continue;

    // The schedule and the OFF number already agree. The technical line is what
    // separates "this row is already in the plan" from "this is the second
    // KVA line of the same order" (§17), so prefer a candidate that matches it.
    const rowQty = numeric(row['qty']);
    const rowKva = numeric(row['kva']);

    const exact = bucket.find(
      (candidate) => numeric(candidate.qty) === rowQty && numeric(candidate.kva) === rowKva,
    );

    const matched = exact ?? bucket[0];
    if (!matched) continue;

    const where = `${toDateString(matched.booking_date)} · ${String(matched.booking_time).slice(0, 5)}${
      matched.committee ? ` · ${matched.committee}` : ''
    }`;

    matches.set(index, {
      bookingId: matched.id,
      offNo: matched.off_no,
      bookingDate: toDateString(matched.booking_date),
      bookingTime: String(matched.booking_time).slice(0, 5),
      committee: matched.committee,
      message: exact
        ? `OFF ${offNo} is already in the plan at ${where} with the same quantity and KVA.`
        : `OFF ${offNo} is already in the plan at ${where}. This row may be a further technical line rather than a duplicate.`,
    });
  }

  return matches;
}
