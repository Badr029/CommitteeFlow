import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Booking, PlanFieldValue } from '@shared/api-types.js';
import { displayDayFor, endOfMonth, startOfMonth } from '../../lib/dates.js';
import type { PlanFieldRecord } from '../plan-config/plan-fields.repository.js';
import { measurePdfText, registerPdfFonts, renderPdfText } from './pdf-text.js';

/**
 * Excel and PDF export (spec §18).
 *
 * Both exports render from the same visible plan-field definitions that drive
 * the booking form, the plan table and the detail view (spec §77) — there is no
 * second, hardcoded column list anywhere in this file.
 *
 * These are snapshots of the current state, not the source of truth (spec §2).
 */

export interface ExportContext {
  fields: readonly PlanFieldRecord[];
  bookings: readonly Booking[];
  range: { from: string; to: string };
  generatedBy: string;
  generatedAt: Date;
}

/** The visible, active fields in display order — the exported columns. */
export function exportColumns(fields: readonly PlanFieldRecord[]): PlanFieldRecord[] {
  return fields
    .filter((field) => field.isActive && field.isVisible)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.fieldKey.localeCompare(b.fieldKey));
}

function valueFor(booking: Booking, field: PlanFieldRecord): PlanFieldValue {
  switch (field.fieldKey) {
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
      /*
       * Exported in the reader's language rather than the database's. The value
       * is an enum, but a printed plan is read by people, and `PLANNED` in a
       * spreadsheet cell looks like a system leaking.
       */
      return booking.status === 'CANCELLED' ? 'Cancelled' : 'Planned';
    case 'serial_no':
      return booking.serialNo;
    case 'project_engineer':
      // The engineer's name. A UUID in a printed plan helps nobody.
      return booking.projectEngineer?.name ?? null;
    case 'notes':
      return booking.notes;
    case 'customer_name':
      return booking.customerName;
    default:
      return booking.customFields[field.fieldKey] ?? null;
  }
}

function displayValue(booking: Booking, field: PlanFieldRecord): string {
  const value = valueFor(booking, field);
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function exportFileName(range: { from: string; to: string }, extension: string): string {
  const sameMonth = range.from.slice(0, 7) === range.to.slice(0, 7);
  const label = sameMonth ? range.from.slice(0, 7) : `${range.from}_to_${range.to}`;
  return `committee-plan-${label}.${extension}`;
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export async function buildExcel(context: ExportContext): Promise<Buffer> {
  const columns = exportColumns(context.fields);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CommitteeFlow';
  workbook.created = context.generatedAt;

  const sheet = workbook.addWorksheet('Committee Plan', {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // "Day" is derived from the date, never a stored field (spec §11), so it is
  // added as a rendering convenience beside the date column.
  const headers = columns.flatMap((field) =>
    field.fieldKey === 'booking_date' ? [field.label, 'Day'] : [field.label],
  );

  sheet.mergeCells(1, 1, 1, Math.max(headers.length, 1));
  const title = sheet.getCell(1, 1);
  title.value = 'Committee Plan';
  title.font = { size: 15, bold: true, color: { argb: 'FF0F2A43' } };
  title.alignment = { vertical: 'middle' };
  sheet.getRow(1).height = 26;

  sheet.mergeCells(2, 1, 2, Math.max(headers.length, 1));
  const subtitle = sheet.getCell(2, 1);
  subtitle.value =
    `${context.range.from} to ${context.range.to}` +
    `  ·  ${context.bookings.length} booking${context.bookings.length === 1 ? '' : 's'}` +
    `  ·  exported by ${context.generatedBy} on ${context.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  subtitle.font = { size: 10, color: { argb: 'FF64748B' } };

  const headerRow = sheet.getRow(3);
  headerRow.values = headers;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F4C81' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF0F2A43' } } };
  });

  for (const booking of context.bookings) {
    const values = columns.flatMap((field) => {
      if (field.fieldKey === 'booking_date') {
        return [booking.bookingDate, displayDayFor(booking.bookingDate)];
      }
      const raw = valueFor(booking, field);
      /*
       * Numbers stay numbers so Excel can total and sort them — but a serial
       * number is not one. `010662606B` is already text, and anything that
       * looked purely numeric would lose its leading zeros the moment Excel
       * decided it was a quantity.
       */
      if (field.fieldKey === 'serial_no') return [raw === null ? '' : String(raw)];
      return [typeof raw === 'boolean' ? (raw ? 'Yes' : 'No') : (raw ?? '')];
    });

    const row = sheet.addRow(values);
    if (booking.status === 'CANCELLED') {
      row.font = { strike: true, color: { argb: 'FF94A3B8' } };
    }
  }

  sheet.columns.forEach((column, index) => {
    const header = headers[index] ?? '';
    let widest = header.length;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      // ExcelJS cell values can be rich objects (formulas, hyperlinks); only a
      // primitive contributes a meaningful width.
      const value = cell.value;
      const text =
        value === null || value === undefined || typeof value === 'object' ? '' : String(value);
      widest = Math.max(widest, text.length);
    });
    column.width = Math.min(Math.max(widest + 2, 10), 48);
    column.alignment = { vertical: 'top', wrapText: true };
  });

  sheet.autoFilter = {
    from: { row: 3, column: 1 },
    to: { row: 3, column: Math.max(headers.length, 1) },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/*
 * The printed Committee Plan.
 *
 * This is not a generic table dump: it is the controlled form the plan is
 * circulated on, and people read it beside the one the plan replaced. So it
 * reproduces that sheet — a yellow title band, a green heading row, every cell
 * ruled, the day and date merged down the rows they cover, and every day of the
 * month present whether or not anything is booked on it.
 *
 * The colours below are the source form's own, sampled from it rather than
 * chosen here, which is why they are flat primaries instead of the muted
 * palette the application uses on screen. A printed form and a screen are two
 * different artefacts with two different jobs.
 */
const FORM = {
  /** Identifies the controlled form this plan is issued on. */
  documentCode: 'PM-FR-01-02-D',
  revision: '(0)',
  titleBand: '#FFFF00',
  headingRow: '#00B050',
  /** The source form fills the Time column, so the eye can find the slot. */
  timeColumn: '#83CCEB',
  ink: '#000000',
  rule: '#000000',
  paper: '#FFFFFF',
  /** A cancelled booking stays on the plan, greyed rather than removed (§15). */
  cancelledInk: '#767676',
} as const;

/** Relative width of each column. Anything unlisted gets an ordinary share. */
const COLUMN_WEIGHTS: Record<string, number> = {
  __day: 1.05,
  booking_date: 1.1,
  booking_time: 0.8,
  off_no: 1.2,
  order_name: 2.7,
  committee: 1.5,
  qty: 0.5,
  kva: 0.75,
  kv: 0.7,
  status: 0.9,
  serial_no: 1.8,
  project_engineer: 1.4,
  notes: 1.7,
  customer_name: 1.7,
};

/** Columns whose figures line up better against the right edge. */
const RIGHT_ALIGNED = new Set(['qty', 'kva']);
/** Columns that read as labels rather than prose, and centre well. */
const CENTRED = new Set(['__day', 'booking_date', 'booking_time', 'kv', 'status']);

/**
 * Lines a cell may wrap to before it is cut short.
 *
 * Two, so an order name that does not fit still reads, and a runaway value
 * cannot push a row over a page break on its own.
 */
const MAX_CELL_LINES = 2;

/**
 * A column of the printed grid.
 *
 * `__day` is the one column with no plan field behind it: the weekday is
 * derived from the date and never stored (§11), so it exists only here.
 */
interface PdfColumn {
  key: string;
  label: string;
  field: PlanFieldRecord | null;
  width: number;
  align: 'left' | 'center' | 'right' | 'auto';
}

interface PdfRow {
  date: string;
  booking: Booking | null;
  cells: string[];
  /**
   * Per column, the group this cell belongs to, or null if it stands alone.
   * Consecutive rows sharing a key are drawn as one merged cell — which is what
   * makes a day read as a block rather than as its date repeated eight times.
   */
  mergeKeys: (string | null)[];
  height: number;
  cancelled: boolean;
}

const PAGE_MARGINS = { top: 22, bottom: 30, left: 24, right: 24 };
const CONTROL_STRIP_HEIGHT = 14;
const TITLE_BAND_HEIGHT = 24;
const HEADING_ROW_HEIGHT = 18;
const MIN_ROW_HEIGHT = 15;
const CELL_PAD = 3;
const BODY_FONT_SIZE = 7;

export function buildPdf(context: ExportContext): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margins: PAGE_MARGINS,
      // The control strip names the page count, which is only known at the end.
      bufferPages: true,
      autoFirstPage: false,
      info: { Title: 'Committee Plan', Author: 'CommitteeFlow' },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    /*
     * Before anything is drawn: the standard PDF fonts cannot hold Arabic, and
     * the plan is bilingual. See `pdf-text.ts` for what that used to produce.
     */
    registerPdfFonts(doc);
    doc.addPage();

    const contentWidth = doc.page.width - PAGE_MARGINS.left - PAGE_MARGINS.right;
    const columns = pdfColumns(context.fields, contentWidth);
    const rows = pdfRows(context, columns, doc);
    const pages = paginate(rows, doc);

    pages.forEach((pageRows, index) => {
      if (index > 0) doc.addPage();
      drawTitleBlock(doc, context, contentWidth);
      drawHeadingRow(doc, columns, contentWidth);
      drawRows(doc, pageRows, columns, contentWidth);
    });

    // The control strip last, once the page count is a fact rather than a guess.
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      drawControlStrip(doc, contentWidth, index + 1, range.count);
    }

    doc.end();
  });
}

/**
 * The printed columns.
 *
 * Order, labels and visibility all come from Plan Configuration (§35, §77) —
 * there is no second column list here. The only addition is the derived Day,
 * placed immediately before the date it is derived from, where the source form
 * carries it.
 */
function pdfColumns(fields: readonly PlanFieldRecord[], contentWidth: number): PdfColumn[] {
  const configured = exportColumns(fields);

  const drafts: Array<{ key: string; label: string; field: PlanFieldRecord | null }> = [];
  for (const field of configured) {
    if (field.fieldKey === 'booking_date') {
      drafts.push({ key: '__day', label: 'Day', field: null });
    }
    drafts.push({ key: field.fieldKey, label: field.label, field });
  }

  // A plan with the date hidden still needs its days named.
  if (!drafts.some((draft) => draft.key === '__day')) {
    drafts.unshift({ key: '__day', label: 'Day', field: null });
  }

  const weights = drafts.map((draft) => COLUMN_WEIGHTS[draft.key] ?? 1.1);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;

  return drafts.map((draft, index) => ({
    ...draft,
    width: ((weights[index] ?? 1.1) / total) * contentWidth,
    /*
     * A column of figures is right-aligned whatever it holds, and a label
     * column stays centred. Everything else is prose, and prose follows its
     * own direction: an Arabic committee name sits against the right edge of
     * its cell the way it would on the sheet this form replaces.
     */
    align: RIGHT_ALIGNED.has(draft.key)
      ? ('right' as const)
      : CENTRED.has(draft.key)
        ? ('center' as const)
        : ('auto' as const),
  }));
}

/**
 * Every day in the range, booked or not.
 *
 * A monthly plan is read as a calendar: a day with nothing on it is a fact
 * about the month, and printing only the booked days would quietly turn "the
 * committee is free on the 12th" into "the 12th does not exist".
 */
function pdfRows(
  context: ExportContext,
  columns: PdfColumn[],
  doc: PDFKit.PDFDocument,
): PdfRow[] {
  const byDate = new Map<string, Booking[]>();
  for (const booking of context.bookings) {
    const list = byDate.get(booking.bookingDate);
    if (list) list.push(booking);
    else byDate.set(booking.bookingDate, [booking]);
  }

  const rows: PdfRow[] = [];
  for (const date of datesBetween(context.range.from, context.range.to)) {
    const bookings = byDate.get(date) ?? [];
    if (bookings.length === 0) {
      rows.push(makeRow(date, null, columns, doc));
      continue;
    }
    for (const booking of bookings) rows.push(makeRow(date, booking, columns, doc));
  }

  // A range that somehow carried bookings outside it must still print them
  // rather than drop them silently.
  const printed = new Set(rows.map((row) => row.booking?.id).filter(Boolean));
  for (const booking of context.bookings) {
    if (!printed.has(booking.id)) rows.push(makeRow(booking.bookingDate, booking, columns, doc));
  }

  return rows;
}

function makeRow(
  date: string,
  booking: Booking | null,
  columns: PdfColumn[],
  doc: PDFKit.PDFDocument,
): PdfRow {
  const cells = columns.map((column) => {
    if (column.key === '__day') return displayDayFor(date);
    // The date belongs to the day, not to the booking: a day with nothing on it
    // still has a date, and printing the weekday beside a blank would be worse
    // than printing no row at all.
    if (column.key === 'booking_date') return date;
    if (!booking || !column.field) return '';
    return displayValue(booking, column.field);
  });

  const sessionKey = booking
    ? `${date}|${booking.bookingTime}|${booking.committee ?? ''}`
    : `${date}|free`;

  const mergeKeys = columns.map((column) => {
    if (column.key === '__day' || column.key === 'booking_date') return date;
    if (column.key === 'booking_time' || column.key === 'committee') return sessionKey;
    return null;
  });

  const height = Math.max(
    MIN_ROW_HEIGHT,
    ...cells.map(
      (text, index) =>
        measurePdfText(doc, text, {
          width: (columns[index]?.width ?? 60) - CELL_PAD * 2,
          size: BODY_FONT_SIZE,
          maxLines: MAX_CELL_LINES,
        }).height + CELL_PAD * 2,
    ),
  );

  return {
    date,
    booking,
    cells,
    mergeKeys,
    height,
    cancelled: booking?.status === 'CANCELLED',
  };
}

/** Rows grouped into pages. A row is never split across a page boundary. */
function paginate(rows: PdfRow[], doc: PDFKit.PDFDocument): PdfRow[][] {
  const top = PAGE_MARGINS.top + CONTROL_STRIP_HEIGHT + TITLE_BAND_HEIGHT + HEADING_ROW_HEIGHT;
  const limit = doc.page.height - PAGE_MARGINS.bottom;

  const pages: PdfRow[][] = [];
  let current: PdfRow[] = [];
  let y = top;

  for (const row of rows) {
    if (current.length > 0 && y + row.height > limit) {
      pages.push(current);
      current = [];
      y = top;
    }
    current.push(row);
    y += row.height;
  }

  pages.push(current);
  return pages;
}

function drawControlStrip(
  doc: PDFKit.PDFDocument,
  contentWidth: number,
  page: number,
  pageCount: number,
): void {
  const y = PAGE_MARGINS.top;
  const cells = [
    { text: `Code : ${FORM.documentCode}`, width: contentWidth * 0.34, align: 'left' as const },
    { text: `Rev: ${FORM.revision}`, width: contentWidth * 0.33, align: 'center' as const },
    { text: `page ${page} of ${pageCount}`, width: contentWidth * 0.33, align: 'right' as const },
  ];

  let x = PAGE_MARGINS.left;
  for (const cell of cells) {
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(FORM.rule)
      .rect(x, y, cell.width, CONTROL_STRIP_HEIGHT)
      .stroke()
      .restore();
    renderPdfText(doc, cell.text, {
      x: x + CELL_PAD,
      y: y + 4,
      width: cell.width - CELL_PAD * 2,
      size: 7,
      align: cell.align,
      color: FORM.ink,
    });
    x += cell.width;
  }
}

function drawTitleBlock(
  doc: PDFKit.PDFDocument,
  context: ExportContext,
  contentWidth: number,
): void {
  const y = PAGE_MARGINS.top + CONTROL_STRIP_HEIGHT;

  doc.save().rect(PAGE_MARGINS.left, y, contentWidth, TITLE_BAND_HEIGHT).fill(FORM.titleBand).restore();
  doc
    .save()
    .lineWidth(0.7)
    .strokeColor(FORM.rule)
    .rect(PAGE_MARGINS.left, y, contentWidth, TITLE_BAND_HEIGHT)
    .stroke()
    .restore();

  renderPdfText(doc, planTitle(context.range), {
    x: PAGE_MARGINS.left,
    y: y + 6,
    width: contentWidth,
    size: 13,
    bold: true,
    align: 'center',
    color: FORM.ink,
  });
}

/** "Committee Plan for September 2026", or the dates when it is not one month. */
function planTitle(range: { from: string; to: string }): string {
  const wholeMonth =
    range.from === startOfMonth(range.from) &&
    range.to === endOfMonth(range.from) &&
    range.from.slice(0, 7) === range.to.slice(0, 7);

  if (!wholeMonth) return `Committee Plan · ${range.from} to ${range.to}`;

  const [year, month] = range.from.split('-');
  const name = MONTH_NAMES[Number(month) - 1] ?? range.from.slice(0, 7);
  return `Committee Plan for ${name} ${year}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function drawHeadingRow(
  doc: PDFKit.PDFDocument,
  columns: PdfColumn[],
  contentWidth: number,
): void {
  const y = PAGE_MARGINS.top + CONTROL_STRIP_HEIGHT + TITLE_BAND_HEIGHT;

  doc.save().rect(PAGE_MARGINS.left, y, contentWidth, HEADING_ROW_HEIGHT).fill(FORM.headingRow).restore();
  let x = PAGE_MARGINS.left;
  for (const column of columns) {
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(FORM.rule)
      .rect(x, y, column.width, HEADING_ROW_HEIGHT)
      .stroke()
      .restore();
    renderPdfText(doc, column.label, {
      x: x + CELL_PAD,
      y: y + 5.5,
      width: column.width - CELL_PAD * 2,
      size: 7.5,
      bold: true,
      align: 'center',
      color: FORM.ink,
    });
    x += column.width;
  }
}

function drawRows(
  doc: PDFKit.PDFDocument,
  rows: PdfRow[],
  columns: PdfColumn[],
  contentWidth: number,
): void {
  const top = PAGE_MARGINS.top + CONTROL_STRIP_HEIGHT + TITLE_BAND_HEIGHT + HEADING_ROW_HEIGHT;

  // Row tops, so a merged cell can be measured without re-walking the list.
  const tops: number[] = [];
  let y = top;
  for (const row of rows) {
    tops.push(y);
    y += row.height;
  }
  const bottom = y;

  columns.forEach((column, columnIndex) => {
    const x = columns.slice(0, columnIndex).reduce((sum, other) => sum + other.width, 0) + PAGE_MARGINS.left;

    let rowIndex = 0;
    while (rowIndex < rows.length) {
      const row = rows[rowIndex]!;
      const key = row.mergeKeys[columnIndex];

      // How many following rows share this cell — merging only where a key says
      // so, which is what keeps a day's date from repeating down its own block.
      let span = 1;
      if (key !== null) {
        while (
          rowIndex + span < rows.length &&
          rows[rowIndex + span]!.mergeKeys[columnIndex] === key
        ) {
          span += 1;
        }
      }

      const cellTop = tops[rowIndex]!;
      const cellBottom = rowIndex + span < rows.length ? tops[rowIndex + span]! : bottom;
      const cellHeight = cellBottom - cellTop;

      drawCell(doc, {
        x,
        y: cellTop,
        width: column.width,
        height: cellHeight,
        text: row.cells[columnIndex] ?? '',
        align: column.align,
        fill: column.key === 'booking_time' ? FORM.timeColumn : FORM.paper,
        // A merged cell covers rows that may not agree on being cancelled, so
        // only an unmerged cell can be greyed for it.
        ink: span === 1 && row.cancelled ? FORM.cancelledInk : FORM.ink,
        strike: span === 1 && row.cancelled,
      });

      rowIndex += span;
    }
  });

  // The grid's own outer edge, drawn once and heavier than the cell rules.
  doc
    .save()
    .lineWidth(0.9)
    .strokeColor(FORM.rule)
    .rect(PAGE_MARGINS.left, top, contentWidth, bottom - top)
    .stroke()
    .restore();
}

function drawCell(
  doc: PDFKit.PDFDocument,
  cell: {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    align: 'left' | 'center' | 'right' | 'auto';
    fill: string;
    ink: string;
    strike: boolean;
  },
): void {
  doc.save().rect(cell.x, cell.y, cell.width, cell.height).fill(cell.fill).restore();
  doc
    .save()
    .lineWidth(0.5)
    .strokeColor(FORM.rule)
    .rect(cell.x, cell.y, cell.width, cell.height)
    .stroke()
    .restore();

  if (cell.text === '') return;

  const width = cell.width - CELL_PAD * 2;

  // Vertically centred, which is what makes a merged day cell sit against the
  // block it covers instead of against its first row.
  const measured = measurePdfText(doc, cell.text, {
    width,
    size: BODY_FONT_SIZE,
    maxLines: MAX_CELL_LINES,
  });
  const y = cell.y + Math.max(CELL_PAD, (cell.height - measured.height) / 2);

  renderPdfText(doc, cell.text, {
    x: cell.x + CELL_PAD,
    y,
    width,
    size: BODY_FONT_SIZE,
    align: cell.align,
    color: cell.ink,
    maxLines: MAX_CELL_LINES,
  });

  if (cell.strike) {
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(cell.ink)
      .moveTo(cell.x + CELL_PAD, cell.y + cell.height / 2)
      .lineTo(cell.x + cell.width - CELL_PAD, cell.y + cell.height / 2)
      .stroke()
      .restore();
  }
}

/** Every calendar date from `from` to `to`, inclusive. */
function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return dates;

  // Guard against a range wide enough to exhaust memory before it exhausts
  // patience; a plan is printed a month at a time.
  const MAX_DAYS = 400;
  for (let day = 0; day <= MAX_DAYS; day += 1) {
    const at = start + day * 86_400_000;
    if (at > end) break;
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}
