# BUG-017 — outbox fairness and throughput retest

Status: refined correction implemented and locally verified. Deployed functional
retest passed by product-owner review on 2026-09-13; raw closure exports and exact
timing values are not present in this checkout.

## Evidence boundary

The supplied production observation showed one large outbox parent progressing
while independent parents remained untouched. That proves starvation under the
old scheduler. It does not prove the exact SMTP duration, Vercel budget stop, or
Pinggy contribution. The reported 49.5-minute drain remains an estimate.

## Refined implementation

1. Claim up to two eligible parent rows (`OUTBOX_PARENT_CONCURRENCY=2`).
2. Hold each parent lease while draining child batches in waves of up to three
   (`OUTBOX_CHILD_CONCURRENCY=3`).
3. Persist every child result independently. Successful siblings stay `SENT`;
   only a failed or ambiguously acknowledged child is retried.
4. Start no more than 100 child attempts per invocation
   (`OUTBOX_BATCH_SIZE=100`) and stop before the 50-second run budget.
5. Keep at most six SMTP sends active per invocation with default settings.
6. Preserve ordering for events sharing one booking. Independent bookings can
   progress in parallel. Plan-wide events retain their conservative ordering
   scope.
7. Keep BUG-016 durable claims, leases, stable Message-IDs, partial-recipient
   persistence, attempt limits, and acknowledgement fencing.
8. Wake the authenticated Vercel worker asynchronously after an outbox insert
   using Supabase `pg_net`; retain the existing 30-second Cron as fallback.

The wake trigger is migration `1700000000008_outbox-immediate-wake.sql`. Local
PostgreSQL safely treats it as a no-op when Supabase `net` and Vault are absent.

## Changed areas

| Area | Change |
|---|---|
| Worker/repository | Parent lanes, concurrent child waves, durable partial completion, finalization |
| Configuration | Parent `2`, child `3`, invocation attempt cap `100` |
| Database | Supabase-safe asynchronous wake trigger |
| Tests | Fairness, ordering, concurrency bound, overlap, retry, duplicate protection |
| Operations | Vault setup and 30-second Cron fallback documented |

## Deployment sequence

The checkout does not contain an execution log proving which of these operational
steps were performed. Keep this as the deployment checklist, not as an audit log.

1. Deploy the code and run both new migrations in order:
   `1700000000007_forced-password-change.sql`, then
   `1700000000008_outbox-immediate-wake.sql`.
2. In Supabase Vault, create `outbox_worker_url` and
   `outbox_worker_secret` exactly as documented in
   [`../docs/supabase-outbox-wake.md`](../docs/supabase-outbox-wake.md).
3. Set Vercel environment values:

   ```text
   APP_TIME_ZONE=Africa/Cairo
   DB_POOL_MAX=3
   OUTBOX_PARENT_CONCURRENCY=2
   OUTBOX_CHILD_CONCURRENCY=3
   OUTBOX_BATCH_SIZE=100
   OUTBOX_RUN_BUDGET_MS=50000
   ```

4. Keep the existing authenticated worker URL and `CRON_SECRET`. Do not create
   an Edge Function and do not remove the 30-second Cron fallback.
5. Verify the Vercel function duration exceeds the worker budget plus response
   and database margin.
6. Retest with synthetic recipients only. Preserve existing evidence.

## Realistic retest

Use the existing v3 runner and supplied datasets. Create large parent A and
smaller independent parents B/C, plus ordered created/updated/cancelled events
for one booking. Run the 30-user mixed plan against the frontend domain.

```powershell
powershell -ExecutionPolicy Bypass -File ".\Run-CommitteeFlow-Performance.ps1" `
  -TestPlan ".\performance-tests\07-CommitteeFlow-Realistic-Mixed-30-Users.jmx" `
  -BaseDomain "committeeflow.vercel.app"
```

Capture redacted worker logs, exact run timestamps, post-run SQL state, and the
Mailpit message count. Never capture recipients, payloads, credentials,
authorization headers, or raw SMTP errors.

## Pass criteria

- Independent B/C begin before large A finishes.
- Same-booking lifecycle events never overtake their predecessor.
- No child is sent twice; stable Message-IDs remain unique.
- Successful siblings are not repeated when another child fails.
- Active SMTP sends never exceed six per invocation with default settings.
- All synthetic parents and child batches reach the expected durable state.
- The API run has zero functional failures and remains in the same general
  latency class as the valid historical 2.49–2.60 second p95 baselines. This is
  a comparison guard, not a new SLA.

## Reported deployed result

- 9/9 parent rows reached `SENT`.
- All 99 expected durable child batches completed.
- No duplicate delivery was observed.
- Same-booking CREATED → UPDATED → CANCELLED ordering remained intact.

This satisfies the functional pass criteria. Preserve the report as
user-attested until the final SQL export, redacted worker log, Mailpit export,
deployed build ID and exact run timestamps are added. Historical JTLs and raw
evidence remain unchanged.

## Still unverified

Raw deployment/configuration exports; trigger-to-worker latency; actual Vercel
duration; deployed SMTP duration; aggregate concurrency across Vercel instances;
Pinggy contribution; exact run duration; and independent duplicate analysis from
the missing after exports.
