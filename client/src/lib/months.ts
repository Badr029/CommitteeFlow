/**
 * Month navigation.
 *
 * A month key is `YYYY-MM`. All arithmetic is on the key itself, so navigating
 * never depends on the viewer's timezone.
 */

export function currentMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function todayKey(now = new Date()): string {
  return `${currentMonthKey(now)}-${String(now.getDate()).padStart(2, '0')}`;
}

export function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) return monthKey;
  const total = year * 12 + (month - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function isValidMonthKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** First day of a month, for prefilling the booking form's date. */
export function firstDayOf(monthKey: string): string {
  return `${monthKey}-01`;
}
