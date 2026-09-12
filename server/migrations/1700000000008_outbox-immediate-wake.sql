-- Up Migration
-- Supabase production: wake the authenticated Vercel outbox worker after a
-- committed enqueue. Local PostgreSQL has no pg_net/Vault, so the same
-- migration remains portable and the trigger becomes a no-op there.
CREATE OR REPLACE FUNCTION wake_outbox_worker() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  worker_url text;
  worker_secret text;
BEGIN
  IF to_regnamespace('net') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE $sql$
    SELECT
      max(decrypted_secret) FILTER (WHERE name = 'outbox_worker_url'),
      max(decrypted_secret) FILTER (WHERE name = 'outbox_worker_secret')
    FROM vault.decrypted_secrets
  $sql$ INTO worker_url, worker_secret;

  IF worker_url IS NULL OR worker_secret IS NULL THEN
    RETURN NEW;
  END IF;

  EXECUTE $sql$
    SELECT net.http_post(
      url := $1,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || $2,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('source', 'email_outbox', 'outboxId', $3),
      timeout_milliseconds := 60000
    )
  $sql$ USING worker_url, worker_secret, NEW.id;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER email_outbox_wake_worker
  AFTER INSERT ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION wake_outbox_worker();

-- Down Migration
DROP TRIGGER IF EXISTS email_outbox_wake_worker ON email_outbox;
DROP FUNCTION IF EXISTS wake_outbox_worker();
