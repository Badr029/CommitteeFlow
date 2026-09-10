import type { Booking, PlanField } from '@shared/api-types';

/**
 * Grouping the plan into days and shared committee sessions.
 *
 * CONFIRMED business rule (spec §46, §78.1): Date + Time + Committee is a
 * *session* — one committee sitting once, reviewing several projects — not a
 * uniqueness key. The API returns a flat, ordered list; this is where that list
 * becomes the structure the plan is read in.
 */

export interface CommitteeSession {
  /** Stable identity for React keys and for the "add to this session" action. */
  key: string;
  bookingDate: string;
  bookingTime: string;
  committee: string | null;
  bookings: Booking[];
}

export interface PlanDay {
  date: string;
  weekday: string;
  sessions: CommitteeSession[];
  bookingCount: number;
}

export function sessionKey(date: string, time: string, committee: string | null): string {
  return `${date}|${time}|${committee ?? ''}`;
}

/**
 * Builds days and sessions from the ordered booking list.
 *
 * Relies on the API's ordering (date, then time) rather than re-sorting, so the
 * plan on screen always matches the plan in the export.
 */
export function groupIntoDays(bookings: readonly Booking[]): PlanDay[] {
  const days: PlanDay[] = [];
  let currentDay: PlanDay | undefined;
  let currentSession: CommitteeSession | undefined;

  for (const booking of bookings) {
    if (!currentDay || currentDay.date !== booking.bookingDate) {
      currentDay = {
        date: booking.bookingDate,
        weekday: booking.displayDay,
        sessions: [],
        bookingCount: 0,
      };
      days.push(currentDay);
      currentSession = undefined;
    }

    const key = sessionKey(booking.bookingDate, booking.bookingTime, booking.committee);
    if (!currentSession || currentSession.key !== key) {
      currentSession = {
        key,
        bookingDate: booking.bookingDate,
        bookingTime: booking.bookingTime,
        committee: booking.committee,
        bookings: [],
      };
      currentDay.sessions.push(currentSession);
    }

    currentSession.bookings.push(booking);
    currentDay.bookingCount += 1;
  }

  return days;
}

/**
 * The columns the plan table shows.
 *
 * Date, Time and Committee are deliberately excluded: they identify the day and
 * the session, so repeating them on every row would be noise. Everything else
 * comes from Plan Configuration, in its configured order (spec §35, §77).
 */
export const GROUPED_KEYS = new Set(['booking_date', 'booking_time', 'committee']);

/**
 * Narrows the plan to one day of the month.
 *
 * Applied after grouping rather than as a query parameter: the month is already
 * loaded, so this is a way of *reading* what is on screen, and it stays instant.
 * An empty result is a real answer — that day has nothing booked — and the page
 * says so rather than falling back to the whole month.
 */
export function filterToDay(days: readonly PlanDay[], isoDate: string | null): PlanDay[] {
  if (!isoDate) return days as PlanDay[];
  return days.filter((day) => day.date === isoDate);
}

export function tableColumns(fields: readonly PlanField[]): PlanField[] {
  return fields
    .filter((field) => field.isActive && field.isVisible && !GROUPED_KEYS.has(field.fieldKey))
    .sort((a, b) => a.displayOrder - b.displayOrder);
}

/**
 * CSS grid template for the plan table.
 *
 * Numbers get a fixed, narrow track so digits stack; text fields share the
 * remaining width in proportion to how much they usually carry.
 */
export function gridTemplate(columns: readonly PlanField[]): string {
  const tracks = columns.map((field) => {
    if (field.fieldType === 'NUMBER') return '72px';
    if (field.fieldType === 'CHECKBOX') return '68px';
    if (field.fieldType === 'DATE' || field.fieldType === 'TIME') return '104px';
    if (field.fieldKey === 'off_no') return '104px';
    // Text, but never long: "11/0.4" is a voltage, not a sentence.
    if (field.fieldKey === 'kv') return '88px';
    if (field.fieldKey === 'status') return '112px';
    if (field.fieldKey === 'notes') return 'minmax(150px, 1.4fr)';
    if (field.fieldKey === 'order_name') return 'minmax(170px, 1.6fr)';
    if (field.fieldKey === 'customer_name') return 'minmax(150px, 1.3fr)';
    return 'minmax(130px, 1fr)';
  });
  return tracks.join(' ');
}
