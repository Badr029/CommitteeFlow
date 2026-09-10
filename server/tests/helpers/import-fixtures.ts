import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

/**
 * Spreadsheet fixtures for the import tests.
 *
 * Built in memory rather than committed as binaries, so a reviewer can read
 * exactly what a test is feeding the parser instead of opening Excel — and so a
 * fixture cannot silently drift from the assertion that depends on it.
 *
 * The one exception is the real September plan workbook, which is used as-is
 * when it is present in the repository root.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The normalized import structure documented for the product (spec §9). */
export const STANDARD_HEADERS = [
  'Date',
  'Time',
  'OFF No.',
  'Order Name',
  'Committee',
  'Qty',
  'KVA',
  'KV',
  'Status',
  'Notes',
  'Customer Name',
] as const;

export type SheetRow = (string | number | boolean | null)[];

/** Builds a real .xlsx in memory from rows of plain values. */
export function buildXlsx(
  rows: SheetRow[],
  options: { sheetName?: string; extraSheets?: Record<string, SheetRow[]> } = {},
): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, options.sheetName ?? 'CommitteeFlow_Import');

  for (const [name, extraRows] of Object.entries(options.extraSheets ?? {})) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(extraRows), name);
  }

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * A workbook whose Date and Time cells are real Excel serials.
 *
 * This is what Excel actually writes, and it is the case that breaks naive
 * importers: the value on disk is `46274`, not `2026-09-09`.
 */
export function buildXlsxWithSerials(dataRows: Array<Record<string, unknown>>): Buffer {
  const workbook = XLSX.utils.book_new();
  const aoa: SheetRow[] = [[...STANDARD_HEADERS]];
  for (const row of dataRows) {
    aoa.push(STANDARD_HEADERS.map((header) => (row[header] ?? null) as SheetRow[number]));
  }
  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  // Stamp the number formats Excel would apply, so the parser has to tell a
  // date serial from a time serial the way it does in production.
  const range = XLSX.utils.decode_range(String(sheet['!ref']));
  for (let r = 1; r <= range.e.r; r += 1) {
    const dateCell = sheet[XLSX.utils.encode_cell({ r, c: 0 })] as XLSX.CellObject | undefined;
    if (dateCell && dateCell.t === 'n') dateCell.z = 'dd-mmm-yy';
    const timeCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })] as XLSX.CellObject | undefined;
    if (timeCell && timeCell.t === 'n') timeCell.z = 'h:mm AM/PM';
  }

  XLSX.utils.book_append_sheet(workbook, sheet, 'CommitteeFlow_Import');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/** Days since 1899-12-30, which is how Excel stores a date. */
export function dateSerial(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  const ms = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) - Date.UTC(1899, 11, 30);
  return Math.round(ms / 86_400_000);
}

/** Fraction of a day, which is how Excel stores a time. */
export function timeSerial(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return ((hours ?? 0) * 60 + (minutes ?? 0)) / (24 * 60);
}

/** A legacy .xls workbook, for the format the parser must still accept. */
export function buildXls(rows: SheetRow[], sheetName = 'CommitteeFlow_Import'): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }) as Buffer;
}

/**
 * A CSV exercising everything §13 requires.
 *
 * Arabic text, a quoted value containing commas, a quoted value containing a
 * line break, blank optional cells, two rows sharing one Committee Session, and
 * a future-month row. Written with a UTF-8 BOM, because that is what Excel
 * produces when it saves CSV on Windows.
 */
export function realisticCsv(): Buffer {
  const lines = [
    'Date,Time,OFF No.,Order Name,Committee,Qty,KVA,KV,Status,Notes,Customer Name',
    '2026-09-09,10:00,202601066,Transformer 2B,South Committee,4,1500,11,Planned,,وطنية',
    '2026-09-09,10:00,202601047,"Cable box, HV, 22kV",South Committee,1,1600,22,Planned,,Dubai Municipality',
    '2026-09-09,10:00,202601049,"Order with""quoted"" name",South Committee,2,800,11,,,',
    '2026-09-10,09:30,202601137,مصنع انسوتك,North Committee,1,1000,22,In review,"ملاحظة عربية",Sharjah',
    '2026-09-11,13:00,202601330,High Speed Rail,EPOWER,1,20000,132,Planned,"Line one',
    'line two",Etihad Rail',
    '2026-10-05,10:00,202601419,Al Marya Tower,North Committee,7,2000,22,,,Aldar',
  ];
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

/** The minimum a row needs to be importable under the seeded configuration. */
export function validRow(overrides: Partial<Record<string, unknown>> = {}): SheetRow {
  const base: Record<string, unknown> = {
    Date: '2026-09-09',
    Time: '10:00',
    'OFF No.': '202601066',
    'Order Name': 'Transformer 2B',
    Committee: 'South Committee',
    Qty: 4,
    KVA: 1500,
    KV: 11,
    Status: 'Planned',
    Notes: '',
    'Customer Name': 'Aweer Maintenance',
    ...overrides,
  };
  return STANDARD_HEADERS.map((header) => (base[header] ?? null) as SheetRow[number]);
}

export function sheetWith(rows: SheetRow[]): SheetRow[] {
  return [[...STANDARD_HEADERS], ...rows];
}

/**
 * The real September plan workbook, when it is in the repository.
 *
 * Returns null rather than throwing so the suite still runs in a checkout that
 * does not carry it — the synthetic fixtures cover the same shapes.
 */
export function realPlanWorkbook(): { buffer: Buffer; filename: string } | null {
  const candidates = [
    path.resolve(here, '..', '..', '..', '..', 'CommitteeFlow_Import_From_September_Plan.xlsx'),
    path.resolve(here, '..', '..', '..', 'CommitteeFlow_Import_From_September_Plan.xlsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { buffer: fs.readFileSync(candidate), filename: path.basename(candidate) };
    }
  }
  return null;
}
