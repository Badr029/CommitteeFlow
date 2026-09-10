import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { closePool } from '../../src/db/pool.js';
import { createBookingVia, resetDatabase, signIn } from '../helpers/harness.js';
import { findRun, readPdf } from '../helpers/pdf.js';

/** Spec §18 — exports are snapshots driven by the plan configuration. */
describe('exports', () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    await closePool();
  });

  async function readWorkbook(body: Buffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(body as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet('Committee Plan');
    if (!sheet) throw new Error('worksheet missing');
    return sheet;
  }

  it('produces a real .xlsx with the configured headers', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
    await createBookingVia(session, { off_no: '202601066', customer_name: 'Aweer' });

    const res = await session.getBinary('/api/export/excel?month=2026-10');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('committee-plan-2026-10.xlsx');

    const sheet = await readWorkbook(res.body as Buffer);
    const headers = (sheet.getRow(3).values as unknown[]).slice(1);
    expect(headers).toEqual([
      'Date',
      'Day',
      'Time',
      'OFF No.',
      'Order Name',
      'Committee',
      'Qty',
      'KVA',
      'KV',
      'Status',
      'Serial No.',
      'Project Engineer',
      'Notes',
      'Customer Name',
    ]);

    const first = (sheet.getRow(4).values as unknown[]).slice(1);
    expect(first[0]).toBe('2026-10-06');
    expect(first[1]).toBe('Tuesday');
    expect(first[3]).toBe('202601066');
  });

  it('follows a rename, a hide and a reorder', async () => {
    const { session } = await signIn({
      role: 'PROJECT_ENGINEER',
      canManagePlanConfiguration: true,
    });
    await createBookingVia(session);

    const fields = (await session.get('/api/plan-fields')).body.fields;
    const byKey = (key: string) => fields.find((f: { fieldKey: string }) => f.fieldKey === key);

    await session.patch(`/api/plan-fields/${byKey('customer_name').id}`, { label: 'Client Name' });
    await session.patch(`/api/plan-fields/${byKey('kva').id}`, { isVisible: false });
    await session.post('/api/plan-fields/reorder', {
      order: [byKey('committee').id, byKey('booking_date').id, byKey('booking_time').id],
    });

    const res = await session.getBinary('/api/export/excel?month=2026-10');
    const sheet = await readWorkbook(res.body as Buffer);
    const headers = (sheet.getRow(3).values as unknown[]).slice(1) as string[];

    expect(headers[0]).toBe('Committee');
    expect(headers[1]).toBe('Date');
    expect(headers[2]).toBe('Day');
    expect(headers).toContain('Client Name');
    expect(headers).not.toContain('Customer Name');
    expect(headers).not.toContain('KVA');
  });

  it('includes a custom field once it is configured', async () => {
    const { session } = await signIn({
      role: 'PROJECT_ENGINEER',
      canManagePlanConfiguration: true,
    });
    await session.post('/api/plan-fields', {
      fieldKey: 'project_manager',
      label: 'Project Manager',
      fieldType: 'TEXT',
    });
    await createBookingVia(session, { project_manager: 'Mohamed Ali' });

    const sheet = await readWorkbook(
      (await session.getBinary('/api/export/excel?month=2026-10')).body as Buffer,
    );

    const headers = (sheet.getRow(3).values as unknown[]).slice(1) as string[];
    expect(headers).toContain('Project Manager');
    const row = (sheet.getRow(4).values as unknown[]).slice(1);
    expect(row).toContain('Mohamed Ali');
  });

  it('keeps numbers as numbers so Excel can total them', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
    await createBookingVia(session, { qty: 3, kva: 1500, kv: '11/0.4' });

    const sheet = await readWorkbook(
      (await session.getBinary('/api/export/excel?month=2026-10')).body as Buffer,
    );

    const row = (sheet.getRow(4).values as unknown[]).slice(1);
    expect(row[6]).toBe(3);
    expect(row[7]).toBe(1500);
    // KV is a ratio, so it stays text — totalling it would be meaningless.
    expect(row[8]).toBe('11/0.4');
  });

  it('produces a real PDF', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
    await createBookingVia(session);

    const res = await session.getBinary('/api/export/pdf?month=2026-10');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('committee-plan-2026-10.pdf');
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  /*
   * The PDF is the controlled form the plan is circulated on, so its shape is
   * part of the contract, not a rendering detail.
   *
   * These read the finished document through a real PDF reader rather than by
   * scraping the content stream: once a font is embedded — which it must be, to
   * hold Arabic — the page contains glyph ids, and recovering words from them is
   * exactly the job a reader does. Asserting on anything less would be asserting
   * on what we meant to draw.
   */
  describe('the printed form', () => {
    it('carries the form title, code and revision', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session);

      const pdf = await readPdf((await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer);

      expect(pdf.text).toContain('Committee Plan for October 2026');
      expect(pdf.text).toContain('Code : PM-FR-01-02-D');
      expect(pdf.text).toContain('Rev: (0)');
      expect(pdf.text).toMatch(/page 1 of \d+/);
    });

    it("uses the source form's own colours", async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session);

      const pdf = await readPdf((await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer);

      expect(pdf.fills).toContain('#FFFF00'); // title band
      expect(pdf.fills).toContain('#00B050'); // column headings
      expect(pdf.fills).toContain('#83CCEB'); // the Time column
    });

    it('prints every day of the month, booked or not', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, { booking_date: '2026-10-06' });

      const pdf = await readPdf((await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer);

      // The 1st has nothing booked on it and still appears: a free committee
      // day is a fact about the month, not an absence from it.
      expect(pdf.text).toContain('2026-10-01');
      expect(pdf.text).toContain('2026-10-06');
      expect(pdf.text).toContain('2026-10-31');
    });

    it('names the day beside its date', async () => {
      const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
      await createBookingVia(session, { booking_date: '2026-10-06' });

      const pdf = await readPdf((await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer);

      expect(pdf.text).toContain('Day');
      expect(pdf.text).toContain('Tuesday'); // 2026-10-06
    });


    /*
     * BUG-014. The committee names in the real plan are bilingual, and the
     * standard PDF fonts are Latin-1: `وطنية` used to reach the page as eight
     * bytes of printable Latin that read as corrupted data rather than as a
     * missing glyph.
     *
     * Ordering is pinned exactly in tests/unit/pdf-text.test.ts, and how the
     * letters actually join is checked against a browser by
     * qa/tools/compare-rtl.mjs. What is asserted here is the part that broke:
     * that the characters survive the trip into the document at all.
     */
    describe('Arabic committee names (BUG-014)', () => {
      it('puts the committee on the page as the characters it was given', async () => {
        const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
        await createBookingVia(session, { committee: 'وطنية' });

        const pdf = await readPdf(
          (await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer,
        );

        expect(findRun(pdf, 'وطنية')).toBeDefined();
      });

      it('leaves no character it could not encode', async () => {
        const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
        await createBookingVia(session, {
          committee: 'شركة جنوب القاهرة',
          order_name: 'محول 1500 KVA',
          customer_name: 'وطنية',
        });

        const pdf = await readPdf(
          (await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer,
        );

        // The replacement character is what a reader shows for a glyph the
        // document cannot map back to a codepoint.
        expect(pdf.text).not.toContain('\uFFFD');
        expect(findRun(pdf, 'شركة جنوب القاهرة')).toBeDefined();
        expect(findRun(pdf, 'محول 1500 KVA')).toBeDefined();
      });

      it('keeps an OFF number inside Arabic reading forwards', async () => {
        const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
        await createBookingVia(session, { committee: 'وطنية 202601066' });

        const pdf = await readPdf(
          (await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer,
        );

        // The symptom of a run reversed wholesale: the digits come out mirrored.
        expect(pdf.text).toContain('202601066');
        expect(pdf.text).not.toContain('660106202');
      });

      it('serialises a serial-number-shaped value without mangling it', async () => {
        const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
        await createBookingVia(session, {
          committee: 'وطنية',
          serial_no: 'DD-001600-022000-S289',
        });

        const pdf = await readPdf(
          (await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer,
        );

        // Long enough to wrap inside its column, which is fine — what matters
        // is that no character of it was lost or reordered on the way.
        expect(pdf.packed).toContain('DD-001600-022000-S289');
      });

      it('does not change an English-only export', async () => {
        const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
        await createBookingVia(session, {
          committee: 'North Committee',
          order_name: 'Aweer Feeder Pillar',
          customer_name: 'Dubai Municipality',
        });

        const pdf = await readPdf(
          (await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer,
        );

        // Latin runs come back verbatim, in one piece, exactly as before.
        expect(pdf.items.some((item) => item.text === 'Aweer Feeder Pillar')).toBe(true);
        expect(pdf.items.some((item) => item.text === 'North Committee')).toBe(true);
        expect(pdf.text).toContain('Committee Plan for October 2026');
      });
    });

    it('follows a renamed plan field, with no second column list', async () => {
      const { session } = await signIn({
        role: 'PROJECT_ENGINEER',
        canManagePlanConfiguration: true,
      });
      await createBookingVia(session);

      const fields = (await session.get('/api/plan-fields')).body.fields;
      const customerName = fields.find(
        (field: { fieldKey: string }) => field.fieldKey === 'customer_name',
      );
      await session.patch(`/api/plan-fields/${customerName.id}`, { label: 'Client Name' });

      const pdf = await readPdf((await session.getBinary('/api/export/pdf?month=2026-10')).body as Buffer);

      expect(pdf.text).toContain('Client Name');
      expect(pdf.text).not.toContain('Customer Name');
    });
  });

  it('exports an empty month without failing', async () => {
    const { session } = await signIn({ role: 'VIEWER' });

    const excel = await session.getBinary('/api/export/excel?month=2026-12');
    const pdf = await session.getBinary('/api/export/pdf?month=2026-12');

    expect(excel.status).toBe(200);
    expect(pdf.status).toBe(200);
    const sheet = await readWorkbook(excel.body as Buffer);
    expect(sheet.rowCount).toBe(3);
  });

  it('respects the same filters as the plan view', async () => {
    const { session } = await signIn({ role: 'PROJECT_ENGINEER' });
    await createBookingVia(session, { off_no: 'N1', committee: 'North' });
    await createBookingVia(session, { off_no: 'S1', committee: 'South', booking_time: '14:00' });

    const sheet = await readWorkbook(
      (await session.getBinary('/api/export/excel?month=2026-10&committee=South')).body as Buffer,
    );

    expect(sheet.rowCount).toBe(4);
    expect((sheet.getRow(4).values as unknown[]).slice(1)).toContain('S1');
  });

  it('is available to a viewer', async () => {
    const { session: engineer } = await signIn({ role: 'PROJECT_ENGINEER' });
    await createBookingVia(engineer);
    const { session: viewer } = await signIn({ role: 'VIEWER' });

    expect((await viewer.getBinary('/api/export/excel?month=2026-10')).status).toBe(200);
    expect((await viewer.getBinary('/api/export/pdf?month=2026-10')).status).toBe(200);
  });
});
