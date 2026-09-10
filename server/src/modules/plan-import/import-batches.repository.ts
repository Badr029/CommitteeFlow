import type { Queryable } from '../../db/index.js';
import { queryOne, queryRows } from '../../db/index.js';
import type { ImportFileType } from './file-guard.js';

/**
 * Import batch persistence.
 *
 * A batch is the provenance record for one upload: what file it was, who
 * uploaded it, what the mapping was, and what the confirmed import actually
 * did. The uploaded bytes are never stored — only the outcome (§28).
 */

export type ImportBatchStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ImportBatchRecord {
  id: string;
  originalFilename: string;
  fileType: ImportFileType;
  fileSizeBytes: number;
  sheetName: string | null;
  status: ImportBatchStatus;
  columnMapping: Record<string, string | null>;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  importedRows: number;
  skippedRows: number;
  firstBookingDate: string | null;
  lastBookingDate: string | null;
  failureReason: string | null;
  uploadedBy: { id: string; name: string; email: string };
  uploadedAt: string;
  completedAt: string | null;
}

interface BatchRow {
  id: string;
  original_filename: string;
  file_type: ImportFileType;
  file_size_bytes: number;
  sheet_name: string | null;
  status: ImportBatchStatus;
  column_mapping: Record<string, string | null>;
  total_rows: number;
  valid_rows: number;
  warning_rows: number;
  error_rows: number;
  imported_rows: number;
  skipped_rows: number;
  first_booking_date: Date | string | null;
  last_booking_date: Date | string | null;
  failure_reason: string | null;
  uploaded_by: string;
  uploader_name: string;
  uploader_email: string;
  uploaded_at: Date;
  completed_at: Date | null;
}

const SELECT_BATCH = `
  SELECT b.id,
         b.original_filename,
         b.file_type,
         b.file_size_bytes,
         b.sheet_name,
         b.status,
         b.column_mapping,
         b.total_rows,
         b.valid_rows,
         b.warning_rows,
         b.error_rows,
         b.imported_rows,
         b.skipped_rows,
         b.first_booking_date,
         b.last_booking_date,
         b.failure_reason,
         b.uploaded_by,
         u.name  AS uploader_name,
         u.email AS uploader_email,
         b.uploaded_at,
         b.completed_at
    FROM import_batches b
    JOIN users u ON u.id = b.uploaded_by
`;

/** Dates come back from `pg` as `Date` for `date` columns; keep them calendar. */
function toDateString(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
    value.getUTCDate(),
  ).padStart(2, '0')}`;
}

function toRecord(row: BatchRow): ImportBatchRecord {
  return {
    id: row.id,
    originalFilename: row.original_filename,
    fileType: row.file_type,
    fileSizeBytes: row.file_size_bytes,
    sheetName: row.sheet_name,
    status: row.status,
    columnMapping: row.column_mapping ?? {},
    totalRows: row.total_rows,
    validRows: row.valid_rows,
    warningRows: row.warning_rows,
    errorRows: row.error_rows,
    importedRows: row.imported_rows,
    skippedRows: row.skipped_rows,
    firstBookingDate: toDateString(row.first_booking_date),
    lastBookingDate: toDateString(row.last_booking_date),
    failureReason: row.failure_reason,
    uploadedBy: { id: row.uploaded_by, name: row.uploader_name, email: row.uploader_email },
    uploadedAt: row.uploaded_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

export interface CreateBatchInput {
  originalFilename: string;
  fileType: ImportFileType;
  fileSizeBytes: number;
  sheetName: string | null;
  columnMapping: Record<string, string | null>;
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;
  uploadedBy: string;
}

export async function createBatch(
  input: CreateBatchInput,
  tx: Queryable,
): Promise<ImportBatchRecord> {
  const created = await queryOne<{ id: string }>(
    `INSERT INTO import_batches (
       original_filename, file_type, file_size_bytes, sheet_name, column_mapping,
       total_rows, valid_rows, warning_rows, error_rows, uploaded_by
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.originalFilename,
      input.fileType,
      input.fileSizeBytes,
      input.sheetName,
      JSON.stringify(input.columnMapping),
      input.totalRows,
      input.validRows,
      input.warningRows,
      input.errorRows,
      input.uploadedBy,
    ],
    tx,
  );
  if (!created) throw new Error('import batch insert returned no row');

  const batch = await findById(created.id, tx);
  if (!batch) throw new Error('import batch disappeared immediately after insert');
  return batch;
}

export interface CompleteBatchInput {
  id: string;
  importedRows: number;
  skippedRows: number;
  firstBookingDate: string | null;
  lastBookingDate: string | null;
}

export async function completeBatch(
  input: CompleteBatchInput,
  tx: Queryable,
): Promise<ImportBatchRecord> {
  await queryOne(
    `UPDATE import_batches
        SET status = 'COMPLETED',
            imported_rows = $2,
            skipped_rows = $3,
            first_booking_date = $4::date,
            last_booking_date = $5::date,
            completed_at = now()
      WHERE id = $1`,
    [input.id, input.importedRows, input.skippedRows, input.firstBookingDate, input.lastBookingDate],
    tx,
  );

  const batch = await findById(input.id, tx);
  if (!batch) throw new Error('import batch disappeared during completion');
  return batch;
}

/**
 * Marks a batch failed.
 *
 * Runs on its own connection, deliberately: the transaction that was inserting
 * the bookings has already rolled back, so writing this inside it would be
 * rolled back too and the batch would be left PENDING forever (§27).
 */
export async function failBatch(id: string, reason: string): Promise<void> {
  await queryOne(
    `UPDATE import_batches
        SET status = 'FAILED', failure_reason = $2, completed_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [id, reason.slice(0, 2000)],
  );
}

export async function findById(id: string, executor?: Queryable): Promise<ImportBatchRecord | null> {
  const row = await queryOne<BatchRow>(`${SELECT_BATCH} WHERE b.id = $1`, [id], executor);
  return row ? toRecord(row) : null;
}

export async function listRecent(limit: number, offset: number): Promise<{
  batches: ImportBatchRecord[];
  hasMore: boolean;
}> {
  // One extra row answers "is there another page" without a second count query.
  const rows = await queryRows<BatchRow>(
    `${SELECT_BATCH} ORDER BY b.uploaded_at DESC LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );
  const hasMore = rows.length > limit;
  return { batches: rows.slice(0, limit).map(toRecord), hasMore };
}
