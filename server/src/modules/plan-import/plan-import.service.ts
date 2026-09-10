import { z } from 'zod';
import type { PlanFieldValue } from '@shared/api-types.js';
import { withTransaction } from '../../db/index.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { addMonths, endOfMonth, isAfter, today } from '../../lib/dates.js';
import type { UserRecord } from '../users/users.repository.js';
import * as usersRepository from '../users/users.repository.js';
import { getSettings } from '../plan-config/settings.service.js';
import * as planFields from '../plan-config/plan-fields.repository.js';
import { isReadOnlyFieldKey } from '../plan-config/field-keys.js';
import type { PlanFieldRecord } from '../plan-config/plan-fields.repository.js';
import { recordBookingHistory } from '../audit/booking-history.repository.js';
import { enqueueEmail } from '../notifications/outbox.repository.js';
import { buildImportPayload, buildSubject } from '../notifications/templates.js';
import * as bookingsRepository from '../bookings/bookings.repository.js';
import {
  ValueValidationError,
  normalizeBookingValues,
} from '../bookings/booking-values.js';
import { checkUpload, type CheckedUpload } from './file-guard.js';
import { parseUpload, type RawCell, type SheetGrid } from './parse.js';
import { suggestMapping, type ColumnSuggestion } from './mapping.js';
import { applyCarryForward, cellToFieldValue, cellToText } from './normalize.js';
import { findPossibleDuplicates, type DuplicateMatch } from './duplicates.js';
import * as batches from './import-batches.repository.js';

/**
 * Committee Plan import (§5).
 *
 * The workflow is upload → parse → map → validate → preview → confirm, and the
 * split matters: the upload endpoint never writes a booking. The user sees what
 * CommitteeFlow understood before any of it becomes plan data, because a
 * spreadsheet is somebody else's document and parsing it always involves
 * inference.
 *
 * Nothing about a booking's *rules* lives here. Requiredness, types, lengths
 * and select options are all read from Plan Configuration through the same
 * `normalizeBookingValues` the booking form uses (§19), so an imported booking
 * cannot enter the plan in a state a typed one could not.
 */

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export type RowStatus = 'valid' | 'warning' | 'error';

export interface RowIssue {
  fieldKey: string | null;
  label: string;
  message: string;
  severity: 'warning' | 'error';
}

export interface PreviewRow {
  /** Index into the preview's own row list; what confirm refers to. */
  index: number;
  /** 1-based row in the uploaded sheet, for "Row 14". */
  sourceRowNumber: number;
  status: RowStatus;
  issues: RowIssue[];
  /** Normalized values keyed by field key — what CommitteeFlow will store. */
  values: Record<string, PlanFieldValue>;
  /** Rendered for the table, using each field's configured label. */
  display: Record<string, string>;
  duplicate: DuplicateMatch | null;
}

export interface PreviewSummary {
  total: number;
  valid: number;
  warnings: number;
  errors: number;
  duplicates: number;
}

export interface ImportPreview {
  batchId: string;
  filename: string;
  fileType: CheckedUpload['type'];
  fileSizeBytes: number;
  sheetName: string;
  availableSheets: string[];
  truncated: boolean;
  columns: ColumnSuggestion[];
  /** The mapping actually used, {header: fieldKey|null}. */
  mapping: Record<string, string | null>;
  fields: Array<{ fieldKey: string; label: string; isRequired: boolean; fieldType: string }>;
  rows: PreviewRow[];
  summary: PreviewSummary;
}

export const previewMappingSchema = z
  .record(z.string(), z.union([z.string(), z.null()]))
  .optional();

/**
 * Parses and validates an upload without writing a single booking.
 *
 * A PENDING batch row is created so the preview has a stable id the confirm
 * step can refer to, and so an upload that is previewed but never confirmed
 * still leaves a trace of having happened.
 */
export async function previewImport(
  file: { originalname: string; mimetype: string; buffer: Buffer },
  options: { sheet?: string | undefined; mapping?: Record<string, string | null> | undefined },
  actor: UserRecord,
): Promise<ImportPreview> {
  assertMayImport(actor);

  const upload = checkUpload(file);
  const grid = parseUpload(upload, options.sheet);

  const activeFields = await planFields.listActive();
  const suggestions = suggestMapping(grid.headers, grid.rows, activeFields);
  const mapping = resolveMapping(grid, suggestions, options.mapping, activeFields);

  const evaluated = await evaluateRows(grid, mapping, activeFields);

  const batch = await withTransaction(async (tx) =>
    batches.createBatch(
      {
        originalFilename: upload.filename,
        fileType: upload.type,
        fileSizeBytes: upload.sizeBytes,
        sheetName: grid.sheetName,
        columnMapping: mapping,
        totalRows: evaluated.rows.length,
        validRows: evaluated.summary.valid,
        warningRows: evaluated.summary.warnings,
        errorRows: evaluated.summary.errors,
        uploadedBy: actor.id,
      },
      tx,
    ),
  );

  logger.info(
    {
      batchId: batch.id,
      actorId: actor.id,
      rows: evaluated.rows.length,
      errors: evaluated.summary.errors,
      fileType: upload.type,
    },
    'plan import previewed',
  );

  return {
    batchId: batch.id,
    filename: upload.filename,
    fileType: upload.type,
    fileSizeBytes: upload.sizeBytes,
    sheetName: grid.sheetName,
    availableSheets: grid.availableSheets,
    truncated: grid.truncated,
    columns: suggestions,
    mapping,
    fields: activeFields
      .filter((field) => !isReadOnlyFieldKey(field.fieldKey))
      .map((field) => ({
      fieldKey: field.fieldKey,
      label: field.label,
      isRequired: field.isRequired,
      fieldType: field.fieldType,
    })),
    rows: evaluated.rows,
    summary: evaluated.summary,
  };
}

/**
 * Which column feeds which field.
 *
 * A mapping supplied by the user wins outright — that is the whole point of the
 * mapping step. Anything they did not speak to falls back to the suggestion,
 * and an unknown or duplicated destination is refused rather than quietly
 * dropped, because silently ignoring a mapping the user chose would put their
 * data somewhere they did not ask for.
 */
function resolveMapping(
  grid: SheetGrid,
  suggestions: readonly ColumnSuggestion[],
  supplied: Record<string, string | null> | undefined,
  activeFields: readonly PlanFieldRecord[],
): Record<string, string | null> {
  const validKeys = new Set(activeFields.map((field) => field.fieldKey));
  const mapping: Record<string, string | null> = {};
  const used = new Map<string, string>();

  for (const suggestion of suggestions) {
    const header = suggestion.header;
    const chosen =
      supplied && Object.prototype.hasOwnProperty.call(supplied, header)
        ? supplied[header] ?? null
        : suggestion.suggestedFieldKey;

    if (chosen === null || chosen === undefined || chosen === '') {
      mapping[header] = null;
      continue;
    }

    if (!validKeys.has(chosen)) {
      throw badRequest(
        `“${chosen}” is not a field on the current Committee Plan. Choose a different destination for the “${header}” column.`,
      );
    }

    const already = used.get(chosen);
    if (already !== undefined) {
      throw badRequest(
        `Both “${already}” and “${header}” are mapped to the same field. Each Committee Plan field can take only one column.`,
      );
    }

    used.set(chosen, header);
    mapping[header] = chosen;
  }

  // A file with no usable columns at all is a wasted round trip for the user.
  if (Object.values(mapping).every((value) => value === null)) {
    throw badRequest(
      `None of the columns in “${grid.sheetName}” are mapped to a Committee Plan field. Check that the first row names the columns.`,
    );
  }

  return mapping;
}

interface EvaluatedRows {
  rows: PreviewRow[];
  summary: PreviewSummary;
}

async function evaluateRows(
  grid: SheetGrid,
  mapping: Record<string, string | null>,
  activeFields: readonly PlanFieldRecord[],
): Promise<EvaluatedRows> {
  const fieldByKey = new Map(activeFields.map((field) => [field.fieldKey, field]));

  // Column position → field key, so carry-forward and value reading agree.
  const columnFieldKeys = grid.headers.map((header) => mapping[header] ?? null);
  const filled = applyCarryForward(grid.rows, columnFieldKeys);

  const horizonLimit = await futureHorizonLimit();
  const populatedOptional = findPopulatedOptionalFields(filled, columnFieldKeys, activeFields);

  const rows: PreviewRow[] = [];
  for (let index = 0; index < filled.length; index += 1) {
    const carried = filled[index];
    rows.push(
      evaluateRow({
        index,
        sourceRowNumber: grid.sourceRowNumbers[index] ?? index + 2,
        cells: carried?.cells ?? [],
        carriedKeys: carried?.carried ?? [],
        columnFieldKeys,
        fieldByKey,
        activeFields,
        horizonLimit,
        populatedOptional,
      }),
    );
  }

  // Duplicate detection is one query for the whole sheet, not one per row.
  const matches = await findPossibleDuplicates(rows.map((row) => row.values));
  for (const row of rows) {
    const match = matches.get(row.index) ?? null;
    if (!match) continue;

    /*
     * A duplicate is carried on `duplicate`, not pushed into `issues`.
     *
     * It is the one finding that comes with an action — skip it, or import it
     * anyway — so the UI renders it as its own block. Adding it to `issues` as
     * well printed the same sentence twice on every affected row.
     *
     * The status still moves to `warning`, which is what the summary counts and
     * the filter read.
     */
    row.duplicate = match;
    if (row.status !== 'error') row.status = 'warning';
  }

  const summary: PreviewSummary = {
    total: rows.length,
    valid: rows.filter((row) => row.status === 'valid').length,
    warnings: rows.filter((row) => row.status === 'warning').length,
    errors: rows.filter((row) => row.status === 'error').length,
    duplicates: rows.filter((row) => row.duplicate !== null).length,
  };

  return { rows, summary };
}

/**
 * Optional fields the sheet actually carries data for.
 *
 * Warning on every blank optional cell would drown the summary: a real plan
 * leaves Notes and Customer Name empty on most rows, so "34 warnings" would
 * mean nothing and hide the rows that genuinely need a look. A blank is only
 * worth flagging when the *rest of the column* is filled — that is a row
 * missing something its neighbours have, which is what §20 is actually about.
 */
function findPopulatedOptionalFields(
  rows: readonly { cells: RawCell[] }[],
  columnFieldKeys: readonly (string | null)[],
  activeFields: readonly PlanFieldRecord[],
): ReadonlySet<string> {
  const optional = new Set(
    activeFields.filter((field) => !field.isRequired).map((field) => field.fieldKey),
  );
  const populated = new Set<string>();

  for (const row of rows) {
    for (let column = 0; column < columnFieldKeys.length; column += 1) {
      const fieldKey = columnFieldKeys[column];
      if (!fieldKey || !optional.has(fieldKey) || populated.has(fieldKey)) continue;
      const cell = row.cells[column];
      if (cell && cell.kind !== 'empty') populated.add(fieldKey);
    }
  }

  return populated;
}

async function futureHorizonLimit(): Promise<string | null> {
  const { bookingFutureHorizonMonths } = await getSettings();
  if (bookingFutureHorizonMonths === null) return null;
  return endOfMonth(addMonths(today(), bookingFutureHorizonMonths));
}

function evaluateRow(input: {
  index: number;
  sourceRowNumber: number;
  cells: readonly RawCell[];
  /** Fields whose value was inherited from the row above (§16). */
  carriedKeys: readonly string[];
  columnFieldKeys: readonly (string | null)[];
  fieldByKey: ReadonlyMap<string, PlanFieldRecord>;
  activeFields: readonly PlanFieldRecord[];
  horizonLimit: string | null;
  populatedOptional: ReadonlySet<string>;
}): PreviewRow {
  const submitted: Record<string, PlanFieldValue> = {};
  const display: Record<string, string> = {};

  for (let column = 0; column < input.columnFieldKeys.length; column += 1) {
    const fieldKey = input.columnFieldKeys[column];
    if (!fieldKey) continue;
    const field = input.fieldByKey.get(fieldKey);
    const cell = input.cells[column];
    if (!field || !cell) continue;

    const value = cellToFieldValue(cell, field);
    if (value !== null) submitted[fieldKey] = value;
    display[fieldKey] = cellToText(cell) ?? '';
  }

  const issues: RowIssue[] = [];

  // The one and only source of validation rules (§19).
  let normalizedFlat: Record<string, PlanFieldValue> = {};
  try {
    normalizedFlat = normalizeBookingValues(submitted, input.activeFields, { mode: 'create' }).flat;
  } catch (error) {
    if (!(error instanceof ValueValidationError)) throw error;
    for (const issue of error.issues) {
      const field = issue.field ? input.fieldByKey.get(issue.field) : undefined;
      issues.push({
        fieldKey: issue.field ?? null,
        label: field?.label ?? issue.field ?? 'Row',
        message: issue.message,
        severity: 'error',
      });
    }
  }

  // The booking-date horizon is a service rule rather than a field rule, so it
  // is applied here to match what createBooking would do (§9, §78.3).
  const bookingDate = normalizedFlat['booking_date'];
  if (input.horizonLimit && typeof bookingDate === 'string' && isAfter(bookingDate, input.horizonLimit)) {
    issues.push({
      fieldKey: 'booking_date',
      label: input.fieldByKey.get('booking_date')?.label ?? 'Date',
      message: `Bookings can only be made through ${input.horizonLimit}. Change the date, or extend the horizon in Plan Configuration.`,
      severity: 'error',
    });
  }

  if (issues.every((issue) => issue.severity !== 'error')) {
    // An inherited value is never silent: a merged sheet and a sheet with a
    // forgotten date are indistinguishable here, so the row says which values
    // came from above and the user decides whether that is right (§16).
    for (const fieldKey of input.carriedKeys) {
      const field = input.fieldByKey.get(fieldKey);
      if (!field) continue;
      issues.push({
        fieldKey,
        label: field.label,
        message: `${field.label} was blank and taken from the row above.`,
        severity: 'warning',
      });
    }

    // Optional fields left blank are worth surfacing without blocking (§20) —
    // but only where the column carries data on other rows.
    for (const field of input.activeFields) {
      if (field.isRequired || !field.isVisible) continue;
      if (!input.populatedOptional.has(field.fieldKey)) continue;
      const value = normalizedFlat[field.fieldKey];
      if (value === null || value === undefined || value === '') {
        issues.push({
          fieldKey: field.fieldKey,
          label: field.label,
          message: `${field.label} is empty.`,
          severity: 'warning',
        });
      }
    }
  }

  const hasError = issues.some((issue) => issue.severity === 'error');
  const status: RowStatus = hasError ? 'error' : issues.length > 0 ? 'warning' : 'valid';

  return {
    index: input.index,
    sourceRowNumber: input.sourceRowNumber,
    status,
    issues,
    values: hasError ? submitted : normalizedFlat,
    display,
    duplicate: null,
  };
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export const confirmImportSchema = z.object({
  /** Preview row indexes the user chose to import. */
  rowIndexes: z.array(z.number().int().min(0)).min(1).max(5000),
  sheet: z.string().max(200).optional(),
  mapping: previewMappingSchema,
});

export interface ImportResult {
  batch: batches.ImportBatchRecord;
  importedRows: number;
  skippedRows: number;
}

/**
 * Inserts the confirmed rows, in one transaction (§27).
 *
 * The file is re-parsed here rather than the preview's rows being trusted from
 * the client. That is the difference between "the server validated this" and
 * "the client says the server validated this" — without it, a crafted confirm
 * request could write values that never passed validation. It costs one parse
 * of a file we already know is small and safe.
 */
export async function confirmImport(
  batchId: string,
  file: { originalname: string; mimetype: string; buffer: Buffer },
  input: z.infer<typeof confirmImportSchema>,
  actor: UserRecord,
): Promise<ImportResult> {
  assertMayImport(actor);

  const existing = await batches.findById(batchId);
  if (!existing) throw notFound('That import no longer exists. Upload the file again.');
  if (existing.status !== 'PENDING') {
    throw badRequest(
      existing.status === 'COMPLETED'
        ? 'That file has already been imported. Upload it again if you need to import it a second time.'
        : 'That import can no longer be confirmed. Upload the file again.',
    );
  }
  if (existing.uploadedBy.id !== actor.id) {
    throw forbidden('Only the person who uploaded a file can import it.');
  }

  const upload = checkUpload(file);
  const grid = parseUpload(upload, input.sheet ?? existing.sheetName ?? undefined);
  const activeFields = await planFields.listActive();
  const suggestions = suggestMapping(grid.headers, grid.rows, activeFields);
  // The mapping recorded at preview time is authoritative unless the request
  // supplies one, so confirming cannot quietly re-map columns.
  const mapping = resolveMapping(
    grid,
    suggestions,
    input.mapping ?? existing.columnMapping,
    activeFields,
  );

  const evaluated = await evaluateRows(grid, mapping, activeFields);
  const wanted = new Set(input.rowIndexes);

  const selected = evaluated.rows.filter((row) => wanted.has(row.index));
  if (selected.length === 0) {
    throw badRequest('None of the selected rows are still in that file. Upload it again.');
  }

  // A row that has become invalid since the preview is never written, whatever
  // the request asks for.
  const importable = selected.filter((row) => row.status !== 'error');
  if (importable.length === 0) {
    throw badRequest('None of the selected rows can be imported — every one of them has an error.');
  }

  const settings = await getSettings();
  const recipients = await usersRepository.listNotificationRecipients(settings.notificationAudience);

  const dates = importable
    .map((row) => row.values['booking_date'])
    .filter((value): value is string => typeof value === 'string')
    .sort();

  try {
    const result = await withTransaction(async (tx) => {
      let imported = 0;

      for (const row of importable) {
        const normalized = normalizeBookingValues(row.values, activeFields, { mode: 'create' });

        const created = await bookingsRepository.insert(
          {
            columns: normalized.columns,
            customFields: normalized.customFields,
            actorId: actor.id,
            dataSource: 'IMPORT',
            importBatchId: batchId,
          },
          tx,
        );

        // Imported bookings get the same history a typed one does (§30), so
        // "who created this" is answerable identically for both.
        await recordBookingHistory(
          {
            bookingId: created.id,
            action: 'CREATE',
            actorId: actor.id,
            oldValues: null,
            newValues: normalized.flat,
            changedKeys: Object.keys(normalized.flat),
            bookingVersion: created.version,
          },
          tx,
        );

        imported += 1;
      }

      const completed = await batches.completeBatch(
        {
          id: batchId,
          importedRows: imported,
          skippedRows: evaluated.rows.length - imported,
          firstBookingDate: dates[0] ?? null,
          lastBookingDate: dates[dates.length - 1] ?? null,
        },
        tx,
      );

      // One summary message for the whole import, never one per row (§32).
      const payload = buildImportPayload(completed, actor.name);
      await enqueueEmail(
        {
          eventType: 'PLAN_IMPORTED',
          bookingId: null,
          recipients,
          subject: buildSubject(payload),
          payload: payload as unknown as Record<string, unknown>,
        },
        tx,
      );

      return completed;
    });

    logger.info(
      { batchId, actorId: actor.id, imported: result.importedRows, skipped: result.skippedRows },
      'plan import completed',
    );

    return {
      batch: result,
      importedRows: result.importedRows,
      skippedRows: result.skippedRows,
    };
  } catch (error) {
    // The transaction is already rolled back; record the failure outside it so
    // the batch does not sit PENDING forever (§27).
    await batches
      .failBatch(batchId, error instanceof Error ? error.message : 'Unknown import failure')
      .catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function getBatch(id: string): Promise<batches.ImportBatchRecord> {
  const batch = await batches.findById(id);
  if (!batch) throw notFound('That import does not exist.');
  return batch;
}

export async function listBatches(page: number, limit: number) {
  return batches.listRecent(limit, (page - 1) * limit);
}

/**
 * Write authorisation, re-checked in the service (§42, §4).
 *
 * The route guards this too. Both exist on purpose: the route is the perimeter,
 * this is the object-level check that survives a future caller that forgets it.
 */
function assertMayImport(actor: UserRecord): void {
  if (actor.role !== 'PROJECT_ENGINEER') {
    throw forbidden('Only Project Engineers can import a Committee Plan.');
  }
}
