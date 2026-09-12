-- Up Migration
-- Forward-only operational change: stop old workers before applying/deploying.
ALTER TABLE email_outbox
  ADD COLUMN delivery_key uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN claim_token uuid,
  ADD COLUMN lease_until timestamptz;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_lease_pair
  CHECK ((claim_token IS NULL) = (lease_until IS NULL));
CREATE UNIQUE INDEX email_outbox_delivery_key_idx ON email_outbox(delivery_key);

CREATE TABLE email_outbox_batches (
  outbox_id bigint NOT NULL REFERENCES email_outbox(id) ON DELETE CASCADE,
  batch_no integer NOT NULL CHECK (batch_no >= 0),
  recipients text[] NOT NULL CHECK (cardinality(recipients) > 0),
  remaining_recipients text[] NOT NULL,
  status outbox_status NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  in_flight boolean NOT NULL DEFAULT false,
  last_error text,
  sent_at timestamptz,
  PRIMARY KEY (outbox_id, batch_no),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
  CHECK ((status = 'SENT') = (cardinality(remaining_recipients) = 0)),
  CHECK (NOT in_flight OR status <> 'SENT')
);

-- Down Migration
-- Refuse to erase retry/delivery history. Restore an approved backup instead.
DO $$ BEGIN
  RAISE EXCEPTION 'Outbox delivery migration is forward-only; do not discard batch delivery history';
END $$;
