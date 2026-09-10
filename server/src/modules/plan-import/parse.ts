import * as XLSX from 'xlsx';
import { badRequest } from '../../lib/errors.js';
import {
  MAX_COLUMNS,
  MAX_DATA_ROWS,
  type CheckedUpload,
  type ImportFileType,
} from './file-guard.js';

/**
 * Turning an uploaded workbook into a grid of cells.
 *
 * Excel and CSV converge here (§13): both come out as the same `SheetGrid`, so
 * every step after this one — mapping, normalisation, validation, preview —
 * has a single code path and cannot drift between the two formats.
 *
 * SheetJS is asked for *raw* values, never `cellDates`. That matters: with
 * `cellDates` the library builds a local-time `Date`, and a plan date one hour
 * east of UTC serialises back a day early — the exact class of bug the rest of
 * this codebase avoids by never constructing a local Date from a plan date.
 * Instead the numeric serial survives to `normalize.ts`, which reads it with
 * calendar semantics.
 */

/** One cell, as it came out of the file. */
export type RawCell =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'number'; value: number; formatted: string | null }
  /** An Excel date/time serial, with the format code so we know which it is. */
  | { kind: 'serial'; serial: number; formatted: string | null; isDateFormat: boolean }
  | { kind: 'boolean'; value: boolean };

export interface SheetGrid {
  sheetName: string;
  /** Every sheet in the workbook, so the UI can offer a different one. */
  availableSheets: string[];
  /** Trimmed header labels, in file order. Blank headers become `Column 4`. */
  headers: string[];
  /** Data rows, aligned to `headers`. */
  rows: RawCell[][];
  /** 1-based row number in the source file, for "Row 14" in the preview. */
  sourceRowNumbers: number[];
  /** True when the row cap trimmed the sheet. */
  truncated: boolean;
}

/**
 * Cell formats that mean "date" rather than "time".
 *
 * Excel stores both as one number: the integer part is days since 1899-12-30,
 * the fraction is time of day. Only the number format distinguishes
 * `2026-09-09` from `10:00`, so the format code is the thing to read.
 */
function isDateLikeFormat(code: string | undefined): boolean {
  if (!code) return false;
  const lower = code.toLowerCase();
  // `m` is ambiguous in Excel format codes (month or minute); `y` and `d` are
  // not, so a code carrying either is a date.
  return /[yd]/.test(lower.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, ''));
}

export function parseUpload(upload: CheckedUpload, requestedSheet?: string): SheetGrid {
  const workbook = readWorkbook(upload);

  if (workbook.SheetNames.length === 0) {
    throw badRequest('That workbook has no sheets.');
  }

  const sheetName = pickSheet(workbook.SheetNames, requestedSheet);
  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet['!ref']) {
    throw badRequest(`The sheet “${sheetName}” is empty.`);
  }

  return readSheet(sheet, sheetName, workbook.SheetNames);
}

/**
 * Excel on Windows writes CSV with a UTF-8 byte order mark.
 *
 * Left in place it is decoded as text and eats into the first header, so
 * `Date` arrives as `te` and the column never matches anything. Stripped only
 * for CSV: inside a zipped .xlsx those bytes are container data, not text.
 */
function withoutBom(buffer: Buffer, type: ImportFileType): Buffer {
  if (type !== 'CSV') return buffer;
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3);
  }
  return buffer;
}

function readWorkbook(upload: CheckedUpload): XLSX.WorkBook {
  try {
    return XLSX.read(withoutBom(upload.buffer, upload.type), {
      type: 'buffer',
      // Raw serials, not Date objects — see the note at the top of this file.
      cellDates: false,
      // Number formats are needed to tell a date serial from a time serial.
      cellNF: true,
      // The rendered text is the safety net for values we would otherwise
      // reformat, such as an OFF number Excel decided was a number.
      cellText: true,
      // Formula *results* are read; formulas themselves are never evaluated.
      cellFormula: false,
      // Nothing that could carry executable content is parsed (§7).
      bookVBA: false,
      bookDeps: false,
      // CSV is decoded as UTF-8, which is what the importer documents and what
      // Arabic content in these plans is written in.
      codepage: 65001,
      dense: false,
    });
  } catch {
    // A parser exception is never surfaced (§22, §41) — it says nothing a user
    // can act on and may name internals.
    throw badRequest(
      `That ${describeType(upload.type)} could not be read. It may be corrupted, password-protected, or not really a spreadsheet.`,
    );
  }
}

function describeType(type: ImportFileType): string {
  switch (type) {
    case 'XLSX':
      return 'Excel workbook';
    case 'XLS':
      return 'Excel workbook';
    case 'CSV':
      return 'CSV file';
    default: {
      const never: never = type;
      throw new Error(`unhandled import file type: ${String(never)}`);
    }
  }
}

/**
 * Which sheet to read.
 *
 * A workbook produced for import carries the data on one sheet and often a
 * notes sheet beside it, so "the first sheet" is not always right. A sheet
 * literally named for the importer wins; otherwise the first is used and the
 * caller is told what else was available.
 */
function pickSheet(names: string[], requested?: string): string {
  if (requested) {
    const match = names.find((name) => name === requested);
    if (!match) {
      throw badRequest(
        `That workbook has no sheet named “${requested}”. It contains: ${names.join(', ')}.`,
      );
    }
    return match;
  }

  const preferred = names.find((name) => /committeeflow[_\s-]*import/i.test(name));
  return preferred ?? names[0] ?? '';
}

function readSheet(sheet: XLSX.WorkSheet, sheetName: string, availableSheets: string[]): SheetGrid {
  const range = XLSX.utils.decode_range(String(sheet['!ref']));

  const width = Math.min(range.e.c - range.s.c + 1, MAX_COLUMNS);
  if (width <= 0) throw badRequest(`The sheet “${sheetName}” is empty.`);

  // The first row holding anything is the header. Files often carry a blank
  // line or two above the table, and refusing those would be pedantic.
  const headerRowIndex = findHeaderRow(sheet, range, width);
  if (headerRowIndex === null) {
    throw badRequest(
      `The sheet “${sheetName}” has no header row. The first row should name the columns — Date, Time, OFF No., and so on.`,
    );
  }

  const headers = readHeaders(sheet, range, headerRowIndex, width);

  const rows: RawCell[][] = [];
  const sourceRowNumbers: number[] = [];
  let truncated = false;

  for (let r = headerRowIndex + 1; r <= range.e.r; r += 1) {
    if (rows.length >= MAX_DATA_ROWS) {
      truncated = true;
      break;
    }

    const cells: RawCell[] = [];
    let hasContent = false;
    for (let c = 0; c < width; c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: range.s.c + c })] as XLSX.CellObject | undefined;
      const raw = toRawCell(cell);
      if (raw.kind !== 'empty') hasContent = true;
      cells.push(raw);
    }

    // A fully blank row is layout, not data — a spacer between sections, or the
    // trailing rows Excel keeps in `!ref` after content is deleted.
    if (!hasContent) continue;

    rows.push(cells);
    // +1 because spreadsheet rows are 1-based and `r` is a 0-based index.
    sourceRowNumbers.push(r + 1);
  }

  if (rows.length === 0) {
    throw badRequest(
      `The sheet “${sheetName}” has a header row but no data underneath it.`,
    );
  }

  return { sheetName, availableSheets, headers, rows, sourceRowNumbers, truncated };
}

function findHeaderRow(sheet: XLSX.WorkSheet, range: XLSX.Range, width: number): number | null {
  // Only the first few rows are considered: a header further down than this is
  // a report layout, not a table, and guessing would do more harm than asking.
  const limit = Math.min(range.e.r, range.s.r + 10);
  for (let r = range.s.r; r <= limit; r += 1) {
    let filled = 0;
    for (let c = 0; c < width; c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: range.s.c + c })] as XLSX.CellObject | undefined;
      if (cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '') filled += 1;
    }
    if (filled >= 2) return r;
  }
  return null;
}

function readHeaders(
  sheet: XLSX.WorkSheet,
  range: XLSX.Range,
  headerRowIndex: number,
  width: number,
): string[] {
  const headers: string[] = [];
  const seen = new Map<string, number>();

  for (let c = 0; c < width; c += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: headerRowIndex, c: range.s.c + c })] as
      | XLSX.CellObject
      | undefined;
    const text = cell?.v === undefined || cell.v === null ? '' : String(cell.v).trim();

    // A blank header still needs an identity, because the column may hold data
    // the user wants to map.
    let label = text === '' ? `Column ${c + 1}` : collapseWhitespace(text);

    // Two columns called "Notes" would collide as mapping keys.
    const count = seen.get(label.toLowerCase()) ?? 0;
    seen.set(label.toLowerCase(), count + 1);
    if (count > 0) label = `${label} (${count + 1})`;

    headers.push(label);
  }

  return headers;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toRawCell(cell: XLSX.CellObject | undefined): RawCell {
  if (!cell || cell.v === undefined || cell.v === null) return { kind: 'empty' };

  switch (cell.t) {
    case 'n': {
      const value = Number(cell.v);
      if (!Number.isFinite(value)) return { kind: 'empty' };
      const formatted = typeof cell.w === 'string' ? cell.w : null;
      const code = typeof cell.z === 'string' ? cell.z : undefined;
      // A number carrying a date or time format is a serial, and only the
      // format code says which of the two it is.
      if (code && (isDateLikeFormat(code) || /h|s/i.test(code.replace(/\[[^\]]*\]/g, '')))) {
        return { kind: 'serial', serial: value, formatted, isDateFormat: isDateLikeFormat(code) };
      }
      return { kind: 'number', value, formatted };
    }

    case 'd': {
      // Reached only if a caller asked for cellDates; kept so the grid stays
      // total rather than throwing on a shape we did not request.
      const date = cell.v as unknown as Date;
      return {
        kind: 'text',
        text: Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10),
      };
    }

    case 'b':
      return { kind: 'boolean', value: Boolean(cell.v) };

    case 'e':
      // An Excel error cell (#REF!, #N/A). Treated as empty so one broken
      // formula does not fail the whole import.
      return { kind: 'empty' };

    case 's':
    default: {
      const text = collapseNewlines(String(cell.v));
      return text.trim() === '' ? { kind: 'empty' } : { kind: 'text', text };
    }
  }
}

/**
 * Keeps line breaks inside a cell but normalises them.
 *
 * A quoted CSV field may legitimately contain newlines (§13), and Notes is the
 * field where that actually happens; they are preserved, not flattened.
 */
function collapseNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** The text a cell would show in Excel — used for previews and error messages. */
export function cellToDisplay(cell: RawCell): string {
  switch (cell.kind) {
    case 'empty':
      return '';
    case 'text':
      return cell.text;
    case 'number':
      return cell.formatted ?? String(cell.value);
    case 'serial':
      return cell.formatted ?? String(cell.serial);
    case 'boolean':
      return cell.value ? 'Yes' : 'No';
    default: {
      const never: never = cell;
      throw new Error(`unhandled cell kind: ${String(never)}`);
    }
  }
}
