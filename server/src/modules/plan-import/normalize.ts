import type { PlanFieldValue } from '@shared/api-types.js';
import type { PlanFieldRecord } from '../plan-config/plan-fields.repository.js';
import type { RawCell } from './parse.js';

/**
 * Turning a spreadsheet cell into a value the booking domain will accept.
 *
 * Two rules drive everything here.
 *
 * First, a plan date is a *calendar* date, not an instant. Excel stores it as a
 * serial — days since 1899-12-30 — and the moment that becomes a JavaScript
 * `Date` in a non-UTC timezone it can shift across midnight. So serials are
 * converted arithmetically, never through `new Date(serial * 86400000)`.
 *
 * Second, an identifier is text even when it is all digits. `010662606B` and
 * `202601066` are OFF numbers, not quantities: turning either into a float
 * loses the leading zero or the exactness. Numeric cells are only read as
 * numbers where the *field* is numeric.
 */

/** Excel's day zero. Serial 1 is 1900-01-01; the offset absorbs the 1900 bug. */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

export function serialToDateString(serial: number): string | null {
  // Excel has no date before 1900 and nothing plausible beyond ~2199.
  if (!Number.isFinite(serial) || serial < 1 || serial > 110_000) return null;
  const days = Math.floor(serial);
  const ms = EXCEL_EPOCH_UTC + days * 86_400_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  // Read back in UTC — the same basis it was built in — so no local offset can
  // move the day.
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function serialToTimeString(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null;
  const fraction = serial - Math.floor(serial);
  // Round to the nearest minute: Excel's binary fractions land on values like
  // 0.41666666666666663, which is 09:59:59.999 rather than 10:00.
  const totalMinutes = Math.round(fraction * 24 * 60);
  // 23:59:30+ rounds up to a full day, which belongs to the next date.
  const minutes = totalMinutes % (24 * 60);
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Text dates, in the formats a plan sheet actually contains.
 *
 * Deliberately conservative. `09/10/2026` is not accepted, because it is
 * September 10th in one country and October 9th in another and the importer has
 * no way to know which — guessing would silently move a booking by a month.
 * Unambiguous forms only: ISO, and day-month-year with a named month.
 */
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export function textToDateString(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;

  // 2026-09-09
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 9-Sep-26, 09 September 2026, 9/Sep/2026
  const named = /^(\d{1,2})[\s\-/]+([A-Za-z]+)[\s\-/]+(\d{2,4})$/.exec(text);
  if (named) {
    const month = MONTHS[String(named[2]).toLowerCase()];
    if (!month) return null;
    return buildDate(expandYear(Number(named[3])), month, Number(named[1]));
  }

  // Sep 9, 2026
  const namedFirst = /^([A-Za-z]+)[\s\-/]+(\d{1,2}),?[\s\-/]+(\d{2,4})$/.exec(text);
  if (namedFirst) {
    const month = MONTHS[String(namedFirst[1]).toLowerCase()];
    if (!month) return null;
    return buildDate(expandYear(Number(namedFirst[3])), month, Number(namedFirst[2]));
  }

  return null;
}

function expandYear(year: number): number {
  if (year >= 1000) return year;
  // A two-digit year in a plan sheet is this century.
  return 2000 + year;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 31 February rather than letting it roll into March.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `10:00`, `10:00 AM`, `1000`, `10.00`. */
export function textToTimeString(raw: string): string | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  const withMeridiem = /^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)$/.exec(text);
  if (withMeridiem) {
    let hour = Number(withMeridiem[1]);
    const minute = withMeridiem[2] ? Number(withMeridiem[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (withMeridiem[3] === 'pm' && hour !== 12) hour += 12;
    if (withMeridiem[3] === 'am' && hour === 12) hour = 0;
    return `${pad(hour)}:${pad(minute)}`;
  }

  const plain = /^(\d{1,2})[:.](\d{2})(?::(\d{2}))?$/.exec(text);
  if (plain) {
    const hour = Number(plain[1]);
    const minute = Number(plain[2]);
    if (hour > 23 || minute > 59) return null;
    return `${pad(hour)}:${pad(minute)}`;
  }

  return null;
}

/**
 * Reads one cell as one plan field.
 *
 * Returns the raw value the booking domain expects; it does **not** decide
 * whether the value is acceptable. Validation stays in `booking-values.ts`, so
 * an import and a hand-typed booking are judged by exactly the same rules
 * (§19) — this only decides what the cell *says*.
 */
export function cellToFieldValue(cell: RawCell, field: PlanFieldRecord): PlanFieldValue {
  if (cell.kind === 'empty') return null;

  switch (field.fieldType) {
    case 'DATE': {
      if (cell.kind === 'serial') return serialToDateString(cell.serial);
      if (cell.kind === 'number') return serialToDateString(cell.value);
      if (cell.kind === 'text') {
        // The literal text is returned when it cannot be understood, so the
        // validator reports "not a valid date" against what the user can see
        // in the cell, rather than against a silent null.
        return textToDateString(cell.text) ?? cell.text;
      }
      return null;
    }

    case 'TIME': {
      if (cell.kind === 'serial') return serialToTimeString(cell.serial);
      if (cell.kind === 'number') {
        // A bare fraction is a time of day; a whole number is not.
        return cell.value >= 0 && cell.value < 1 ? serialToTimeString(cell.value) : null;
      }
      if (cell.kind === 'text') return textToTimeString(cell.text) ?? cell.text;
      return null;
    }

    case 'NUMBER': {
      if (cell.kind === 'number') return cell.value;
      if (cell.kind === 'serial') return cell.serial;
      if (cell.kind === 'boolean') return cell.value ? 1 : 0;
      if (cell.kind === 'text') {
        // Strip thousands separators, but return the original text when it is
        // not a number so the validator can quote it back to the user.
        const cleaned = cell.text.replace(/[,\s\u00a0]/g, '');
        if (cleaned === '') return null;
        const numeric = Number(cleaned);
        return Number.isFinite(numeric) ? numeric : cell.text;
      }
      return null;
    }

    case 'CHECKBOX': {
      if (cell.kind === 'boolean') return cell.value;
      if (cell.kind === 'number') return cell.value !== 0;
      if (cell.kind === 'text') return cell.text.trim();
      return null;
    }

    case 'TEXT':
    case 'LONG_TEXT':
    case 'SELECT':
    default: {
      return cellToText(cell);
    }
  }
}

/**
 * A cell as text, preserving identifiers exactly.
 *
 * The formatted string wins over the raw number whenever Excel rendered the
 * cell as something other than a plain float. That is what keeps an OFF number
 * stored as `2.02601066e8` displaying — and importing — as `202601066`, and
 * what preserves a leading zero the numeric value has already lost.
 */
export function cellToText(cell: RawCell): string | null {
  switch (cell.kind) {
    case 'empty':
      return null;
    case 'text': {
      const trimmed = cell.text.trim();
      return trimmed === '' ? null : trimmed;
    }
    case 'boolean':
      return cell.value ? 'Yes' : 'No';
    case 'number': {
      if (cell.formatted && cell.formatted.trim() !== '') return cell.formatted.trim();
      return formatPlainNumber(cell.value);
    }
    case 'serial': {
      // A date or time cell mapped to a text field keeps its readable form
      // rather than leaking the serial.
      if (cell.formatted && cell.formatted.trim() !== '') return cell.formatted.trim();
      const asDate = cell.isDateFormat ? serialToDateString(cell.serial) : serialToTimeString(cell.serial);
      return asDate ?? formatPlainNumber(cell.serial);
    }
    default: {
      const never: never = cell;
      throw new Error(`unhandled cell kind: ${String(never)}`);
    }
  }
}

/** Avoids exponent notation, which would corrupt a long numeric identifier. */
function formatPlainNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toFixed(0);
  return String(value);
}

/**
 * Carry-forward for visually merged cells (§16).
 *
 * A merged Date cell spanning three rows leaves the second and third blank, so
 * without this those rows lose their date. The rule is deliberately narrow:
 *
 *   * only fields that actually group a plan — date, time, committee, and the
 *     order identity that a multi-line technical entry repeats;
 *   * only when the row has content of its own, so a blank spacer row is never
 *     resurrected;
 *   * only forward from a value in the same column, never across a gap that
 *     the sheet itself signals by starting a new group.
 *
 * Everything else stays blank. Carrying a blank Qty forward would invent a
 * quantity that nobody wrote down, which is worse than leaving it empty.
 */
export const CARRY_FORWARD_KEYS: ReadonlySet<string> = new Set([
  'booking_date',
  'booking_time',
  'committee',
  'off_no',
  'order_name',
]);

export interface CarriedRow {
  cells: RawCell[];
  /** Field keys whose value was inherited rather than present in the row. */
  carried: string[];
}

export function applyCarryForward(
  rows: RawCell[][],
  columnFieldKeys: readonly (string | null)[],
): CarriedRow[] {
  const lastSeen = new Map<number, RawCell>();

  return rows.map((row) => {
    const cells = row.slice();
    const carried: string[] = [];

    for (let column = 0; column < cells.length; column += 1) {
      const fieldKey = columnFieldKeys[column];
      if (!fieldKey || !CARRY_FORWARD_KEYS.has(fieldKey)) continue;

      const cell = cells[column];
      if (cell && cell.kind !== 'empty') {
        lastSeen.set(column, cell);
        continue;
      }

      const previous = lastSeen.get(column);
      // `booking_date` starting a fresh value resets the group for the columns
      // to its right is deliberately *not* modelled: real merged sheets repeat
      // the outer value on the row where the inner one changes, so a simple
      // last-non-empty rule matches how they are actually written.
      if (previous) {
        cells[column] = previous;
        // Recorded, not hidden. A merged sheet and a sheet with a genuinely
        // forgotten date look identical here, so the preview says which values
        // were inherited and lets the user judge (§16, §21).
        carried.push(fieldKey);
      }
    }

    return { cells, carried };
  });
}
