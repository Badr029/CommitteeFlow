-- Up Migration
--
-- Three corrections the business confirmed after using the plan.
--
-- 1. `Status` never meant a status. The column in the source spreadsheet was
--    being used for transformer serial and reference numbers —
--    `010662606B-020662606B`, `DD-001600-022000-S289`, `invoice-040182515B` —
--    and CommitteeFlow imported them faithfully into a field the application
--    treats as a business status. Those values move to `serial_no`, where they
--    belong.
--
-- 2. There were two lifecycles. `booking_state` (ACTIVE/CANCELLED) drove
--    cancellation, the partial index and the strike-through; `status` was a
--    free-text field a user could type anything into. Two columns describing
--    the same thing is one too many, and it made
--    `status = 'Done', booking_state = 'CANCELLED'` representable. They are now
--    one column: `bookings.status`, of type `booking_status`, PLANNED or
--    CANCELLED and nothing else. The rename is deliberate — the enum, its
--    values and the column are renamed in place, so every index, constraint and
--    history row that referred to the old names follows automatically and no
--    data is copied.
--
-- 3. Nobody could tell who put a project on the plan. `created_by` answers who
--    typed it, which is a different question the moment anyone imports a sheet
--    on someone else's behalf. `project_engineer_id` answers the business one.
--
-- Deleting is added alongside, because Cancel and Delete turned out to be
-- different things: a committee that is no longer coming stays on the plan,
-- struck through, so nobody moves a transformer for it; a booking entered by
-- mistake should not be on the plan at all. Delete is a tombstone, not a
-- DELETE — the plan is auditable, and "who removed this, and when" has to
-- survive.

-- ---------------------------------------------------------------------------
-- Serial No.
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN serial_no text
    CONSTRAINT bookings_serial_no_len CHECK (serial_no IS NULL OR char_length(serial_no) <= 200);

COMMENT ON COLUMN bookings.serial_no IS
  'Transformer serial or reference number. Text, never parsed as a number: leading zeros are significant and one cell often holds several references joined by hyphens.';

-- ---------------------------------------------------------------------------
-- Project Engineer
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN project_engineer_id uuid REFERENCES users (id) ON DELETE RESTRICT;

COMMENT ON COLUMN bookings.project_engineer_id IS
  'The engineer responsible for this project being on the plan. Distinct from created_by, which records the account that wrote the row — the two differ for imports and any on-behalf-of workflow.';

CREATE INDEX bookings_project_engineer_idx ON bookings (project_engineer_id)
  WHERE project_engineer_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Delete, as a tombstone
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN deleted_at timestamptz;
ALTER TABLE bookings ADD COLUMN deleted_by uuid REFERENCES users (id) ON DELETE RESTRICT;

ALTER TABLE bookings ADD CONSTRAINT bookings_deleted_fields_consistent CHECK (
  (deleted_at IS NULL AND deleted_by IS NULL)
  OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Move the serials out of Status
-- ---------------------------------------------------------------------------
--
-- What was in there is a mixture: real serial numbers from the imported sheet,
-- and a handful of words somebody typed as a status. Only the first kind is a
-- serial, so only the first kind moves. The words are retired with the column —
-- the lifecycle they were reaching for is the one `status` now holds, and a
-- value like `Done` has no home in a two-state lifecycle.
--
-- Nothing is discarded silently: every row that had a value gets a history
-- entry recording what it was, so `Done` and `In review` remain answerable
-- questions after this runs. `actor_id` is null because no person did this.

CREATE TEMPORARY TABLE status_migration AS
SELECT
  id,
  status AS old_status,
  version,
  CASE
    WHEN lower(btrim(status)) IN (
      'planned', 'cancelled', 'canceled', 'active', 'done', 'in review',
      'in-review', 'completed', 'complete', 'pending', 'n/a', 'na', '-', ''
    ) THEN NULL
    ELSE btrim(status)
  END AS new_serial_no
FROM bookings
WHERE status IS NOT NULL AND btrim(status) <> '';

INSERT INTO booking_history
  (booking_id, action, actor_id, old_values, new_values, changed_keys, booking_version)
SELECT
  m.id,
  'UPDATE',
  NULL,
  jsonb_build_object('status', m.old_status),
  jsonb_build_object('serial_no', m.new_serial_no),
  CASE WHEN m.new_serial_no IS NULL THEN ARRAY['status'] ELSE ARRAY['status', 'serial_no'] END,
  m.version
FROM status_migration m;

UPDATE bookings b
   SET serial_no = m.new_serial_no
  FROM status_migration m
 WHERE b.id = m.id AND m.new_serial_no IS NOT NULL;

DROP TABLE status_migration;

-- ---------------------------------------------------------------------------
-- One lifecycle, under the name the business uses for it
-- ---------------------------------------------------------------------------
ALTER TABLE bookings DROP COLUMN status;

ALTER TYPE booking_state RENAME VALUE 'ACTIVE' TO 'PLANNED';
ALTER TYPE booking_state RENAME TO booking_status;
ALTER TABLE bookings RENAME COLUMN booking_state TO status;

COMMENT ON COLUMN bookings.status IS
  'PLANNED or CANCELLED. The only lifecycle a booking has: a cancelled booking stays on the plan, struck through, so nobody prepares for a committee that is not coming.';

-- The plan is read a month at a time, and now excludes what was deleted.
DROP INDEX IF EXISTS bookings_active_date_idx;
CREATE INDEX bookings_live_date_idx ON bookings (booking_date, booking_time)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Who owns what was already there
-- ---------------------------------------------------------------------------
--
-- A manually created booking was created by the engineer who was arranging it,
-- so `created_by` is a safe answer where that account is a Project Engineer.
--
-- Imported rows are left null on purpose. The sheet said nothing about who owns
-- each project, and the person who ran the import is not the answer — filling
-- their name in would invent ownership that nobody stated, which is worse than
-- admitting it is unknown.
UPDATE bookings b
   SET project_engineer_id = b.created_by
  FROM users u
 WHERE u.id = b.created_by
   AND u.role = 'PROJECT_ENGINEER'
   AND b.data_source = 'MANUAL'
   AND b.project_engineer_id IS NULL;

-- ---------------------------------------------------------------------------
-- History and notifications learn the two new verbs
-- ---------------------------------------------------------------------------
ALTER TYPE booking_history_action ADD VALUE IF NOT EXISTS 'DELETE';
ALTER TYPE outbox_event_type ADD VALUE IF NOT EXISTS 'BOOKING_DELETED';

-- ---------------------------------------------------------------------------
-- Plan configuration
-- ---------------------------------------------------------------------------
--
-- Status stops being a field a plan manager can reshape. It drives cancellation
-- now, so its type and its two values are the application's, not a preference:
-- SYSTEM class, which the existing rules already refuse to archive or retype.
-- Label, order and visibility stay configurable, because those are presentation.
UPDATE plan_field_definitions
   SET field_type  = 'SELECT'::plan_field_type,
       field_class = 'SYSTEM'::plan_field_class,
       options     = '["PLANNED", "CANCELLED"]'::jsonb,
       help_text   = 'Set by the application. Cancel a booking to move it to CANCELLED; it stays on the plan, struck through.',
       is_visible  = true,
       updated_at  = now()
 WHERE field_key = 'status';

INSERT INTO plan_field_definitions
  (field_key, label, field_type, field_class, storage_strategy, is_required, is_visible, display_order, help_text)
VALUES
  ('serial_no', 'Serial No.', 'TEXT', 'STANDARD', 'COLUMN', false, true, 95,
   'Transformer serial or reference number. One cell may hold several, joined by hyphens.'),
  -- STANDARD, not SYSTEM: its type is already locked by its storage kind (a
  -- reference to a user cannot become anything else), and a plan manager should
  -- still be able to leave the column off a printed plan.
  ('project_engineer', 'Project Engineer', 'TEXT', 'STANDARD', 'COLUMN', false, true, 97,
   'The engineer who put this project on the plan. Assigned automatically and never typed.');

-- Down Migration
--
-- Lossy where it has to be, and says so. The serials can go back into `status`,
-- but the words retired above are gone from the column — they survive only in
-- the history rows the up migration wrote, which is where a question about them
-- should be asked anyway.
DELETE FROM plan_field_definitions WHERE field_key IN ('serial_no', 'project_engineer');

UPDATE plan_field_definitions
   SET field_type  = 'TEXT'::plan_field_type,
       field_class = 'STANDARD'::plan_field_class,
       options     = '[]'::jsonb,
       help_text   = null,
       updated_at  = now()
 WHERE field_key = 'status';

DROP INDEX IF EXISTS bookings_live_date_idx;

ALTER TABLE bookings RENAME COLUMN status TO booking_state;
ALTER TYPE booking_status RENAME TO booking_state;
ALTER TYPE booking_state RENAME VALUE 'PLANNED' TO 'ACTIVE';

CREATE INDEX bookings_active_date_idx ON bookings (booking_date, booking_time)
  WHERE booking_state = 'ACTIVE';

ALTER TABLE bookings
  ADD COLUMN status text
    CONSTRAINT bookings_status_len CHECK (status IS NULL OR char_length(status) <= 80);

UPDATE bookings SET status = left(serial_no, 80) WHERE serial_no IS NOT NULL;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_deleted_fields_consistent;
ALTER TABLE bookings DROP COLUMN IF EXISTS deleted_by;
ALTER TABLE bookings DROP COLUMN IF EXISTS deleted_at;

DROP INDEX IF EXISTS bookings_project_engineer_idx;
ALTER TABLE bookings DROP COLUMN IF EXISTS project_engineer_id;
ALTER TABLE bookings DROP COLUMN IF EXISTS serial_no;

-- Note: PostgreSQL cannot remove a value from an enum, so 'DELETE' remains on
-- booking_history_action and 'BOOKING_DELETED' on outbox_event_type. Both are
-- inert.
