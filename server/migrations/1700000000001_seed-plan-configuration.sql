-- Up Migration
--
-- Seeds the *default* Committee Plan structure and the runtime settings that
-- carry the specification's open business rules.
--
-- The current Excel format is the default standard, not a permanent hardcoded
-- format (§19). Everything inserted here is editable through Plan Configuration
-- afterwards; nothing in application code re-asserts these values.

-- ---------------------------------------------------------------------------
-- Plan field definitions (§10, §21)
--
-- SYSTEM   the application cannot function without them; never archivable
-- STANDARD the current business fields; renameable / reorderable / hideable
-- CUSTOM   added later by plan managers; stored in bookings.custom_fields
--
-- `is_required` below reproduces what every row of the existing plan sheet
-- actually carries. It is a starting point, not company policy: a plan manager
-- can change requiredness for any STANDARD field at any time (§21).
-- ---------------------------------------------------------------------------
INSERT INTO plan_field_definitions
  (field_key, label, field_type, field_class, storage_strategy, is_required, is_visible, display_order, help_text)
VALUES
  ('booking_date',  'Date',          'DATE',      'SYSTEM',   'COLUMN', true,  true,  10, 'The day the committee slot is booked for. The weekday is derived from this value.'),
  ('booking_time',  'Time',          'TIME',      'SYSTEM',   'COLUMN', true,  true,  20, null),
  ('off_no',        'OFF No.',       'TEXT',      'STANDARD', 'COLUMN', true,  true,  30, null),
  ('order_name',    'Order Name',    'TEXT',      'STANDARD', 'COLUMN', true,  true,  40, null),
  ('committee',     'Committee',     'TEXT',      'STANDARD', 'COLUMN', true,  true,  50, null),
  ('qty',           'Qty',           'NUMBER',    'STANDARD', 'COLUMN', false, true,  60, null),
  ('kva',           'KVA',           'NUMBER',    'STANDARD', 'COLUMN', false, true,  70, null),
  -- Text, not a number: the plan records voltage ratios (11/0.4) as often
  -- as plain figures. See migration 1700000000004.
  ('kv',            'KV',            'TEXT',      'STANDARD', 'COLUMN', false, true,  80, 'Voltage, including a ratio such as 11/0.4.'),
  ('status',        'Status',        'TEXT',      'STANDARD', 'COLUMN', false, true,  90, null),
  ('notes',         'Notes',         'LONG_TEXT', 'STANDARD', 'COLUMN', false, true, 100, null),
  ('customer_name', 'Customer Name', 'TEXT',      'STANDARD', 'COLUMN', false, true, 110, null);

-- ---------------------------------------------------------------------------
-- Runtime settings
--
-- Three of these encode business rules the specification explicitly marks as
-- OPEN and forbids the implementation from inventing (§46, §78, §79). Each
-- default is the *least presumptuous* reading of the spec, not a policy choice:
--
--   booking_slot_uniqueness        NONE
--       The only behaviour the source plan actually proves is that multiple
--       bookings may share a date (§8). Until the exclusivity key is confirmed
--       the system enforces no exclusivity at all rather than guessing one.
--
--   booking_edit_policy            ANY_ENGINEER
--       §41 lists PATCH/CANCEL as PROJECT_ENGINEER with no ownership test; the
--       ownership restriction in §78.2 is the open part. ANY_ENGINEER is §41
--       read literally, with no extra restriction invented.
--
--   booking_future_horizon_months  null
--       Future-month booking is confirmed (§9); the horizon is not (§78.3).
--       null means unlimited, i.e. no company policy asserted.
--
-- All three are changed at runtime with no migration and no code change.
-- ---------------------------------------------------------------------------
INSERT INTO app_settings (key, value, description)
VALUES
  (
    'booking_slot_uniqueness',
    '"NONE"'::jsonb,
    'OPEN BUSINESS RULE (spec §46, §78.1). What makes a committee slot exclusive. One of: NONE, DATE, DATE_TIME, DATE_TIME_COMMITTEE. Enforced inside the booking transaction under a PostgreSQL advisory lock, so it is safe against concurrent writers at any value.'
  ),
  (
    'booking_edit_policy',
    '"ANY_ENGINEER"'::jsonb,
    'OPEN BUSINESS RULE (spec §78.2). Who may edit or cancel an existing booking. One of: ANY_ENGINEER, CREATOR_ONLY, CREATOR_OR_PLAN_MANAGER.'
  ),
  (
    'booking_future_horizon_months',
    'null'::jsonb,
    'OPEN BUSINESS RULE (spec §78.3). How far ahead a booking may be created, in whole months from today. null means unlimited.'
  ),
  (
    'notification_audience',
    '"ALL_ACTIVE_USERS"'::jsonb,
    'Who receives booking notification emails. One of: ALL_ACTIVE_USERS, ENGINEERS_ONLY. Individual users can still opt out via users.notify_by_email.'
  );

-- Down Migration
DELETE FROM app_settings
 WHERE key IN (
   'booking_slot_uniqueness',
   'booking_edit_policy',
   'booking_future_horizon_months',
   'notification_audience'
 );

DELETE FROM plan_field_definitions
 WHERE field_key IN (
   'booking_date', 'booking_time', 'off_no', 'order_name', 'committee',
   'qty', 'kva', 'kv', 'status', 'notes', 'customer_name'
 );
