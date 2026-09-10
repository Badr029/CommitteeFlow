-- Up Migration
--
-- KV holds a voltage *ratio*, not a number.
--
-- The column was modelled as numeric(10, 3) from the sample plan, where every
-- KV cell happened to be a plain figure. The real Committee Plan is not like
-- that: it records the transformation a unit performs — `11/0.4`, `22/0.4`,
-- `6.6/0.42` — alongside plain `11` for the rows where only one side matters.
--
-- A ratio is two numbers and a relationship between them, which no numeric
-- column can hold. The importer was right to refuse the column rather than
-- guess; the column was wrong. So KV becomes text, and the plan field becomes
-- TEXT with it.
--
-- KVA and Qty stay numeric: those really are quantities, and the plan sums and
-- sorts them.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_kv_non_negative;

-- `trim_scale` first, or a stored 11.000 would arrive as the string "11.000"
-- and every existing KV in the plan would suddenly read as a false precision
-- nobody entered.
ALTER TABLE bookings
  ALTER COLUMN kv TYPE text USING (
    CASE WHEN kv IS NULL THEN NULL ELSE trim_scale(kv)::text END
  );

ALTER TABLE bookings
  ADD CONSTRAINT bookings_kv_len CHECK (kv IS NULL OR char_length(kv) <= 40);

-- The field definition is what the form, the plan table and both exports read
-- (§35). Leaving it as NUMBER would keep a number input on a text column.
UPDATE plan_field_definitions
   SET field_type = 'TEXT'::plan_field_type,
       help_text  = 'Voltage, including a ratio such as 11/0.4.',
       updated_at = now()
 WHERE field_key = 'kv';

-- Down Migration
--
-- Lossy by nature: a ratio is not a number, so any KV that is not a plain
-- figure cannot survive the trip back and is set to NULL rather than failing
-- the migration on the first `11/0.4` it meets.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_kv_len;

ALTER TABLE bookings
  ALTER COLUMN kv TYPE numeric(10, 3) USING (
    CASE
      WHEN kv IS NULL THEN NULL
      WHEN btrim(kv) ~ '^[0-9]+(\.[0-9]+)?$' AND btrim(kv)::numeric <= 9999999
        THEN btrim(kv)::numeric(10, 3)
      ELSE NULL
    END
  );

ALTER TABLE bookings
  ADD CONSTRAINT bookings_kv_non_negative CHECK (kv IS NULL OR kv >= 0);

UPDATE plan_field_definitions
   SET field_type = 'NUMBER'::plan_field_type,
       help_text  = null,
       updated_at = now()
 WHERE field_key = 'kv';
