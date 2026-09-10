-- Up Migration
--
-- Committee Plan import from Excel / CSV.
--
-- Imported bookings are ordinary bookings: same table, same validation, same
-- history, same lifecycle. What is added here is provenance — which file a
-- booking arrived in, who uploaded it, and what that upload did as a whole —
-- so an imported row is never indistinguishable from a hand-entered one.
--
-- Deliberately NOT added:
--   * no UNIQUE key on (booking_date, booking_time, committee). That triple is
--     a shared Committee Session (§46, §78.1), and an import routinely brings
--     several projects into one session. Duplicate detection is advisory and
--     lives in the importer, never in a constraint.
--   * no storage of the uploaded workbook. The file is parsed in memory and
--     discarded; only the normalized rows the user confirmed are kept, as
--     bookings.

CREATE TYPE import_batch_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE import_file_type AS ENUM ('XLSX', 'XLS', 'CSV');

CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Kept for display and audit only. Never used to build a filesystem path:
  -- the file is only ever held in memory (§7).
  original_filename text NOT NULL
                      CONSTRAINT import_batches_filename_len CHECK (char_length(original_filename) <= 255),
  file_type         import_file_type NOT NULL,
  file_size_bytes   integer NOT NULL CHECK (file_size_bytes >= 0),
  sheet_name        text CONSTRAINT import_batches_sheet_len CHECK (sheet_name IS NULL OR char_length(sheet_name) <= 200),

  status            import_batch_status NOT NULL DEFAULT 'PENDING',

  -- The mapping the user confirmed, as {sourceHeader: fieldKeyOrNull}. Small,
  -- and the single most useful thing to have when an import is questioned.
  column_mapping    jsonb NOT NULL DEFAULT '{}'::jsonb
                      CONSTRAINT import_batches_mapping_is_object CHECK (jsonb_typeof(column_mapping) = 'object'),

  total_rows        integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  valid_rows        integer NOT NULL DEFAULT 0 CHECK (valid_rows >= 0),
  warning_rows      integer NOT NULL DEFAULT 0 CHECK (warning_rows >= 0),
  error_rows        integer NOT NULL DEFAULT 0 CHECK (error_rows >= 0),
  imported_rows     integer NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  skipped_rows      integer NOT NULL DEFAULT 0 CHECK (skipped_rows >= 0),

  -- The span the import touched, for the summary email (§32).
  first_booking_date date,
  last_booking_date  date,

  failure_reason    text CONSTRAINT import_batches_failure_len CHECK (failure_reason IS NULL OR char_length(failure_reason) <= 2000),

  uploaded_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,

  CONSTRAINT import_batches_completed_has_timestamp
    CHECK ((status IN ('COMPLETED', 'FAILED', 'CANCELLED')) = (completed_at IS NOT NULL))
);

CREATE INDEX import_batches_recent_idx ON import_batches (uploaded_at DESC);
CREATE INDEX import_batches_uploaded_by_idx ON import_batches (uploaded_by);

-- Provenance on the booking itself. `data_source` already distinguishes
-- MANUAL / IMPORT / ERP (§33); this says *which* import.
ALTER TABLE bookings
  ADD COLUMN import_batch_id uuid REFERENCES import_batches (id) ON DELETE SET NULL;

CREATE INDEX bookings_import_batch_idx ON bookings (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- One import sends one summary email, never one per row (§32).
ALTER TYPE outbox_event_type ADD VALUE IF NOT EXISTS 'PLAN_IMPORTED';

-- Down Migration
DROP INDEX IF EXISTS bookings_import_batch_idx;
ALTER TABLE bookings DROP COLUMN IF EXISTS import_batch_id;
DROP INDEX IF EXISTS import_batches_uploaded_by_idx;
DROP INDEX IF EXISTS import_batches_recent_idx;
DROP TABLE IF EXISTS import_batches;
DROP TYPE IF EXISTS import_file_type;
DROP TYPE IF EXISTS import_batch_status;
-- Note: PostgreSQL cannot remove a value from an enum, so 'PLAN_IMPORTED'
-- remains on outbox_event_type after a down migration. It is inert.
