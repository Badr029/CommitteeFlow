-- Up Migration
--
-- Confirmed business rules (previously OPEN in spec §78).
--
-- 1. §46 / §78.1 — Slot exclusivity. CONFIRMED: there is none.
--    Date + Time + Committee is a SHARED COMMITTEE SESSION, not a uniqueness
--    key. One committee sitting at one date and time reviews several projects,
--    and different committees may run in parallel. So:
--      * no UNIQUE constraint on (booking_date, booking_time, committee)
--      * a second booking into an occupied session is never rejected
--      * concurrent bookings into the same session may all succeed
--    The setting stays in app_settings so the rule remains reversible, but its
--    confirmed value is NONE.
--
-- 2. §78.3 — Future horizon. CONFIRMED: 6 months.
--
-- 3. §78.2 — Edit ownership. CONFIRMED: any Project Engineer (already default).

UPDATE app_settings
   SET value = '"NONE"'::jsonb,
       description = 'CONFIRMED (spec §46, §78.1): committee slots are NOT exclusive. '
                  || 'Date + Time + Committee is a shared Committee Session that holds many '
                  || 'project bookings. Values: NONE, DATE, DATE_TIME, DATE_TIME_COMMITTEE. '
                  || 'Kept configurable so the rule can be tightened later without a migration.'
 WHERE key = 'booking_slot_uniqueness';

UPDATE app_settings
   SET value = '6'::jsonb,
       description = 'CONFIRMED (spec §78.3): bookings may be created up to 6 whole months '
                  || 'ahead. null would mean unlimited.'
 WHERE key = 'booking_future_horizon_months';

UPDATE app_settings
   SET description = 'CONFIRMED (spec §41, §78.2): any Project Engineer may edit or cancel any '
                  || 'booking. Values: ANY_ENGINEER, CREATOR_ONLY, CREATOR_OR_PLAN_MANAGER.'
 WHERE key = 'booking_edit_policy';

-- Sessions are read constantly (the plan groups by them, and the booking form
-- previews the one being joined), so index the grouping key directly.
CREATE INDEX bookings_session_idx
    ON bookings (booking_date, booking_time, committee)
 WHERE booking_state = 'ACTIVE';

-- Down Migration
DROP INDEX IF EXISTS bookings_session_idx;

UPDATE app_settings SET value = 'null'::jsonb WHERE key = 'booking_future_horizon_months';
