/**
 * Calendar helpers.
 *
 * The Committee Plan is a calendar artefact. A booking on 2026-10-06 is on
 * 2026-10-06 for every user in every timezone, so dates are handled as plain
 * `YYYY-MM-DD` strings and never converted through `Date` arithmetic that could
 * shift them across a day boundary (spec §9).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export function isValidDateString(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

export function isValidTimeString(value: string): boolean {
  return ISO_TIME.test(value);
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Normalises `HH:MM`, `HH:MM:SS` or PostgreSQL's `HH:MM:SS` to `HH:MM`. */
export function normalizeTime(value: string): string {
  const match = ISO_TIME.exec(value.trim());
  if (!match) return value;
  return `${match[1]}:${match[2]}`;
}

/**
 * Weekday name for a plan date (spec §11).
 *
 * The date is the authoritative value; the day is always derived, never typed
 * by a user and never stored.
 */
export function displayDayFor(dateString: string): string {
  if (!isValidDateString(dateString)) return '';
  const [y, m, d] = dateString.split('-').map(Number) as [number, number, number];
  const index = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAYS[index] ?? '';
}

/** First day of the month containing `dateString`, as `YYYY-MM-DD`. */
export function startOfMonth(dateString: string): string {
  return `${dateString.slice(0, 7)}-01`;
}

/** Last day of the month containing `dateString`, as `YYYY-MM-DD`. */
export function endOfMonth(dateString: string): string {
  const [y, m] = dateString.split('-').map(Number) as [number, number];
  return `${dateString.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

/** Today in the server's local calendar, as `YYYY-MM-DD`. */
export function today(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Adds whole months to a date, clamping the day to the target month's length
 * (2026-01-31 + 1 month is 2026-02-28, not 2026-03-03).
 */
export function addMonths(dateString: string, months: number): string {
  const [y, m, d] = dateString.split('-').map(Number) as [number, number, number];
  const totalMonths = y * 12 + (m - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonth = (totalMonths % 12) + 1;
  const day = Math.min(d, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** String comparison is correct ordering for `YYYY-MM-DD`. */
export const isBefore = (a: string, b: string): boolean => a < b;
export const isAfter = (a: string, b: string): boolean => a > b;
