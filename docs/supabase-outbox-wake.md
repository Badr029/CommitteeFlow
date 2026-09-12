# Supabase immediate outbox wake

Migration `1700000000008_outbox-immediate-wake.sql` uses Supabase `pg_net` and
Vault when available. Local PostgreSQL remains a no-op. The existing 30-second
Cron job remains the recovery fallback.

Before enabling the trigger in production, create two Vault secrets in the
Supabase SQL editor:

```sql
select vault.create_secret(
  'https://committeeflow.vercel.app/api/internal/process-outbox',
  'outbox_worker_url'
);
select vault.create_secret('<same value as Vercel CRON_SECRET>', 'outbox_worker_secret');
```

Then deploy the migrations. Keep these Vercel values:

```text
DB_POOL_MAX=3
OUTBOX_PARENT_CONCURRENCY=2
OUTBOX_CHILD_CONCURRENCY=3
OUTBOX_BATCH_SIZE=100
OUTBOX_RUN_BUDGET_MS=50000
```

The database request is asynchronous and has a 60-second HTTP timeout. Do not
put the secret in migration SQL, source control, screenshots, or QA exports.
