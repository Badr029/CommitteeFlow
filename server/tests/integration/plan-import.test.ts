import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/index.js';
import {
  Session,
  createUser,
  resetDatabase,
  signIn,
  testApp,
} from '../helpers/harness.js';
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

/**
 * Committee Plan import, end to end (spec §5, §27, §30, §32, §41, §45).
 *
 * Everything runs through the real HTTP stack, so session, CSRF, authorisation
 * and error handling are all exercised the way production runs them.
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function xlsx(rows: ReturnType<typeof validRow>[]): { filename: string; buffer: Buffer; contentType: string } {
  return {
    filename: 'CommitteeFlow_Import.xlsx',
    buffer: buildXlsx(sheetWith(rows)),
    contentType: XLSX_MIME,
  };
}

/** Uploads for preview and returns the parsed body. */
async function preview(session: Session, file: Parameters<Session['upload']>[1], fields: Record<string, string> = {}) {
  const res = await session.upload('/api/imports/preview', file, fields);
  return res;
}

describe('Committee Plan import', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    await resetDatabase();
  });

  // -------------------------------------------------------------------------
  // Authorisation (spec §4, §41)
  // -------------------------------------------------------------------------

  describe('authorisation', () => {
    it('lets a Project Engineer preview an import', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, xlsx([validRow()]));

      expect(res.status).toBe(200);
      expect(res.body.summary.total).toBe(1);
    });

    /*
     * The frontend also hides the button, but that is convenience. This is the
     * check that actually stops a Viewer importing.
     */
    it('refuses a Viewer, at the endpoint rather than only in the UI', async () => {
      const { session } = await signIn({ role: 'VIEWER' });
      const res = await preview(session, xlsx([validRow()]));

      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/Project Engineers/i);
    });

    it('refuses a Viewer at confirm as well', async () => {
      const engineer = await signIn({ role: 'PROJECT_ENGINEER' });
      const previewed = await preview(engineer.session, xlsx([validRow()]));
      const batchId = previewed.body.batchId as string;

      const viewer = await signIn({ role: 'VIEWER' });
      const res = await viewer.session.upload(`/api/imports/${batchId}/confirm`, xlsx([validRow()]), {
        rowIndexes: JSON.stringify([0]),
      });

      expect(res.status).toBe(403);
      expect(await bookingCount()).toBe(0);
    });

    it('refuses an unauthenticated request', async () => {
      const anonymous = await new Session(testApp()).bootstrap();
      const res = await anonymous.upload('/api/imports/preview', xlsx([validRow()]));
      expect(res.status).toBe(401);
    });

    it('refuses a request without a CSRF token', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await session.upload('/api/imports/preview', xlsx([validRow()]), {}, { csrf: false });
      expect(res.status).toBe(403);
    });

    it('will not let one engineer confirm another engineer’s upload', async () => {
      const first = await signIn({ role: 'PROJECT_ENGINEER' });
      const previewed = await preview(first.session, xlsx([validRow()]));

      const second = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await second.session.upload(
        `/api/imports/${previewed.body.batchId}/confirm`,
        xlsx([validRow()]),
        { rowIndexes: JSON.stringify([0]) },
      );

      expect(res.status).toBe(403);
      expect(await bookingCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Preview never writes (spec §5)
  // -------------------------------------------------------------------------

  describe('preview', () => {
    it('writes no booking, whatever the file contains', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, xlsx([validRow(), validRow({ 'OFF No.': '202601047' })]));

      expect(res.status).toBe(200);
      expect(res.body.summary.valid).toBe(2);
      // The whole point of the two-step flow.
      expect(await bookingCount()).toBe(0);
    });

    it('suggests the mapping and reports the detected columns', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, xlsx([validRow()]));

      expect(res.body.mapping).toMatchObject({
        Date: 'booking_date',
        Time: 'booking_time',
        'OFF No.': 'off_no',
        'Order Name': 'order_name',
        Committee: 'committee',
      });
      expect(res.body.columns).toHaveLength(11);
    });

    it('classifies rows as valid, warning or error', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(
        session,
        xlsx([
          validRow(),
          // Optional field blank — a warning, not a refusal.
          validRow({ 'OFF No.': '202601047', 'Customer Name': '' }),
          // An unreadable date — an error. A *blank* date would be inherited
          // from the row above by design (§16), so it would not test this.
          validRow({ 'OFF No.': '202601049', Date: 'not a date' }),
        ]),
      );

      expect(res.body.summary).toMatchObject({ total: 3, errors: 1 });

      const rows = res.body.rows as Array<{ status: string; issues: Array<{ message: string }> }>;
      expect(rows[2]?.status).toBe('error');
      // Present but unreadable, so the message names the format rather than
      // claiming the field is missing.
      expect(rows[2]?.issues.some((issue) => /Date must be a valid date/i.test(issue.message))).toBe(
        true,
      );
    });

    /*
     * Merged cells arrive as blanks under the value they were merged with, so
     * the blank is filled from above — and the row says so, rather than the
     * importer inventing a date silently (§16).
     */
    it('inherits a blank grouped value and flags that it did', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [
        validRow({ 'OFF No.': 'A1', Date: '2026-09-09', Time: '10:00' }),
        validRow({ 'OFF No.': 'A2', Date: '', Time: '' }),
      ];

      const res = await preview(session, xlsx(rows));
      const second = (res.body.rows as Array<{ status: string; values: Record<string, unknown>; issues: Array<{ message: string }> }>)[1];

      expect(second?.values['booking_date']).toBe('2026-09-09');
      expect(second?.status).toBe('warning');
      expect(second?.issues.some((issue) => /taken from the row above/i.test(issue.message))).toBe(true);
    });

    it('names the source row so an error can be found in the file', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, xlsx([validRow(), validRow({ Date: 'not a date' })]));

      const rows = res.body.rows as Array<{ sourceRowNumber: number; status: string }>;
      // Header is row 1, so the second data row is row 3.
      expect(rows[1]?.sourceRowNumber).toBe(3);
      expect(rows[1]?.status).toBe('error');
    });

    it('reads a CSV with Arabic, quoted commas and embedded newlines', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, {
        filename: 'plan.csv',
        buffer: realisticCsv(),
        contentType: 'text/csv',
      });

      expect(res.status).toBe(200);
      expect(res.body.summary.total).toBe(6);

      const values = (res.body.rows as Array<{ values: Record<string, unknown> }>).map((r) => r.values);
      expect(values[0]?.['customer_name']).toBe('وطنية');
      expect(values[1]?.['order_name']).toBe('Cable box, HV, 22kV');
      expect(values[4]?.['notes']).toContain('\n');
    });

    it('reads a legacy .xls workbook', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, {
        filename: 'plan.xls',
        buffer: buildXls(sheetWith([validRow()])),
        contentType: 'application/vnd.ms-excel',
      });

      expect(res.status).toBe(200);
      expect(res.body.summary.valid).toBe(1);
    });

    it('reads real Excel date and time serials as calendar values', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, {
        filename: 'plan.xlsx',
        buffer: buildXlsxWithSerials([
          {
            Date: dateSerial('2026-09-09'),
            Time: timeSerial('10:00'),
            'OFF No.': '202601066',
            'Order Name': 'Transformer 2B',
            Committee: 'South Committee',
          },
        ]),
        contentType: XLSX_MIME,
      });

      const values = (res.body.rows as Array<{ values: Record<string, unknown> }>)[0]?.values;
      expect(values?.['booking_date']).toBe('2026-09-09');
      expect(values?.['booking_time']).toBe('10:00');
    });

    it('refuses a PDF without parsing it', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const res = await preview(session, {
        filename: 'plan.pdf',
        buffer: Buffer.from('%PDF-1.7\ncontent'),
        contentType: 'application/pdf',
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/structured spreadsheets only/i);
    });

    /** No stack, no path, no parser internals (spec §22, §41). */
    it('reports a corrupted workbook cleanly', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const corrupt = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('definitely not a workbook'),
      ]);
      const res = await preview(session, {
        filename: 'plan.xlsx',
        buffer: corrupt,
        contentType: XLSX_MIME,
      });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/could not be read/i);
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.(ts|js):\d+/);
      expect(JSON.stringify(res.body)).not.toMatch(/node_modules/);
    });
  });

  // -------------------------------------------------------------------------
  // Shared Committee Sessions (spec §18, §46, §78.1)
  // -------------------------------------------------------------------------

  describe('shared committee sessions', () => {
    /*
     * The rule this feature most easily gets wrong. Four projects at the same
     * date, time and committee is the normal shape of a plan, not a conflict.
     */
    it('accepts many rows sharing one Date + Time + Committee', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = ['202601066', '202601047', '202501261', '202601142'].map((off) =>
        validRow({ 'OFF No.': off, Date: '2026-09-10', Time: '10:00', Committee: 'South Committee' }),
      );

      const previewed = await preview(session, xlsx(rows));
      expect(previewed.body.summary.errors).toBe(0);
      expect(previewed.body.summary.valid).toBe(4);

      const confirmed = await session.upload(
        `/api/imports/${previewed.body.batchId}/confirm`,
        xlsx(rows),
        { rowIndexes: JSON.stringify([0, 1, 2, 3]) },
      );

      expect(confirmed.status).toBe(201);
      expect(confirmed.body.importedRows).toBe(4);

      const stored = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM bookings
          WHERE booking_date = '2026-09-10' AND booking_time = '10:00' AND committee = 'South Committee'`,
      );
      expect(stored.rows[0]?.count).toBe('4');
    });

    it('does not flag a shared session as a duplicate', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      // One booking already in the session, with a different project.
      const first = validRow({ 'OFF No.': '202601066', Date: '2026-09-10', Time: '10:00' });
      const previewed = await preview(session, xlsx([first]));
      await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx([first]), {
        rowIndexes: JSON.stringify([0]),
      });

      // A different OFF number in the same session must be new, not duplicate.
      const second = validRow({ 'OFF No.': '202601047', Date: '2026-09-10', Time: '10:00' });
      const again = await preview(session, xlsx([second]));

      expect(again.body.summary.duplicates).toBe(0);
      expect(again.body.rows[0].duplicate).toBeNull();
      expect(again.body.rows[0].status).not.toBe('error');
    });

    /** Repeated OFF numbers are multiple technical lines, not duplicates (§17). */
    it('keeps several technical lines of one order', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [
        validRow({ 'OFF No.': '202501018', Qty: 1, KVA: 1000 }),
        validRow({ 'OFF No.': '202501018', Qty: 2, KVA: 2000 }),
        validRow({ 'OFF No.': '202501018', Qty: 3, KVA: 1500 }),
      ];

      const previewed = await preview(session, xlsx(rows));
      expect(previewed.body.summary.total).toBe(3);
      expect(previewed.body.summary.errors).toBe(0);

      const confirmed = await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(rows), {
        rowIndexes: JSON.stringify([0, 1, 2]),
      });
      expect(confirmed.body.importedRows).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate detection (spec §24, §25)
  // -------------------------------------------------------------------------

  describe('possible duplicates', () => {
    it('warns without blocking when the same order is already in the plan', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const row = validRow({ 'OFF No.': '202601066', Date: '2026-09-10', Time: '10:00', Qty: 4, KVA: 1500 });

      const first = await preview(session, xlsx([row]));
      await session.upload(`/api/imports/${first.body.batchId}/confirm`, xlsx([row]), {
        rowIndexes: JSON.stringify([0]),
      });

      const second = await preview(session, xlsx([row]));
      const previewRow = second.body.rows[0];

      expect(previewRow.duplicate).not.toBeNull();
      expect(previewRow.status).toBe('warning');
      expect(previewRow.duplicate.message).toMatch(/already in the plan/i);

      // A warning is never a refusal — the user decides.
      const confirmed = await session.upload(`/api/imports/${second.body.batchId}/confirm`, xlsx([row]), {
        rowIndexes: JSON.stringify([0]),
      });
      expect(confirmed.status).toBe(201);
      expect(await bookingCount()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Confirm: transaction, audit, provenance, notification
  // -------------------------------------------------------------------------

  describe('confirm', () => {
    it('imports only the selected rows', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [
        validRow({ 'OFF No.': 'A1' }),
        validRow({ 'OFF No.': 'A2' }),
        validRow({ 'OFF No.': 'A3' }),
      ];

      const previewed = await preview(session, xlsx(rows));
      const confirmed = await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(rows), {
        rowIndexes: JSON.stringify([0, 2]),
      });

      expect(confirmed.body.importedRows).toBe(2);
      const stored = await query<{ off_no: string }>('SELECT off_no FROM bookings ORDER BY off_no');
      expect(stored.rows.map((r) => r.off_no)).toEqual(['A1', 'A3']);
    });

    /** A row with a hard error is never written, whatever the request asks for. */
    it('refuses to import a row that has an error', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [validRow(), validRow({ 'OFF No.': 'A2', Date: 'not a date' })];

      const previewed = await preview(session, xlsx(rows));
      const confirmed = await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(rows), {
        rowIndexes: JSON.stringify([0, 1]),
      });

      expect(confirmed.status).toBe(201);
      expect(confirmed.body.importedRows).toBe(1);
      expect(await bookingCount()).toBe(1);
    });

    it('marks imported bookings with their source and batch', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const previewed = await preview(session, xlsx([validRow()]));
      const batchId = previewed.body.batchId as string;

      await session.upload(`/api/imports/${batchId}/confirm`, xlsx([validRow()]), {
        rowIndexes: JSON.stringify([0]),
      });

      const stored = await query<{ data_source: string; import_batch_id: string; created_by: string }>(
        'SELECT data_source, import_batch_id, created_by FROM bookings',
      );
      expect(stored.rows[0]?.data_source).toBe('IMPORT');
      expect(stored.rows[0]?.import_batch_id).toBe(batchId);
      expect(stored.rows[0]?.created_by).toBe(user.id);
    });

    /** An imported booking has the same history a typed one does (spec §30). */
    it('records booking history for every imported row', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [validRow({ 'OFF No.': 'A1' }), validRow({ 'OFF No.': 'A2' })];

      const previewed = await preview(session, xlsx(rows));
      await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(rows), {
        rowIndexes: JSON.stringify([0, 1]),
      });

      const history = await query<{ action: string; actor_id: string }>(
        'SELECT action, actor_id FROM booking_history',
      );
      expect(history.rows).toHaveLength(2);
      expect(history.rows.every((row) => row.action === 'CREATE')).toBe(true);
      expect(history.rows.every((row) => row.actor_id === user.id)).toBe(true);
    });

    /*
     * The headline notification rule (spec §32): forty rows must not become
     * forty emails.
     */
    it('queues exactly one summary notification, not one per booking', async () => {
      await createUser({ role: 'PROJECT_ENGINEER', email: 'watcher@committeeflow.test' });
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });

      const rows = Array.from({ length: 8 }, (_, index) => validRow({ 'OFF No.': `A${index}` }));
      const previewed = await preview(session, xlsx(rows));
      await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(rows), {
        rowIndexes: JSON.stringify(rows.map((_, index) => index)),
      });

      const outbox = await query<{ event_type: string; booking_id: string | null; subject: string }>(
        'SELECT event_type, booking_id, subject FROM email_outbox',
      );

      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0]?.event_type).toBe('PLAN_IMPORTED');
      // A summary describes the plan, not one booking.
      expect(outbox.rows[0]?.booking_id).toBeNull();
      expect(outbox.rows[0]?.subject).toMatch(/8 bookings imported/i);
    });

    it('records the batch, its counts and the dates it touched', async () => {
      const { session, user } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [
        validRow({ 'OFF No.': 'A1', Date: '2026-09-09' }),
        validRow({ 'OFF No.': 'A2', Date: '2026-10-05' }),
      ];

      const previewed = await preview(session, xlsx(rows));
      const confirmed = await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(rows), {
        rowIndexes: JSON.stringify([0, 1]),
      });

      expect(confirmed.body.batch).toMatchObject({
        status: 'COMPLETED',
        fileType: 'XLSX',
        importedRows: 2,
        totalRows: 2,
        firstBookingDate: '2026-09-09',
        lastBookingDate: '2026-10-05',
      });
      expect(confirmed.body.batch.uploadedBy.id).toBe(user.id);
      expect(confirmed.body.batch.originalFilename).toBe('CommitteeFlow_Import.xlsx');
      expect(confirmed.body.batch.completedAt).not.toBeNull();
    });

    it('will not import the same batch twice', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const previewed = await preview(session, xlsx([validRow()]));
      const batchId = previewed.body.batchId as string;

      const first = await session.upload(`/api/imports/${batchId}/confirm`, xlsx([validRow()]), {
        rowIndexes: JSON.stringify([0]),
      });
      expect(first.status).toBe(201);

      const second = await session.upload(`/api/imports/${batchId}/confirm`, xlsx([validRow()]), {
        rowIndexes: JSON.stringify([0]),
      });
      expect(second.status).toBe(400);
      expect(second.body.error.message).toMatch(/already been imported/i);
      expect(await bookingCount()).toBe(1);
    });

    /*
     * Confirm re-parses and re-validates rather than trusting the client's copy
     * of the preview. Without that, a crafted request could write values that
     * never passed validation.
     */
    it('re-validates on confirm instead of trusting the request', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const good = [validRow({ 'OFF No.': 'A1' })];
      const previewed = await preview(session, xlsx(good));

      // Confirm with a file whose row has since become invalid.
      const tampered = [validRow({ 'OFF No.': 'A1', Date: 'not a date' })];
      const res = await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx(tampered), {
        rowIndexes: JSON.stringify([0]),
      });

      expect(res.status).toBe(400);
      expect(await bookingCount()).toBe(0);
    });

    /** Nothing is written when the whole batch cannot be (spec §27). */
    it('rolls back completely when the import fails', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const rows = [validRow({ 'OFF No.': 'A1' }), validRow({ 'OFF No.': 'A2' })];
      const previewed = await preview(session, xlsx(rows));
      const batchId = previewed.body.batchId as string;

      // Force the second insert to fail at the database, after the first has
      // already been written inside the transaction.
      await query(`
        CREATE OR REPLACE FUNCTION reject_second_import() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NEW.off_no = 'A2' THEN RAISE EXCEPTION 'simulated failure'; END IF;
          RETURN NEW;
        END $fn$;
      `);
      await query(`
        CREATE TRIGGER reject_second_import_trigger
        BEFORE INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION reject_second_import();
      `);

      try {
        const res = await session.upload(`/api/imports/${batchId}/confirm`, xlsx(rows), {
          rowIndexes: JSON.stringify([0, 1]),
        });
        expect(res.status).toBeGreaterThanOrEqual(500);

        // Neither booking survives — not even the one that inserted cleanly.
        expect(await bookingCount()).toBe(0);
        const history = await query('SELECT 1 FROM booking_history');
        expect(history.rowCount).toBe(0);
        const outbox = await query('SELECT 1 FROM email_outbox');
        expect(outbox.rowCount).toBe(0);

        // The batch is left FAILED rather than PENDING forever.
        const batch = await query<{ status: string }>('SELECT status FROM import_batches WHERE id = $1', [
          batchId,
        ]);
        expect(batch.rows[0]?.status).toBe('FAILED');
      } finally {
        await query('DROP TRIGGER IF EXISTS reject_second_import_trigger ON bookings');
        await query('DROP FUNCTION IF EXISTS reject_second_import()');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Import history (spec §34)
  // -------------------------------------------------------------------------

  describe('import history', () => {
    it('lists past imports and can show one', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const previewed = await preview(session, xlsx([validRow()]));
      await session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx([validRow()]), {
        rowIndexes: JSON.stringify([0]),
      });

      const list = await session.get('/api/imports');
      expect(list.status).toBe(200);
      expect(list.body.batches).toHaveLength(1);
      expect(list.body.batches[0].status).toBe('COMPLETED');

      const one = await session.get(`/api/imports/${previewed.body.batchId}`);
      expect(one.status).toBe(200);
      expect(one.body.importedRows).toBe(1);
    });

    /** Audit information — a Viewer may read it, just not create it. */
    it('lets a Viewer read import history', async () => {
      const engineer = await signIn({ role: 'PROJECT_ENGINEER' });
      const previewed = await preview(engineer.session, xlsx([validRow()]));
      await engineer.session.upload(`/api/imports/${previewed.body.batchId}/confirm`, xlsx([validRow()]), {
        rowIndexes: JSON.stringify([0]),
      });

      const viewer = await signIn({ role: 'VIEWER' });
      const res = await viewer.session.get('/api/imports');
      expect(res.status).toBe(200);
      expect(res.body.batches).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The real workbook (spec §36)
  // -------------------------------------------------------------------------

  describe('the September plan workbook', () => {
    const real = realPlanWorkbook();

    it.runIf(real)('previews, and imports the rows that pass validation', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      const file = {
        filename: real!.filename,
        buffer: real!.buffer,
        contentType: XLSX_MIME,
      };

      const previewed = await preview(session, file);
      expect(previewed.status).toBe(200);
      expect(previewed.body.sheetName).toBe('CommitteeFlow_Import');
      expect(previewed.body.summary.total).toBeGreaterThan(20);
      // KV holds ratios like "11/0.4"; the field stores text, so it maps.
      expect(previewed.body.mapping['KV']).toBe('kv');

      const importable = (previewed.body.rows as Array<{ index: number; status: string }>)
        .filter((row) => row.status !== 'error')
        .map((row) => row.index);
      expect(importable.length).toBeGreaterThan(0);

      const confirmed = await session.upload(
        `/api/imports/${previewed.body.batchId}/confirm`,
        file,
        { rowIndexes: JSON.stringify(importable) },
      );

      expect(confirmed.status).toBe(201);
      expect(confirmed.body.importedRows).toBe(importable.length);

      // Arabic committee names survive the round trip.
      const arabic = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM bookings WHERE committee ~ '[\\u0600-\\u06FF]'`,
      );
      expect(Number(arabic.rows[0]?.count ?? '0')).toBeGreaterThan(0);

      // And so do the voltage ratios, intact rather than rounded to a number.
      const ratios = await query<{ count: string }>(
        "SELECT count(*)::text AS count FROM bookings WHERE kv LIKE '%/%'",
      );
      expect(Number(ratios.rows[0]?.count ?? '0')).toBeGreaterThan(0);
    });
  });
});

async function bookingCount(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*)::text AS count FROM bookings');
  return Number(res.rows[0]?.count ?? '0');
}
