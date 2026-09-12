-- Up Migration
ALTER TABLE users
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Existing accounts keep their current access. Newly issued temporary
-- passwords are marked by the supported user/seed scripts.

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;
