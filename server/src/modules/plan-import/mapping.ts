import type { PlanFieldRecord } from '../plan-config/plan-fields.repository.js';
import type { RawCell } from './parse.js';
import { textToDateString, textToTimeString } from './normalize.js';
import { isReadOnlyFieldKey } from '../plan-config/field-keys.js';

/**
 * Matching spreadsheet headers to Committee Plan fields.
 *
 * Plan Field labels are configurable (§35, §77): today's `Customer Name` may be
 * tomorrow's `Client Name`, while the stable key stays `customer_name`. So a
 * header is matched against three things — the stable key, the field's *current*
 * label, and the labels this product has historically shipped — and the answer
 * is the key, never the label.
 *
 * The second job here is knowing when *not* to answer. A confident wrong
 * mapping is worse than no mapping: it silently files data in the wrong column.
 * When the header matches a field whose type the column's own values contradict
 * — a `KV` column of `11/0.4` against a numeric field — the suggestion is
 * withheld and the user is told why (§12).
 */

export type MappingConfidence = 'exact' | 'likely' | 'uncertain';

export interface ColumnSuggestion {
  /** Header as it appears in the file. */
  header: string;
  /** Zero-based column position. */
  index: number;
  /** Suggested destination, or null when the user must choose. */
  suggestedFieldKey: string | null;
  confidence: MappingConfidence;
  /** Why the suggestion is what it is, shown beside the control. */
  reason: string | null;
  /** A few real values, so the user can see what they are mapping. */
  sampleValues: string[];
}

/**
 * Labels this product has used, and the ones a plan sheet is likely to carry.
 *
 * Aliases are for *recognition* only — the destination is always the stable
 * key, so renaming a field in Plan Configuration never breaks an import.
 */
const HISTORICAL_ALIASES: Record<string, readonly string[]> = {
  booking_date: ['date', 'booking date', 'plan date', 'day date', 'التاريخ'],
  booking_time: ['time', 'booking time', 'slot', 'slot time', 'hour', 'الوقت'],
  off_no: ['off no', 'off no.', 'off number', 'off', 'offer no', 'offer number', 'off_no'],
  order_name: ['order name', 'order', 'project', 'project name', 'description', 'اسم الطلب'],
  committee: ['committee', 'committee name', 'panel', 'اللجنة'],
  qty: ['qty', 'quantity', 'qnty', 'count', 'الكمية'],
  kva: ['kva', 'k.v.a', 'kva rating', 'rating'],
  /*
   * `status` is deliberately among these. Every Committee Plan sheet written
   * before this correction has a column headed Status holding transformer
   * serial numbers, because that is what the column was being used for — so a
   * sheet saying "Status" is far more likely to mean Serial No. than to mean a
   * lifecycle the application owns and nobody types.
   */
  serial_no: ['serial no', 'serial no.', 'serial', 'serial number', 'status', 'reference', 'ref', 'invoice'],
  kv: ['kv', 'k.v', 'voltage', 'kv rating'],
  status: ['status', 'state', 'progress', 'الحالة'],
  notes: ['notes', 'note', 'remarks', 'comment', 'comments', 'ملاحظات'],
  customer_name: ['customer name', 'customer', 'client', 'client name', 'العميل', 'اسم العميل'],
};

/**
 * Values a lifecycle Status column could legitimately hold.
 *
 * Used only to tell the two readings of a `Status` header apart: a column of
 * `Planned` and `Cancelled` really is the lifecycle and has nowhere to go,
 * while a column of `010662606B` is the serial numbers this product used to
 * import into the wrong field.
 */
const LIFECYCLE_WORDS = new Set(['planned', 'cancelled', 'canceled', 'active']);

function looksLikeLifecycle(samples: readonly RawCell[]): boolean {
  const words = samples
    .filter((cell): cell is Extract<RawCell, { kind: 'text' }> => cell.kind === 'text')
    .map((cell) => cell.text.trim().toLowerCase());
  if (words.length === 0) return false;
  return words.every((word) => LIFECYCLE_WORDS.has(word));
}

/**
 * Headers that should never be auto-mapped, even though they look meaningful.
 *
 * `Day` is derived from the date (§9), so importing it would create a second
 * source of truth for the same fact — and a sheet whose Day disagrees with its
 * Date would then be silently wrong in the plan.
 */
const DERIVED_HEADERS: Record<string, string> = {
  day: 'CommitteeFlow works the weekday out from the date, so this column is not needed.',
  weekday: 'CommitteeFlow works the weekday out from the date, so this column is not needed.',
  'day name': 'CommitteeFlow works the weekday out from the date, so this column is not needed.',
  '#': 'This looks like a row number rather than plan data.',
  no: 'This looks like a row number rather than plan data.',
  'sr no': 'This looks like a row number rather than plan data.',
  /*
   * `serial no` used to be listed here as a row counter, which was right when
   * the plan had no field of that name. It has one now — the transformer serial
   * — so a column headed Serial No. means the field, and a running number is
   * still caught by `#`, `No` and `Sr No`.
   */
};

/** Case, punctuation and spacing all vary between sheets; none of it is meaning. */
function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function suggestMapping(
  headers: readonly string[],
  rows: readonly RawCell[][],
  fields: readonly PlanFieldRecord[],
): ColumnSuggestion[] {
  /*
   * Fields the application writes are not destinations for a spreadsheet
   * column. Status is set by cancelling and Project Engineer by signing in, so
   * offering either as a target would only produce rows that fail validation.
   */
  const mappable = fields.filter((field) => field.isActive && !isReadOnlyFieldKey(field.fieldKey));

  // Built once: stable key, current label, and historical aliases all point at
  // the same field.
  const byNormalized = new Map<string, PlanFieldRecord>();
  const register = (token: string, field: PlanFieldRecord) => {
    const key = normalizeHeader(token);
    if (key !== '' && !byNormalized.has(key)) byNormalized.set(key, field);
  };

  for (const field of mappable) {
    register(field.fieldKey, field);
    register(field.label, field);
    for (const alias of HISTORICAL_ALIASES[field.fieldKey] ?? []) register(alias, field);
  }

  const claimed = new Set<string>();
  const suggestions: ColumnSuggestion[] = [];

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index] ?? '';
    const normalized = normalizeHeader(header);
    const samples = sampleColumn(rows, index);

    const derived = DERIVED_HEADERS[normalized];
    if (derived) {
      suggestions.push({
        header,
        index,
        suggestedFieldKey: null,
        confidence: 'uncertain',
        reason: derived,
        sampleValues: samples.display,
      });
      continue;
    }

    const match = byNormalized.get(normalized);

    if (!match) {
      suggestions.push({
        header,
        index,
        suggestedFieldKey: null,
        confidence: 'uncertain',
        reason: 'No Committee Plan field matches this column. Choose one, or ignore the column.',
        sampleValues: samples.display,
      });
      continue;
    }

    // Two headers matching the same field cannot both win; the second becomes
    // a decision for the user rather than a silent overwrite.
    if (claimed.has(match.fieldKey)) {
      suggestions.push({
        header,
        index,
        suggestedFieldKey: null,
        confidence: 'uncertain',
        reason: `Another column is already mapped to ${match.label}. Choose a different field, or ignore this one.`,
        sampleValues: samples.display,
      });
      continue;
    }

    // The header says one thing; the values may say another.
    const fit = assessTypeFit(match, samples.cells);
    if (!fit.compatible) {
      suggestions.push({
        header,
        index,
        suggestedFieldKey: null,
        confidence: 'uncertain',
        reason: fit.reason,
        sampleValues: samples.display,
      });
      continue;
    }

    /*
     * A `Status` column that really does hold statuses has nowhere to go — the
     * lifecycle is the application's and cannot be imported — so say that
     * rather than filing the words under Serial No.
     */
    if (normalized === 'status' && match.fieldKey === 'serial_no' && looksLikeLifecycle(samples.cells)) {
      suggestions.push({
        header,
        index,
        suggestedFieldKey: null,
        confidence: 'uncertain',
        reason:
          'This column holds booking statuses, which CommitteeFlow sets itself — every imported booking starts as Planned. Leave it out, or choose a field for it.',
        sampleValues: samples.display,
      });
      continue;
    }

    claimed.add(match.fieldKey);
    suggestions.push({
      header,
      index,
      suggestedFieldKey: match.fieldKey,
      confidence: normalizeHeader(match.label) === normalized ? 'exact' : 'likely',
      reason:
        normalizeHeader(match.label) === normalized
          ? null
          : normalized === 'status' && match.fieldKey === 'serial_no'
            ? 'A Status column in a Committee Plan sheet holds transformer serial numbers, so it is mapped to Serial No. Every imported booking starts as Planned.'
            : `Matched to ${match.label} by its standard name.`,
      sampleValues: samples.display,
    });
  }

  return suggestions;
}

interface ColumnSamples {
  cells: RawCell[];
  display: string[];
}

function sampleColumn(rows: readonly RawCell[][], index: number): ColumnSamples {
  const cells: RawCell[] = [];
  const display: string[] = [];

  for (const row of rows) {
    const cell = row[index];
    if (!cell || cell.kind === 'empty') continue;
    cells.push(cell);
    if (display.length < 3) display.push(describeCell(cell));
    // Twenty non-empty values is plenty to judge a column's shape.
    if (cells.length >= 20) break;
  }

  return { cells, display };
}

function describeCell(cell: RawCell): string {
  switch (cell.kind) {
    case 'text':
      return cell.text.length > 40 ? `${cell.text.slice(0, 40)}…` : cell.text;
    case 'number':
      return cell.formatted ?? String(cell.value);
    case 'serial':
      return cell.formatted ?? String(cell.serial);
    case 'boolean':
      return cell.value ? 'Yes' : 'No';
    case 'empty':
      return '';
    default: {
      const never: never = cell;
      throw new Error(`unhandled cell kind: ${String(never)}`);
    }
  }
}

interface TypeFit {
  compatible: boolean;
  reason: string | null;
}

/**
 * Fewest values before the column's contents may override its header.
 *
 * With one or two samples a single bad cell is 50% of the evidence, which says
 * nothing about the column. Below this the header is trusted and bad cells
 * become row-level errors, which is where they belong.
 */
const MIN_SAMPLES_TO_VETO = 3;

/**
 * Does this column's data actually fit the field its header names?
 *
 * Deliberately hard to trigger. Un-mapping a column turns one bad cell into a
 * required-field error on *every* row, so the bar is that the majority of the
 * column contradicts the field — a `KV` column entirely of `11/0.4` ratios, not
 * a Date column with one typo in it. A few bad cells stay what they are:
 * errors on their own rows, which the user can see and fix in the source.
 */
function assessTypeFit(field: PlanFieldRecord, samples: readonly RawCell[]): TypeFit {
  if (samples.length < MIN_SAMPLES_TO_VETO) return { compatible: true, reason: null };

  const fits = samples.filter((cell) => cellFitsType(cell, field)).length;
  const ratio = fits / samples.length;
  if (ratio >= 0.5) return { compatible: true, reason: null };

  const example = samples.find((cell) => !cellFitsType(cell, field));
  const shown = example ? `“${describeCell(example)}”` : 'the values';

  switch (field.fieldType) {
    case 'NUMBER':
      return {
        compatible: false,
        reason: `${field.label} stores a number, but this column holds values like ${shown}. Map it to a text field, or ignore it.`,
      };
    case 'DATE':
      return {
        compatible: false,
        reason: `${field.label} stores a date, but this column holds values like ${shown}. Check the column, or choose a different field.`,
      };
    case 'TIME':
      return {
        compatible: false,
        reason: `${field.label} stores a time, but this column holds values like ${shown}. Check the column, or choose a different field.`,
      };
    case 'SELECT':
      return {
        compatible: false,
        reason: `${field.label} only accepts ${field.options.join(', ')}, and this column holds values like ${shown}.`,
      };
    default:
      return {
        compatible: false,
        reason: `This column does not look like ${field.label}. Confirm the destination, or ignore it.`,
      };
  }
}

function cellFitsType(cell: RawCell, field: PlanFieldRecord): boolean {
  switch (field.fieldType) {
    case 'NUMBER': {
      if (cell.kind === 'number' || cell.kind === 'serial') return true;
      if (cell.kind === 'text') {
        const cleaned = cell.text.replace(/[,\s ]/g, '');
        return cleaned !== '' && Number.isFinite(Number(cleaned));
      }
      return false;
    }
    case 'DATE': {
      if (cell.kind === 'serial') return cell.isDateFormat;
      if (cell.kind === 'number') return cell.value > 1000;
      if (cell.kind === 'text') return textToDateString(cell.text) !== null;
      return false;
    }
    case 'TIME': {
      if (cell.kind === 'serial') return !cell.isDateFormat || cell.serial % 1 !== 0;
      if (cell.kind === 'number') return cell.value >= 0 && cell.value < 1;
      if (cell.kind === 'text') return textToTimeString(cell.text) !== null;
      return false;
    }
    case 'SELECT': {
      const text = cell.kind === 'text' ? cell.text.trim() : describeCell(cell);
      return field.options.includes(text);
    }
    case 'CHECKBOX': {
      if (cell.kind === 'boolean') return true;
      if (cell.kind === 'number') return cell.value === 0 || cell.value === 1;
      if (cell.kind === 'text') {
        return ['true', 'false', 'yes', 'no', '1', '0', 'on', 'off'].includes(
          cell.text.trim().toLowerCase(),
        );
      }
      return false;
    }
    case 'TEXT':
    case 'LONG_TEXT':
    default:
      // Anything can be read as text.
      return true;
  }
}
