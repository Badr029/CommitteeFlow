import type { Booking, PlanField, PlanFieldValue } from '@shared/api-types';

/**
 * Display formatting.
 *
 * Dates arrive as plain `YYYY-MM-DD` strings and are formatted without ever
 * constructing a local `Date` from them — that is what shifts a plan date
 * across a day boundary (spec §9).
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parts(isoDate: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function weekdayOf(isoDate: string): string {
  const p = parts(isoDate);
  if (!p) return '';
  return WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()] ?? '';
}

/** "09 September" — the day heading on the plan. */
export function formatDayHeading(isoDate: string): string {
  const p = parts(isoDate);
  if (!p) return isoDate;
  return `${String(p.day).padStart(2, '0')} ${MONTHS[p.month - 1]}`;
}

/**
 * "THURSDAY · 10 SEP" — the agenda's day heading.
 *
 * The weekday leads because a plan is read as "what is coming on Thursday", and
 * on a narrow screen it is also the part that survives without the year.
 */
export function formatDayHeadingShort(isoDate: string): string {
  const p = parts(isoDate);
  if (!p) return isoDate;
  const weekday = weekdayOf(isoDate);
  return `${weekday} · ${String(p.day).padStart(2, '0')} ${MONTHS_SHORT[p.month - 1]}`;
}

/** "09 Sep 2026" — compact, for detail panels and history. */
export function formatDateCompact(isoDate: string): string {
  const p = parts(isoDate);
  if (!p) return isoDate;
  return `${String(p.day).padStart(2, '0')} ${MONTHS_SHORT[p.month - 1]} ${p.year}`;
}

/** "September 2026" — the month navigator. */
export function formatMonth(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return monthKey;
  return `${MONTHS[month - 1]} ${year}`;
}

/** "Sep 2026" — the previous/next month steppers. */
export function formatMonthShort(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return monthKey;
  return `${MONTHS_SHORT[month - 1]} ${year}`;
}

/** Timestamps are real instants, so these do use the viewer's timezone. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "3 minutes ago" — used beside an absolute time, never instead of one. */
export function formatRelative(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return 'just now';
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(-Math.round(seconds / size), unit);
    }
  }
  return 'just now';
}

/** Numbers in the plan are engineering quantities: grouped, never rounded away. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

/** Reads a plan-field value off a booking, whether it is a column or JSONB. */
export function bookingValue(booking: Booking, fieldKey: string): PlanFieldValue {
  switch (fieldKey) {
    case 'booking_date':
      return booking.bookingDate;
    case 'booking_time':
      return booking.bookingTime;
    case 'off_no':
      return booking.offNo;
    case 'order_name':
      return booking.orderName;
    case 'committee':
      return booking.committee;
    case 'qty':
      return booking.qty;
    case 'kva':
      return booking.kva;
    case 'kv':
      return booking.kv;
    case 'status':
      return booking.status;
    case 'serial_no':
      return booking.serialNo;
    case 'project_engineer':
      // The engineer's name; the id means nothing to a reader.
      return booking.projectEngineer?.name ?? null;
    case 'notes':
      return booking.notes;
    case 'customer_name':
      return booking.customerName;
    default:
      return booking.customFields[fieldKey] ?? null;
  }
}

/** The em dash marks a genuinely empty value, distinct from a zero. */
export const EMPTY = '—';

export function displayValue(field: PlanField, value: PlanFieldValue): string {
  if (value === null || value === undefined || value === '') return EMPTY;
  switch (field.fieldType) {
    case 'CHECKBOX':
      return value ? 'Yes' : 'No';
    case 'NUMBER':
      return typeof value === 'number' ? formatNumber(value) : String(value);
    case 'DATE':
      return formatDateCompact(String(value));
    default:
      return String(value);
  }
}

/** Numeric and time columns are right-aligned so digits stack. */
export function isNumericField(field: PlanField): boolean {
  return field.fieldType === 'NUMBER';
}
