import { describe, expect, it } from 'vitest';
import { checkUpload, safeDisplayFilename } from '../../src/modules/plan-import/file-guard.js';
import { parseUpload, type RawCell } from '../../src/modules/plan-import/parse.js';
import {
  applyCarryForward,
  cellToFieldValue,
  serialToDateString,
  serialToTimeString,
  textToDateString,
  textToTimeString,
} from '../../src/modules/plan-import/normalize.js';
import { suggestMapping } from '../../src/modules/plan-import/mapping.js';
import type { PlanFieldRecord } from '../../src/modules/plan-config/plan-fields.repository.js';
import {
  buildXls,
  buildXlsx,
  buildXlsxWithSerials,
  dateSerial,
  realPlanWorkbook,
  realisticCsv,
  sheetWith,
  timeSerial,
  validRow,
} from '../helpers/import-fixtures.js';

/** A plan field, with only what the importer reads. */
function field(overrides: Partial<PlanFieldRecord> & Pick<PlanFieldRecord, 'fieldKey' | 'label'>): PlanFieldRecord {
  return {
    id: `field-${overrides.fieldKey}`,
    helpText: null,
    fieldType: 'TEXT',
    fieldClass: 'STANDARD',
    storageStrategy: 'COLUMN',
    isRequired: false,
    isVisible: true,
    displayOrder: 10,
    options: [],
    isActive: true,
    archivedAt: null,
    ...overrides,
  };
}

const PLAN_FIELDS: PlanFieldRecord[] = [
  field({ fieldKey: 'booking_date', label: 'Date', fieldType: 'DATE', isRequired: true }),
  field({ fieldKey: 'booking_time', label: 'Time', fieldType: 'TIME', isRequired: true }),
  field({ fieldKey: 'off_no', label: 'OFF No.', isRequired: true }),
  field({ fieldKey: 'order_name', label: 'Order Name', isRequired: true }),
  field({ fieldKey: 'committee', label: 'Committee', isRequired: true }),
  field({ fieldKey: 'qty', label: 'Qty', fieldType: 'NUMBER' }),
  field({ fieldKey: 'kva', label: 'KVA', fieldType: 'NUMBER' }),
  field({ fieldKey: 'kv', label: 'KV' }),
  field({ fieldKey: 'status', label: 'Status' }),
  field({ fieldKey: 'serial_no', label: 'Serial No.' }),
  field({ fieldKey: 'project_engineer', label: 'Project Engineer' }),
  field({ fieldKey: 'notes', label: 'Notes', fieldType: 'LONG_TEXT' }),
  field({ fieldKey: 'customer_name', label: 'Customer Name' }),
];

function upload(buffer: Buffer, filename: string, mimetype = 'application/octet-stream') {
  return checkUpload({ originalname: filename, mimetype, buffer });
}

// ---------------------------------------------------------------------------
// File security (spec §7, §41)
// ---------------------------------------------------------------------------

describe('upload guard', () => {
  it('accepts the three documented formats', () => {
    expect(upload(buildXlsx(sheetWith([validRow()])), 'plan.xlsx').type).toBe('XLSX');
    expect(upload(buildXls(sheetWith([validRow()])), 'plan.xls').type).toBe('XLS');
    expect(upload(realisticCsv(), 'plan.csv', 'text/csv').type).toBe('CSV');
  });

  it('refuses PDF by name, and says why', () => {
    const pdf = Buffer.from('%PDF-1.7\n...');
    expect(() => upload(pdf, 'plan.pdf', 'application/pdf')).toThrow(/structured spreadsheets only/i);
  });

  it.each([
    ['plan.xlsm', /macro-enabled/i],
    ['plan.docx', /Word documents/i],
    ['plan.ods', /OpenDocument/i],
    ['plan.txt', /Plain text/i],
  ])('refuses %s', (filename, expected) => {
    expect(() => upload(buildXlsx(sheetWith([validRow()])), filename)).toThrow(expected);
  });

  /*
   * The extension and the Content-Type are both attacker-controlled, so the
   * bytes have to be checked independently — this is the case that catches a
   * file renamed to look importable.
   */
  it('refuses a file whose bytes contradict its extension', () => {
    const reallyXlsx = buildXlsx(sheetWith([validRow()]));
    expect(() => upload(reallyXlsx, 'plan.xls')).toThrow(/really a newer .xlsx/i);

    const reallyXls = buildXls(sheetWith([validRow()]));
    expect(() => upload(reallyXls, 'plan.xlsx')).toThrow(/really an older .xls/i);

    expect(() => upload(reallyXlsx, 'plan.csv', 'text/csv')).toThrow(/really an Excel workbook/i);
  });

  it('refuses a binary renamed to .csv', () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00]);
    expect(() => upload(binary, 'plan.csv', 'text/csv')).toThrow(/does not look like text/i);
  });

  it('refuses an empty file and a corrupted workbook', () => {
    expect(() => upload(Buffer.alloc(0), 'plan.xlsx')).toThrow(/empty/i);

    // A valid ZIP header followed by rubbish: passes the signature check, then
    // has to fail cleanly in the parser.
    const corrupt = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not a workbook')]);
    expect(() => parseUpload(upload(corrupt, 'plan.xlsx'))).toThrow(/could not be read/i);
  });

  it('refuses a file over the size limit', () => {
    const oversized = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(6 * 1024 * 1024)]);
    expect(() => upload(oversized, 'plan.xlsx')).toThrow(/limit is/i);
  });

  /** The filename is displayed and stored; it must never be usable as a path. */
  it('strips path syntax from the filename', () => {
    expect(safeDisplayFilename('../../etc/passwd')).toBe('etc.passwd'.replace('etc.passwd', 'passwd'));
    expect(safeDisplayFilename('C:\\Users\\pc\\plan.xlsx')).toBe('plan.xlsx');
    expect(safeDisplayFilename('/var/tmp/plan.csv')).toBe('plan.csv');
    expect(safeDisplayFilename('')).toBe('upload');
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parsing', () => {
  it('reads the header row and the data under it', () => {
    const grid = parseUpload(upload(buildXlsx(sheetWith([validRow(), validRow()])), 'plan.xlsx'));
    expect(grid.headers).toEqual([
      'Date', 'Time', 'OFF No.', 'Order Name', 'Committee',
      'Qty', 'KVA', 'KV', 'Status', 'Notes', 'Customer Name',
    ]);
    expect(grid.rows).toHaveLength(2);
    // Row 1 is the header, so the first data row is spreadsheet row 2.
    expect(grid.sourceRowNumbers).toEqual([2, 3]);
  });

  it('skips blank spacer rows without losing the real row numbers', () => {
    const grid = parseUpload(
      upload(buildXlsx([[...sheetWith([validRow()])[0]!], validRow(), [], validRow()]), 'plan.xlsx'),
    );
    expect(grid.rows).toHaveLength(2);
    expect(grid.sourceRowNumbers).toEqual([2, 4]);
  });

  it('prefers the sheet named for the importer over the first one', () => {
    const buffer = buildXlsx(sheetWith([validRow()]), {
      sheetName: 'CommitteeFlow_Import',
      extraSheets: { Import_Notes: [['Notes'], ['Anything']] },
    });
    expect(parseUpload(upload(buffer, 'plan.xlsx')).sheetName).toBe('CommitteeFlow_Import');
  });

  it('rejects a workbook with a header but no data', () => {
    expect(() => parseUpload(upload(buildXlsx([[...['Date', 'Time']]]), 'plan.xlsx'))).toThrow(
      /no data underneath/i,
    );
  });

  it('parses CSV, including quoted commas, quotes, newlines and Arabic', () => {
    const grid = parseUpload(upload(realisticCsv(), 'plan.csv', 'text/csv'));

    expect(grid.headers[0]).toBe('Date');
    expect(grid.rows).toHaveLength(6);

    const cellText = (row: number, column: number) => {
      const cell = grid.rows[row]?.[column];
      return cell && cell.kind === 'text' ? cell.text : null;
    };

    expect(cellText(1, 3)).toBe('Cable box, HV, 22kV');
    expect(cellText(2, 3)).toBe('Order with"quoted" name');
    expect(cellText(3, 3)).toBe('مصنع انسوتك');
    expect(cellText(4, 9)).toBe('Line one\nline two');
  });

  it('reads a legacy .xls workbook', () => {
    const grid = parseUpload(upload(buildXls(sheetWith([validRow()])), 'plan.xls'));
    expect(grid.headers).toContain('OFF No.');
    expect(grid.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Normalisation (spec §15)
// ---------------------------------------------------------------------------

describe('date and time normalisation', () => {
  /*
   * The whole reason serials are converted arithmetically. Building a Date from
   * a serial in a timezone east of UTC lands on the previous evening, and the
   * booking silently moves a day.
   */
  it('converts an Excel date serial to the calendar date, whatever the timezone', () => {
    expect(serialToDateString(46274)).toBe('2026-09-09');
    expect(serialToDateString(dateSerial('2026-10-05'))).toBe('2026-10-05');
    expect(serialToDateString(dateSerial('2027-01-01'))).toBe('2027-01-01');
  });

  it('converts an Excel time serial, rounding binary drift to the minute', () => {
    expect(serialToTimeString(0.4166666666666667)).toBe('10:00');
    // 0.41666666666666663 is 09:59:59.999 in exact arithmetic.
    expect(serialToTimeString(0.41666666666666663)).toBe('10:00');
    expect(serialToTimeString(timeSerial('13:30'))).toBe('13:30');
    expect(serialToTimeString(0)).toBe('00:00');
  });

  it('reads unambiguous text dates and refuses ambiguous ones', () => {
    expect(textToDateString('2026-09-09')).toBe('2026-09-09');
    expect(textToDateString('9-Sep-26')).toBe('2026-09-09');
    expect(textToDateString('09 September 2026')).toBe('2026-09-09');
    expect(textToDateString('Sep 9, 2026')).toBe('2026-09-09');

    // 09/10/2026 is September 10th or October 9th depending on the country;
    // guessing would move a booking by a month.
    expect(textToDateString('09/10/2026')).toBeNull();
    expect(textToDateString('31-Feb-26')).toBeNull();
    expect(textToDateString('not a date')).toBeNull();
  });

  it('reads text times in the forms a plan sheet contains', () => {
    expect(textToTimeString('10:00')).toBe('10:00');
    expect(textToTimeString('10:00 AM')).toBe('10:00');
    expect(textToTimeString('1:30 pm')).toBe('13:30');
    expect(textToTimeString('12:00 AM')).toBe('00:00');
    expect(textToTimeString('12:00 PM')).toBe('12:00');
    expect(textToTimeString('25:00')).toBeNull();
  });

  /*
   * An OFF number is an identifier. Excel may hold it as a number, and reading
   * it as one loses a leading zero or turns it into exponent notation.
   */
  it('preserves identifiers as text rather than turning them into floats', () => {
    const offField = field({ fieldKey: 'off_no', label: 'OFF No.' });

    const asText: RawCell = { kind: 'text', text: '010662606B' };
    expect(cellToFieldValue(asText, offField)).toBe('010662606B');

    // Excel renders the number, and the rendered form is what survives.
    const asNumber: RawCell = { kind: 'number', value: 202601066, formatted: '202601066' };
    expect(cellToFieldValue(asNumber, offField)).toBe('202601066');

    const big: RawCell = { kind: 'number', value: 202601066123456, formatted: null };
    expect(cellToFieldValue(big, offField)).toBe('202601066123456');
  });

  it('reads numbers, stripping separators but never inventing one', () => {
    const qty = field({ fieldKey: 'qty', label: 'Qty', fieldType: 'NUMBER' });
    expect(cellToFieldValue({ kind: 'number', value: 4, formatted: '4' }, qty)).toBe(4);
    expect(cellToFieldValue({ kind: 'text', text: '1,500' }, qty)).toBe(1500);
    expect(cellToFieldValue({ kind: 'empty' }, qty)).toBeNull();
    // Not a number: the original text is returned so validation can quote it.
    expect(cellToFieldValue({ kind: 'text', text: '11/0.4' }, qty)).toBe('11/0.4');
  });

  it('trims whitespace and preserves Arabic', () => {
    const committee = field({ fieldKey: 'committee', label: 'Committee' });
    expect(cellToFieldValue({ kind: 'text', text: '  وطنية  ' }, committee)).toBe('وطنية');
  });

  it('reads a workbook whose dates and times are real serials', () => {
    const buffer = buildXlsxWithSerials([
      {
        Date: dateSerial('2026-09-09'),
        Time: timeSerial('10:00'),
        'OFF No.': '202601066',
        'Order Name': 'Transformer 2B',
        Committee: 'South Committee',
      },
    ]);
    const grid = parseUpload(upload(buffer, 'plan.xlsx'));

    const dateCell = grid.rows[0]?.[0];
    const timeCell = grid.rows[0]?.[1];
    expect(dateCell?.kind).toBe('serial');
    expect(timeCell?.kind).toBe('serial');

    expect(cellToFieldValue(dateCell!, PLAN_FIELDS[0]!)).toBe('2026-09-09');
    expect(cellToFieldValue(timeCell!, PLAN_FIELDS[1]!)).toBe('10:00');
  });
});

// ---------------------------------------------------------------------------
// Merged-cell carry-forward (spec §16)
// ---------------------------------------------------------------------------

describe('carry-forward for merged cells', () => {
  const columns = ['booking_date', 'booking_time', 'off_no', 'qty'];

  const cell = (text: string): RawCell => ({ kind: 'text', text });
  const empty: RawCell = { kind: 'empty' };

  it('fills a blank grouped value from the row above', () => {
    const filled = applyCarryForward(
      [
        [cell('2026-09-09'), cell('10:00'), cell('A1'), cell('1')],
        [empty, empty, empty, cell('2')],
      ],
      columns,
    );

    expect(filled[1]?.cells[0]).toEqual(cell('2026-09-09'));
    expect(filled[1]?.cells[1]).toEqual(cell('10:00'));
    expect(filled[1]?.cells[2]).toEqual(cell('A1'));
  });

  /*
   * Inheriting a value is a guess about layout. A merged sheet and a sheet with
   * a forgotten date look identical, so the row reports what it inherited and
   * the preview shows it rather than filling it in silently.
   */
  it('reports which fields it filled in', () => {
    const filled = applyCarryForward(
      [
        [cell('2026-09-09'), cell('10:00'), cell('A1'), cell('1')],
        [empty, empty, empty, cell('2')],
      ],
      columns,
    );

    expect(filled[0]?.carried).toEqual([]);
    expect(filled[1]?.carried).toEqual(['booking_date', 'booking_time', 'off_no']);
  });

  /*
   * The conservative half of §16. Carrying a blank Qty forward would invent a
   * quantity nobody wrote down, which is worse than leaving the cell empty.
   */
  it('never carries a value forward for a field that is not grouped', () => {
    const filled = applyCarryForward(
      [
        [cell('2026-09-09'), cell('10:00'), cell('A1'), cell('4')],
        [empty, empty, empty, empty],
      ],
      columns,
    );
    expect(filled[1]?.cells[3]).toEqual(empty);
    expect(filled[1]?.carried).not.toContain('qty');
  });

  it('stops carrying once a new value appears', () => {
    const filled = applyCarryForward(
      [
        [cell('2026-09-09'), cell('10:00'), cell('A1'), cell('1')],
        [empty, empty, empty, cell('2')],
        [cell('2026-09-10'), cell('13:00'), cell('B1'), cell('3')],
        [empty, empty, empty, cell('4')],
      ],
      columns,
    );

    expect(filled[3]?.cells[0]).toEqual(cell('2026-09-10'));
    expect(filled[3]?.cells[2]).toEqual(cell('B1'));
  });

  it('leaves an unmapped column alone', () => {
    const filled = applyCarryForward(
      [[cell('2026-09-09'), cell('x')], [empty, empty]],
      ['booking_date', null],
    );
    expect(filled[1]?.cells[1]).toEqual(empty);
  });
});

// ---------------------------------------------------------------------------
// Header mapping (spec §10, §11, §12)
// ---------------------------------------------------------------------------

describe('column mapping', () => {
  const rows: RawCell[][] = [
    [
      { kind: 'text', text: '2026-09-09' },
      { kind: 'text', text: '10:00' },
      { kind: 'text', text: '202601066' },
    ],
  ];

  it('matches the documented headers exactly', () => {
    const suggestions = suggestMapping(['Date', 'Time', 'OFF No.'], rows, PLAN_FIELDS);
    expect(suggestions.map((s) => s.suggestedFieldKey)).toEqual([
      'booking_date',
      'booking_time',
      'off_no',
    ]);
    expect(suggestions[0]?.confidence).toBe('exact');
  });

  it('ignores case, punctuation and spacing', () => {
    const suggestions = suggestMapping(['  date ', 'TIME', 'off no'], rows, PLAN_FIELDS);
    expect(suggestions.map((s) => s.suggestedFieldKey)).toEqual([
      'booking_date',
      'booking_time',
      'off_no',
    ]);
  });

  /*
   * The point of mapping on stable keys (§10): a plan manager renames the field
   * and yesterday's spreadsheets still import.
   */
  it('matches a renamed field by both its new label and its old one', () => {
    const renamed = PLAN_FIELDS.map((f) =>
      f.fieldKey === 'customer_name' ? { ...f, label: 'Client Name' } : f,
    );
    const sample: RawCell[][] = [[{ kind: 'text', text: 'Aweer' }]];

    expect(suggestMapping(['Client Name'], sample, renamed)[0]?.suggestedFieldKey).toBe('customer_name');
    // The historical label still resolves to the same stable key.
    expect(suggestMapping(['Customer Name'], sample, renamed)[0]?.suggestedFieldKey).toBe('customer_name');
    // As does the technical key itself.
    expect(suggestMapping(['customer_name'], sample, renamed)[0]?.suggestedFieldKey).toBe('customer_name');
  });

  it('leaves an unknown column for the user to decide', () => {
    const sample: RawCell[][] = [[{ kind: 'text', text: 'Ahmed' }]];
    const suggestion = suggestMapping(['Project Manager'], sample, PLAN_FIELDS)[0];
    expect(suggestion?.suggestedFieldKey).toBeNull();
    expect(suggestion?.reason).toMatch(/No Committee Plan field matches/i);
  });

  it('refuses to auto-map Day, which is derived from the date', () => {
    const sample: RawCell[][] = [[{ kind: 'text', text: 'Wednesday' }]];
    const suggestion = suggestMapping(['Day'], sample, PLAN_FIELDS)[0];
    expect(suggestion?.suggestedFieldKey).toBeNull();
    expect(suggestion?.reason).toMatch(/works the weekday out from the date/i);
  });

  /*
   * Auto-mapping a column whose values the field cannot hold would fail
   * validation on every row for a reason the user never saw coming, so the
   * importer declines to guess and says why (§12).
   *
   * KV used to be this test's example, back when it was a numeric column. It is
   * text now precisely because the plan's KV really does hold ratios — see the
   * `maps a KV column of voltage ratios` case below. Qty is the honest example:
   * a quantity is a number, and a column of ranges is not one.
   */
  it('withholds a suggestion when the column contradicts the field type', () => {
    const ranges: RawCell[][] = [
      [{ kind: 'text', text: '3 to 5' }],
      [{ kind: 'text', text: '2 or 3' }],
      [{ kind: 'text', text: 'one per bay' }],
    ];
    const suggestion = suggestMapping(['Qty'], ranges, PLAN_FIELDS)[0];

    expect(suggestion?.suggestedFieldKey).toBeNull();
    expect(suggestion?.reason).toMatch(/stores a number/i);
    expect(suggestion?.reason).toContain('3 to 5');
  });

  /*
   * The other half of the same rule: KV is a text field, so a column of voltage
   * ratios is exactly what it expects and maps without a question.
   */
  it('maps a KV column of voltage ratios', () => {
    const ratios: RawCell[][] = [
      [{ kind: 'text', text: '11/0.4' }],
      [{ kind: 'text', text: '22/0.4' }],
      [{ kind: 'text', text: '6.6/0.42' }],
    ];
    const suggestion = suggestMapping(['KV'], ratios, PLAN_FIELDS)[0];

    expect(suggestion?.suggestedFieldKey).toBe('kv');
    expect(suggestion?.reason).toBeNull();
  });

  it('still maps a numeric column that has one stray value', () => {
    const mostlyNumeric: RawCell[][] = [
      [{ kind: 'number', value: 1500, formatted: '1500' }],
      [{ kind: 'number', value: 1000, formatted: '1000' }],
      [{ kind: 'number', value: 800, formatted: '800' }],
      [{ kind: 'text', text: 'n/a' }],
    ];
    expect(suggestMapping(['KVA'], mostlyNumeric, PLAN_FIELDS)[0]?.suggestedFieldKey).toBe('kva');
  });


  /*
   * Legacy Status columns (confirmed with the business).
   *
   * Every Committee Plan sheet written before this correction has a column
   * headed `Status` holding transformer serial numbers, because that is what it
   * was being used for. Importing those into a field that now drives
   * cancellation would put the defect straight back — so the header is read for
   * what the sheet means by it, and what happened is stated in the preview
   * rather than done quietly.
   */
  describe('a legacy Status column', () => {
    const serials: RawCell[][] = [
      [{ kind: 'text', text: '010662606B-020662606B' }],
      [{ kind: 'text', text: 'DD-001600-022000-S289' }],
      [{ kind: 'text', text: 'invoice-040182515B' }],
    ];

    it('sends serial numbers to Serial No., and says why', () => {
      const suggestion = suggestMapping(['Status'], serials, PLAN_FIELDS)[0];

      expect(suggestion?.suggestedFieldKey).toBe('serial_no');
      expect(suggestion?.reason).toMatch(/serial numbers/i);
      // The reader is told what happens to the status itself, not left to guess.
      expect(suggestion?.reason).toMatch(/Planned/);
    });

    it('leaves a real status column unmapped rather than filing it as a serial', () => {
      const statuses: RawCell[][] = [
        [{ kind: 'text', text: 'Planned' }],
        [{ kind: 'text', text: 'Cancelled' }],
        [{ kind: 'text', text: 'Planned' }],
      ];

      const suggestion = suggestMapping(['Status'], statuses, PLAN_FIELDS)[0];

      expect(suggestion?.suggestedFieldKey).toBeNull();
      expect(suggestion?.reason).toMatch(/CommitteeFlow sets itself/i);
    });

    it('maps a column already headed Serial No. straight through', () => {
      const suggestion = suggestMapping(['Serial No.'], serials, PLAN_FIELDS)[0];

      expect(suggestion?.suggestedFieldKey).toBe('serial_no');
    });

    it('never offers a field the application writes as a destination', () => {
      const anything: RawCell[][] = [
        [{ kind: 'text', text: 'x' }, { kind: 'text', text: 'y' }],
      ];

      // Neither can be a target: one is set by cancelling, the other by signing
      // in, so a column mapped to either would fail on every row.
      const suggestions = suggestMapping(['Project Engineer', 'Whatever'], anything, PLAN_FIELDS);
      expect(suggestions.map((s) => s.suggestedFieldKey)).not.toContain('project_engineer');
      expect(suggestions.map((s) => s.suggestedFieldKey)).not.toContain('status');
    });
  });

  it('does not map two columns to the same field', () => {
    const sample: RawCell[][] = [[{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }]];
    const suggestions = suggestMapping(['Notes', 'Remarks'], sample, PLAN_FIELDS);
    expect(suggestions[0]?.suggestedFieldKey).toBe('notes');
    expect(suggestions[1]?.suggestedFieldKey).toBeNull();
    expect(suggestions[1]?.reason).toMatch(/already mapped/i);
  });

  it('carries sample values so the user can see what they are mapping', () => {
    const suggestion = suggestMapping(['OFF No.'], rows, PLAN_FIELDS)[2 - 2];
    expect(suggestion?.sampleValues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The real workbook (spec §36)
// ---------------------------------------------------------------------------

describe('the September plan workbook', () => {
  const real = realPlanWorkbook();

  it.runIf(real)('parses with the documented headers and real dates', () => {
    const grid = parseUpload(upload(real!.buffer, real!.filename));

    expect(grid.sheetName).toBe('CommitteeFlow_Import');
    expect(grid.headers).toEqual([
      'Date', 'Time', 'OFF No.', 'Order Name', 'Committee',
      'Qty', 'KVA', 'KV', 'Status', 'Notes', 'Customer Name',
    ]);
    expect(grid.rows.length).toBeGreaterThan(20);

    // The first row's date is 09-Sep-26 — not the 8th, which is what a
    // timezone-shifted read produces.
    expect(cellToFieldValue(grid.rows[0]![0]!, PLAN_FIELDS[0]!)).toBe('2026-09-09');
    expect(cellToFieldValue(grid.rows[0]![1]!, PLAN_FIELDS[1]!)).toBe('10:00');
    // The OFF number survives as a string.
    expect(cellToFieldValue(grid.rows[0]![2]!, PLAN_FIELDS[2]!)).toBe('202601066');
  });

  it.runIf(real)('contains Arabic committee names and future-month rows', () => {
    const grid = parseUpload(upload(real!.buffer, real!.filename));

    const committees = grid.rows
      .map((row) => row[4])
      .filter((cell): cell is Extract<RawCell, { kind: 'text' }> => cell?.kind === 'text')
      .map((cell) => cell.text);
    expect(committees.some((name) => /[\u0600-\u06FF]/.test(name))).toBe(true);

    const dates = grid.rows
      .map((row) => cellToFieldValue(row[0]!, PLAN_FIELDS[0]!))
      .filter((value): value is string => typeof value === 'string');
    expect(dates.some((date) => date.startsWith('2026-10'))).toBe(true);
  });

  it.runIf(real)('auto-maps its KV column of voltage ratios', () => {
    const grid = parseUpload(upload(real!.buffer, real!.filename));
    const suggestions = suggestMapping(grid.headers, grid.rows, PLAN_FIELDS);
    const kv = suggestions.find((s) => s.header === 'KV');

    expect(kv?.suggestedFieldKey).toBe('kv');

    // The ratio has to survive intact: `11/0.4` is one fact, and rounding it to
    // a number would lose the half of it that says what the unit steps down to.
    const kvIndex = kv!.index;
    const values = grid.rows
      .map((row) => cellToFieldValue(row[kvIndex]!, field({ fieldKey: 'kv', label: 'KV' })))
      .filter((value): value is string => typeof value === 'string');

    expect(values.some((value) => value.includes('/'))).toBe(true);
  });
});
