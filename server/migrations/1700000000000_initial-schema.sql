-- Up Migration
--
-- CommitteeFlow initial schema (spec §30-§34, §51).
--
-- Design notes:
--   * Operational and current-standard business fields are real columns;
--     only *future* custom fields live in JSONB (§30).
--   * Requiredness of standard business fields is configurable at runtime
--     (§21), so those columns stay nullable and the service layer enforces the
--     configured rule. Columns the application itself cannot work without
--     (booking_date, booking_time, created_by, ...) are NOT NULL here.
--   * Critical invariants are CHECK constraints, not frontend validation (§45).

CREATE TYPE user_role AS ENUM ('PROJECT_ENGINEER', 'VIEWER');

CREATE TABLE users (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                          text NOT NULL
                                  CONSTRAINT users_name_not_blank CHECK (btrim(name) <> ''),
  email                         text NOT NULL
                                  CONSTRAINT users_email_shape CHECK (position('@' in email) > 1 AND email !~ '\s'),
  -- Nullable so a future SSO identity can exist without a local password (§31).
  password_hash                 text,
  role                          user_role NOT NULL DEFAULT 'VIEWER',
  can_manage_plan_configuration boolean NOT NULL DEFAULT false,
  is_active                     boolean NOT NULL DEFAULT true,
  notify_by_email               boolean NOT NULL DEFAULT true,
  external_identity_id          text UNIQUE,
  failed_login_attempts         integer NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until                  timestamptz,
  last_login_at                 timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_authenticatable CHECK (password_hash IS NOT NULL OR external_identity_id IS NOT NULL)
);

-- Email is the login identifier; treat it case-insensitively.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_active_notify_idx ON users (is_active, notify_by_email);

-- ---------------------------------------------------------------------------
-- Session store (connect-pg-simple layout, spec §39)
-- ---------------------------------------------------------------------------
CREATE TABLE "session" (
  sid    varchar NOT NULL COLLATE "default" PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX session_expire_idx ON "session" (expire);

-- ---------------------------------------------------------------------------
-- Runtime application settings
--
-- Holds business rules the specification leaves open (§78) so they can be
-- confirmed and changed without a schema migration or code change (§79).
-- ---------------------------------------------------------------------------
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Plan field definitions (spec §34)
-- ---------------------------------------------------------------------------
CREATE TYPE plan_field_type AS ENUM ('TEXT', 'LONG_TEXT', 'NUMBER', 'SELECT', 'DATE', 'TIME', 'CHECKBOX');
CREATE TYPE plan_field_class AS ENUM ('SYSTEM', 'STANDARD', 'CUSTOM');
CREATE TYPE plan_field_storage AS ENUM ('COLUMN', 'CUSTOM_JSONB');

CREATE TABLE plan_field_definitions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable technical key. Never renamed once data exists (§20, §24).
  field_key        text NOT NULL UNIQUE
                     CONSTRAINT plan_field_key_shape CHECK (field_key ~ '^[a-z][a-z0-9_]{0,62}$'),
  -- User-facing and freely configurable (§20).
  label            text NOT NULL
                     CONSTRAINT plan_field_label_not_blank CHECK (btrim(label) <> ''),
  help_text        text,
  field_type       plan_field_type NOT NULL,
  field_class      plan_field_class NOT NULL,
  storage_strategy plan_field_storage NOT NULL,
  is_required      boolean NOT NULL DEFAULT false,
  is_visible       boolean NOT NULL DEFAULT true,
  display_order    integer NOT NULL,
  options          jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active        boolean NOT NULL DEFAULT true,
  archived_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Custom fields always land in bookings.custom_fields; the others are columns.
  CONSTRAINT plan_field_storage_matches_class CHECK (
    (field_class = 'CUSTOM' AND storage_strategy = 'CUSTOM_JSONB')
    OR (field_class <> 'CUSTOM' AND storage_strategy = 'COLUMN')
  ),
  CONSTRAINT plan_field_options_is_array CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT plan_field_select_has_options CHECK (
    field_type <> 'SELECT' OR jsonb_array_length(options) > 0
  ),
  -- Archiving is the only removal (§23); never a DELETE.
  CONSTRAINT plan_field_archived_consistency CHECK (
    (is_active AND archived_at IS NULL) OR (NOT is_active AND archived_at IS NOT NULL)
  ),
  -- SYSTEM fields describe columns the application owns and cannot be archived.
  CONSTRAINT plan_field_system_always_active CHECK (field_class <> 'SYSTEM' OR is_active)
);

CREATE INDEX plan_field_definitions_order_idx ON plan_field_definitions (display_order, field_key);

-- ---------------------------------------------------------------------------
-- Bookings (spec §32)
-- ---------------------------------------------------------------------------
CREATE TYPE booking_state AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE booking_data_source AS ENUM ('MANUAL', 'ERP', 'IMPORT');

CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Structured date and time. Time is never smuggled into notes (§10).
  booking_date   date NOT NULL,
  booking_time   time NOT NULL,

  -- Standard business fields. Nullable because requiredness is configurable.
  off_no         text CONSTRAINT bookings_off_no_len CHECK (off_no IS NULL OR char_length(off_no) <= 64),
  order_name     text CONSTRAINT bookings_order_name_len CHECK (order_name IS NULL OR char_length(order_name) <= 300),
  committee      text CONSTRAINT bookings_committee_len CHECK (committee IS NULL OR char_length(committee) <= 120),
  qty            integer CONSTRAINT bookings_qty_positive CHECK (qty IS NULL OR qty > 0),
  kva            numeric(14, 3) CONSTRAINT bookings_kva_non_negative CHECK (kva IS NULL OR kva >= 0),
  kv             numeric(10, 3) CONSTRAINT bookings_kv_non_negative CHECK (kv IS NULL OR kv >= 0),
  -- Business status from the plan sheet. NOT the application lifecycle (§32).
  status         text CONSTRAINT bookings_status_len CHECK (status IS NULL OR char_length(status) <= 80),
  notes          text CONSTRAINT bookings_notes_len CHECK (notes IS NULL OR char_length(notes) <= 4000),
  customer_name  text CONSTRAINT bookings_customer_name_len CHECK (customer_name IS NULL OR char_length(customer_name) <= 300),

  -- Future custom fields only (§30).
  custom_fields  jsonb NOT NULL DEFAULT '{}'::jsonb
                   CONSTRAINT bookings_custom_fields_is_object CHECK (jsonb_typeof(custom_fields) = 'object'),

  -- Application lifecycle (§15, §32).
  booking_state       booking_state NOT NULL DEFAULT 'ACTIVE',
  cancelled_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  cancelled_at        timestamptz,
  cancellation_reason text CONSTRAINT bookings_cancel_reason_len CHECK (cancellation_reason IS NULL OR char_length(cancellation_reason) <= 1000),

  -- Future integration metadata, unused by the MVP (§33).
  data_source        booking_data_source NOT NULL DEFAULT 'MANUAL',
  external_reference text CONSTRAINT bookings_external_ref_len CHECK (external_reference IS NULL OR char_length(external_reference) <= 200),

  -- Ownership and change tracking (§12).
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Optimistic concurrency (§48).
  version integer NOT NULL DEFAULT 1 CONSTRAINT bookings_version_positive CHECK (version > 0),

  CONSTRAINT bookings_cancelled_fields_consistent CHECK (
    (booking_state = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (booking_state = 'ACTIVE' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL)
  )
);

-- The dominant access pattern is one month of the active plan (§53, §54).
CREATE INDEX bookings_active_date_idx ON bookings (booking_date, booking_time)
  WHERE booking_state = 'ACTIVE';
CREATE INDEX bookings_date_committee_idx ON bookings (booking_date, committee);
CREATE INDEX bookings_created_by_idx ON bookings (created_by);
CREATE INDEX bookings_custom_fields_gin ON bookings USING gin (custom_fields jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- Booking history (spec §13)
-- ---------------------------------------------------------------------------
CREATE TYPE booking_history_action AS ENUM ('CREATE', 'UPDATE', 'CANCEL');

CREATE TABLE booking_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id      uuid NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  action          booking_history_action NOT NULL,
  -- Nullable so history survives if an account is ever removed; the app never
  -- deletes users, but audit must not be the reason a delete fails silently.
  actor_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  old_values      jsonb,
  new_values      jsonb,
  changed_keys    text[] NOT NULL DEFAULT '{}',
  booking_version integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX booking_history_booking_idx ON booking_history (booking_id, id DESC);
CREATE INDEX booking_history_recent_idx ON booking_history (created_at DESC, id DESC);
CREATE INDEX booking_history_actor_idx ON booking_history (actor_id);

-- ---------------------------------------------------------------------------
-- Configuration history (spec §25)
-- ---------------------------------------------------------------------------
CREATE TYPE configuration_history_action AS ENUM ('CREATE', 'UPDATE', 'ARCHIVE', 'RESTORE', 'REORDER');

CREATE TABLE configuration_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  field_id   uuid REFERENCES plan_field_definitions (id) ON DELETE SET NULL,
  field_key  text NOT NULL,
  action     configuration_history_action NOT NULL,
  old_value  jsonb,
  new_value  jsonb,
  changed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX configuration_history_recent_idx ON configuration_history (changed_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- Email outbox (spec §50, §51)
-- ---------------------------------------------------------------------------
CREATE TYPE outbox_event_type AS ENUM ('BOOKING_CREATED', 'BOOKING_UPDATED', 'BOOKING_CANCELLED');
CREATE TYPE outbox_status AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE email_outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      outbox_event_type NOT NULL,
  booking_id      uuid REFERENCES bookings (id) ON DELETE SET NULL,
  recipients      text[] NOT NULL CONSTRAINT email_outbox_has_recipients CHECK (cardinality(recipients) > 0),
  subject         text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          outbox_status NOT NULL DEFAULT 'PENDING',
  attempt_count   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  CONSTRAINT email_outbox_sent_has_timestamp CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);

-- The worker only ever scans for due, not-yet-delivered messages.
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at, id)
  WHERE status <> 'SENT';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER plan_field_definitions_set_updated_at
  BEFORE UPDATE ON plan_field_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER app_settings_set_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER IF EXISTS app_settings_set_updated_at ON app_settings;
DROP TRIGGER IF EXISTS plan_field_definitions_set_updated_at ON plan_field_definitions;
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
DROP FUNCTION IF EXISTS set_updated_at();

DROP TABLE IF EXISTS email_outbox;
DROP TYPE IF EXISTS outbox_status;
DROP TYPE IF EXISTS outbox_event_type;

DROP TABLE IF EXISTS configuration_history;
DROP TYPE IF EXISTS configuration_history_action;

DROP TABLE IF EXISTS booking_history;
DROP TYPE IF EXISTS booking_history_action;

DROP TABLE IF EXISTS bookings;
DROP TYPE IF EXISTS booking_data_source;
DROP TYPE IF EXISTS booking_state;

DROP TABLE IF EXISTS plan_field_definitions;
DROP TYPE IF EXISTS plan_field_storage;
DROP TYPE IF EXISTS plan_field_class;
DROP TYPE IF EXISTS plan_field_type;

DROP TABLE IF EXISTS app_settings;
DROP INDEX IF EXISTS session_expire_idx;
DROP TABLE IF EXISTS "session";

DROP TABLE IF EXISTS users;
DROP TYPE IF EXISTS user_role;
