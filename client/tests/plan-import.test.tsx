import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportPreviewResponse } from '@shared/api-types';
import { PlanPage } from '@/features/plan/PlanPage';
import {
  ApiStub,
  booking,
  bookingListResponse,
  defaultPlanFields,
  renderWithProviders,
  session,
} from './harness';
import { setViewportWidth } from './setup';

/**
 * Committee Plan import, from the user's side (spec §46 frontend coverage).
 *
 * The preview response is stubbed at the network boundary, so these exercise
 * the real component tree, the real query client and the real error mapping —
 * the parsing itself is covered by the server suite, which is where it lives.
 */

function previewResponse(overrides: Partial<ImportPreviewResponse> = {}): ImportPreviewResponse {
  return {
    batchId: '11111111-1111-4111-8111-111111111111',
    filename: 'CommitteeFlow_Import.xlsx',
    fileType: 'XLSX',
    fileSizeBytes: 8868,
    sheetName: 'CommitteeFlow_Import',
    availableSheets: ['CommitteeFlow_Import', 'Import_Notes'],
    truncated: false,
    columns: [
      {
        header: 'Date',
        index: 0,
        suggestedFieldKey: 'booking_date',
        confidence: 'exact',
        reason: null,
        sampleValues: ['2026-09-09'],
      },
      {
        header: 'OFF No.',
        index: 1,
        suggestedFieldKey: 'off_no',
        confidence: 'exact',
        reason: null,
        sampleValues: ['202601066'],
      },
    ],
    mapping: { Date: 'booking_date', 'OFF No.': 'off_no' },
    fields: defaultPlanFields().map((field) => ({
      fieldKey: field.fieldKey,
      label: field.label,
      isRequired: field.isRequired,
      fieldType: field.fieldType,
    })),
    rows: [
      {
        index: 0,
        sourceRowNumber: 2,
        status: 'valid',
        issues: [],
        values: {
          booking_date: '2026-09-09',
          booking_time: '10:00',
          off_no: '202601066',
          order_name: 'Transformer 2B',
          committee: 'South Committee',
        },
        display: { booking_date: '09-Sep-26', off_no: '202601066' },
        duplicate: null,
      },
      {
        index: 1,
        sourceRowNumber: 3,
        status: 'warning',
        issues: [
          {
            fieldKey: 'customer_name',
            label: 'Customer Name',
            message: 'Customer Name is empty.',
            severity: 'warning',
          },
        ],
        values: {
          booking_date: '2026-09-09',
          booking_time: '10:00',
          off_no: '202601047',
          order_name: 'HV Cable Box',
          committee: 'South Committee',
        },
        display: { off_no: '202601047' },
        duplicate: null,
      },
      {
        index: 2,
        sourceRowNumber: 14,
        status: 'error',
        issues: [
          {
            fieldKey: 'booking_date',
            label: 'Date',
            message: 'Date must be a valid date (YYYY-MM-DD).',
            severity: 'error',
          },
        ],
        values: { off_no: '202601049' },
        display: { off_no: '202601049', booking_date: 'not a date' },
        duplicate: null,
      },
    ],
    summary: { total: 3, valid: 1, warnings: 1, errors: 1, duplicates: 0 },
    ...overrides,
  };
}

function xlsxFile(name = 'CommitteeFlow_Import.xlsx'): File {
  return new File(['fake-workbook-bytes'], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('Committee Plan import', () => {
  let api: ApiStub;

  beforeEach(() => {
    api = new ApiStub();
    setViewportWidth(1280);
  });

  function stubPlan(role: 'PROJECT_ENGINEER' | 'VIEWER' = 'PROJECT_ENGINEER') {
    api
      .on('GET', '/api/auth/session', { body: session(role) })
      .on('GET', '/api/plan-fields', { body: { fields: defaultPlanFields() } })
      .on('GET', '/api/settings', { body: session('VIEWER').settings })
      .on('GET', '/api/bookings', { body: bookingListResponse([booking()]) });
    api.install();
  }

  /** `fetch` is stubbed globally by the harness; multipart goes through it too. */
  function stubUpload(response: unknown, status = 200) {
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/imports')) {
          return new Response(JSON.stringify(response), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return original(input, init);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Role (spec §4)
  // -------------------------------------------------------------------------

  describe('who can import', () => {
    it('offers Import Plan to a Project Engineer, beside the exports', async () => {
      stubPlan('PROJECT_ENGINEER');
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      const button = await screen.findByRole('button', { name: /Import Plan/i });
      expect(button).toBeInTheDocument();
      // Import and Export are the two ends of the same job, so they sit together.
      expect(screen.getByRole('button', { name: /Excel/i })).toBeInTheDocument();
    });

    it('shows a Viewer no import control at all, disabled or otherwise', async () => {
      stubPlan('VIEWER');
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await screen.findByText('Transformer 2B');
      expect(screen.queryByRole('button', { name: /Import Plan/i })).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Upload (spec §6)
  // -------------------------------------------------------------------------

  describe('choosing a file', () => {
    it('states the supported formats and that nothing imports yet', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getAllByText(/Excel \(\.xlsx, \.xls\) or CSV \(\.csv\)/i).length,
      ).toBeGreaterThan(0);
      expect(within(dialog).getByText(/Nothing is imported until you confirm/i)).toBeInTheDocument();
    });

    it('refuses a PDF before it is ever uploaded', async () => {
      stubPlan();
      // `accept` filters the picker, but a user can choose "All files" and pick
      // a PDF anyway — which is the path this guard exists for.
      const user = userEvent.setup({ applyAccept: false });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));
      const dialog = await screen.findByRole('dialog');

      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      // `accept` is a filter in the picker, not a guarantee — a user can choose
      // "All files" and pick a PDF, which is the path this guard exists for.
      await user.upload(input, new File(['%PDF-1.7'], 'plan.pdf', { type: 'application/pdf' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /PDF is not supported.*structured spreadsheets only/i,
      );
    });

    it('refuses an unsupported spreadsheet-adjacent format', async () => {
      stubPlan();
      const user = userEvent.setup({ applyAccept: false });
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));
      const dialog = await screen.findByRole('dialog');
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;

      await user.upload(input, new File(['x'], 'plan.ods', { type: 'application/octet-stream' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(/\.ods files are not supported/i);
    });
  });

  // -------------------------------------------------------------------------
  // Preview (spec §20, §21, §22)
  // -------------------------------------------------------------------------

  describe('preview', () => {
    async function openPreview(response = previewResponse()) {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');
      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));

      const dialog = await screen.findByRole('dialog');
      stubUpload(response);
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, xlsxFile());
      return { user, dialog };
    }

    it('summarises what was detected before anything is written', async () => {
      await openPreview();

      await screen.findByText(/rows will be imported/i);
      expect(screen.getByText('Detected')).toBeInTheDocument();
      // "Valid" is both a summary figure and a filter, so match the figure.
      expect(screen.getAllByText('Valid').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Warnings').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Errors').length).toBeGreaterThan(0);
    });

    it('shows the normalized values, not the raw cells', async () => {
      await openPreview();

      await screen.findByText(/rows will be imported/i);
      // The cell said "09-Sep-26"; the plan will store 2026-09-09. Two rows
      // share the date because they share a Committee Session.
      expect(screen.getAllByText('2026-09-09').length).toBe(2);
    });

    it('names the source row and the problem for a bad row', async () => {
      await openPreview();

      await screen.findByText(/rows will be imported/i);
      expect(screen.getByText('14')).toBeInTheDocument();
      expect(screen.getByText(/Date must be a valid date/i)).toBeInTheDocument();
      // A parser exception is never shown to a user (§22).
      expect(screen.queryByText(/node_modules|at Object\./i)).not.toBeInTheDocument();
    });

    it('filters rows by category', async () => {
      const { user, dialog } = await openPreview();
      await screen.findByText(/rows will be imported/i);

      // Scoped to the drawer: the plan table behind it holds a booking with the
      // same order name, which is exactly the sort of collision a global query
      // would quietly pass on.
      await user.click(within(dialog).getByRole('button', { name: /^Errors/ }));
      expect(within(dialog).getByText(/Date must be a valid date/i)).toBeInTheDocument();
      expect(within(dialog).queryByText('Transformer 2B')).not.toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /^Valid/ }));
      expect(within(dialog).queryByText(/Date must be a valid date/i)).not.toBeInTheDocument();
      expect(within(dialog).getByText('Transformer 2B')).toBeInTheDocument();
    });

    /** Errors are never importable, so the count excludes them (§26). */
    it('offers to import only the rows that can be imported', async () => {
      await openPreview();
      await screen.findByText(/rows will be imported/i);

      expect(
        screen.getByRole('button', { name: /Import 2 bookings/i }),
      ).toBeInTheDocument();
    });

    it('reports a rejected upload without leaking internals', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');
      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));

      const dialog = await screen.findByRole('dialog');
      stubUpload(
        { error: { code: 'BAD_REQUEST', message: 'That .xlsx file is not a valid Excel workbook.' } },
        400,
      );
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, xlsxFile());

      expect(await screen.findByText(/not a valid Excel workbook/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Mapping (spec §11, §12)
  // -------------------------------------------------------------------------

  describe('column mapping', () => {
    it('asks for a decision when the importer would not guess', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');
      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));

      const dialog = await screen.findByRole('dialog');
      stubUpload(
        previewResponse({
          columns: [
            {
              header: 'Date',
              index: 0,
              suggestedFieldKey: 'booking_date',
              confidence: 'exact',
              reason: null,
              sampleValues: ['2026-09-09'],
            },
            {
              header: 'KV',
              index: 1,
              suggestedFieldKey: null,
              confidence: 'uncertain',
              reason: 'KV stores a number, but this column holds values like “11/0.4”.',
              sampleValues: ['11/0.4', '22/0.4'],
            },
          ],
          mapping: { Date: 'booking_date', KV: null },
        }),
      );
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, xlsxFile());

      // The mapping step opens because a column needs a decision.
      // Singular here: exactly one column could not be matched confidently.
      expect(await screen.findByText(/1 column needs a decision/i)).toBeInTheDocument();
      expect(screen.getByText(/KV stores a number/i)).toBeInTheDocument();
      expect(screen.getByText('11/0.4 · 22/0.4')).toBeInTheDocument();

      // And it can be sent somewhere, or left out.
      const select = screen.getByLabelText(/Committee Plan field for the KV column/i);
      expect(within(select).getByRole('option', { name: /Do not import/i })).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Confirm and result (spec §26, §34)
  // -------------------------------------------------------------------------

  describe('confirming', () => {
    it('imports the valid rows and reports what happened', async () => {
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');
      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));

      const dialog = await screen.findByRole('dialog');
      stubUpload(previewResponse());
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, xlsxFile());

      await screen.findByText(/rows will be imported/i);

      stubUpload({
        batch: {
          id: '11111111-1111-4111-8111-111111111111',
          originalFilename: 'CommitteeFlow_Import.xlsx',
          fileType: 'XLSX',
          fileSizeBytes: 8868,
          sheetName: 'CommitteeFlow_Import',
          status: 'COMPLETED',
          columnMapping: {},
          totalRows: 3,
          validRows: 1,
          warningRows: 1,
          errorRows: 1,
          importedRows: 2,
          skippedRows: 1,
          firstBookingDate: '2026-09-09',
          lastBookingDate: '2026-09-09',
          failureReason: null,
          uploadedBy: { id: 'user-1', name: 'Ahmed Hassan', email: 'ahmed@committeeflow.test' },
          uploadedAt: '2026-09-10T09:00:00.000Z',
          completedAt: '2026-09-10T09:00:05.000Z',
        },
        importedRows: 2,
        skippedRows: 1,
      });

      await user.click(screen.getByRole('button', { name: /Import 2 bookings/i }));

      expect(await screen.findByText(/2 bookings imported/i)).toBeInTheDocument();
      expect(screen.getByText('CommitteeFlow_Import.xlsx')).toBeInTheDocument();
      // The bulk-notification promise is stated where it is made (§32).
      expect(screen.getByText(/one summary email.*not one per booking/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Mobile (spec §35)
  // -------------------------------------------------------------------------

  describe('on a phone', () => {
    it('shows preview rows as cards rather than a table', async () => {
      setViewportWidth(375);
      stubPlan();
      const user = userEvent.setup();
      renderWithProviders(<PlanPage />, '/plan?month=2026-09&past=1');

      await user.click(await screen.findByRole('button', { name: /Import Plan/i }));
      const dialog = await screen.findByRole('dialog');
      stubUpload(previewResponse());
      const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
      await user.upload(input, xlsxFile());

      await screen.findByText(/rows will be imported/i);

      // The desktop table is exactly what does not fit at 375px.
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.getByText('Row 2')).toBeInTheDocument();
      expect(screen.getByText('Row 14')).toBeInTheDocument();
    });
  });
});
