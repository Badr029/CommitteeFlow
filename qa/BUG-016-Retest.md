# BUG-016 — delivery correction and retest procedure

Status: implementation prepared; deployed defect remains OPEN. No deployment,
Supabase/Cron/Vercel changes or messages to real recipients were performed.
Do not add a successful closure to the fix-comment register until the deployed
checks below pass. Automated evidence is distinct from manual/deployed evidence.

Local results: 327 server tests passed, four real-workbook tests skipped because
the optional workbook fixture was unavailable; all 83 client tests passed.
All 17 new BUG-016 tests passed. Type checking, lint and client/server builds
passed. A separate migration check preserved legacy rows and verified the
down migration's intentional refusal. Docker Compose configuration validated
with synthetic placeholders; the initial check without required placeholders
failed and is retained. Docker image build and manual UI retest were not run.
See the [verification record](QA-Evidence/logs/BUG-016-verification.md).

## Confirmed cause and limits

The original worker committed its `SELECT ... FOR UPDATE SKIP LOCKED`
transaction before SMTP. No durable state prevented a second worker from
selecting the same row. Local PostgreSQL reproduction sent twice where once
was required: [before output](QA-Evidence/logs/BUG-016-before-test.txt).
The timer's `running` flag did not cover concurrent internal HTTP invocations
or other processes. Status updates were not fenced and attempts were counted
after transmission. This explains a duplicate path; it does not prove which
of the 27 deployed attempts overlapped or lost SMTP acknowledgement.

All 530 recipients previously shared one SMTP transaction. The adapter did not
configure timeouts, inspect partial acceptance, or set a stable Message-ID.
Sequential recipient commands over a tunnel can increase transaction duration;
actual contribution requires deployed SMTP/worker timings. No backend function
duration or Supabase Cron configuration is versioned here. Frontend Vercel
rewrites are in `client/vercel.json`; the internal worker route awaits work in
`server/src/app.ts` (pre-existing user changes preserved).

## Implementation and acceptance criteria

| Requirement | Correction / automated check |
|---|---|
| One logical notification per event | Existing booking/history/enqueue transaction preserved; existing audit tests |
| Competing workers | Atomic parent claim with UUID token and expiry; real concurrent PostgreSQL claims and blocked-send test |
| Completed work is not repeated | Persisted SENT batches excluded; parent SENT only after every batch succeeds |
| Bounded retry | Per-batch attempt persisted before SMTP; exponential backoff, six attempts by default |
| Unknown SMTP result | `DELIVERY_UNKNOWN`, default 900-second cooldown and same retry cap; no raw SMTP error/addresses logged |
| Large audience/privacy | Immutable batches of at most 50 by default; explicit envelope and BCC; no extra sender delivery |
| Partial failure | Completed batches retained; acknowledged recipients removed from remaining recipients |
| Stable identifiers | Random durable event UUID + batch number; same Message-ID across retries |
| Crash recovery | Expired claim with an in-flight attempt becomes ambiguous; stale tokens cannot acknowledge/restart |
| Serverless budget | Claim one parent at a time; stop before next SMTP attempt if less than send timeout + 5 seconds remains |

Changed implementation: `server/src/modules/notifications/{outbox.repository,
outbox.worker,mailer}.ts`, `server/src/config/env.ts`, `server/src/server.ts`,
`.env.example`, `docker-compose.yml`; new migration
`server/migrations/1700000000006_outbox-delivery.sql`.
Tests: `server/tests/integration/outbox-delivery.test.ts`,
`server/tests/unit/mailer.test.ts`; existing audit test/harness updated to assert
sanitized error categories instead of raw SMTP text. No dependencies added.

The parent attempt_count is now the total number of started SMTP batch attempts;
each child has its own retry counter. `sent` in the internal endpoint response
counts completed logical events; `failed` counts batch delivery failures.
Budget exhaustion can return zero completed events while some batches progressed.

Generic SMTP has no exactly-once transaction shared with PostgreSQL. If DATA
was accepted but its acknowledgement or the subsequent DB commit is lost,
retry may duplicate that batch. An expired worker may have transmitted before
termination; fencing protects DB state, not remote SMTP acceptance. The adapter
destroys its owned socket on the absolute timeout; process suspension/termination
still leaves an unknown result. Stable Message-ID is correlation, not a promise
of recipient/provider deduplication. Exhausted rows remain FAILED/infinity for
operator review; do not blindly reset their counters. Strict exactly-once would
require provider idempotency or delivery reconciliation beyond generic SMTP.

## Evidence still required from the original deployed run

Place these under `qa/QA-Evidence/`, retaining private originals separately:

1. `logs/BUG-016-outbox-before.csv`: the three event rows with id, event_type,
   status, attempt_count, created_at, next_attempt_at, sent_at and recipient
   **count**. Export neither recipients, subject nor payload. Separately classify
   last_error as timeout/connection/negative SMTP reply; never paste raw errors
   without redacting addresses, credentials and tokens.
2. Already captured: `logs/BUG-016-mailpit-before.json`, read-only metadata
   confirming 27 messages (5/9/13), 530 BCC recipients each and 27 distinct
   Message-IDs. Optional `screenshots/BUG-016-mailpit-before.png`: the filtered lifecycle and total
   27 messages. Redact all addresses and any real business data. Optional
   additional exports should contain event classification, timestamp, Message-ID,
   recipient count only. Preserve original screenshots; annotated copies use
   `BUG-016-mailpit-before-annotated.png`, with red outlines only.
3. `logs/BUG-016-worker-before.json`: redacted Vercel request/run identifiers,
   start/end times, duration, outcome and SMTP error category; Supabase Cron
   schedule/run overlap and HTTP timeout; configured function duration, worker
   poll interval/batch size/max attempts and SMTP timeout settings. No Cron SQL
   containing authorization headers, connection strings or secrets.
4. Confirm whether `mixed-10-20260912-150225` or `mixed-10-20260912-153357`
   produced the observation. Both originals remain in `../Test/Jmeter Blaze/results/`
   relative to the repository root, with their original HTML reports.
   [Manifest](QA-Evidence/performance/BUG-016/manifest.json) records exact workspace
   paths, hashes and sanitization. Each has 307 samples, zero recorded HTTP failures;
   neither JTL records SMTP delivery and therefore neither proves email correctness.
5. Record deployed commit/build identifier and actual test time/timezone.

Safe original outbox query (filter to the three known numeric IDs locally before export):

```sql
SELECT id, event_type, status, attempt_count, created_at, next_attempt_at, sent_at,
       cardinality(recipients) AS recipient_count
FROM email_outbox
ORDER BY id;
```

## Local repeatable verification

Use only a disposable test database. The integration harness DROPS its public
schema, applies migrations and truncates fixtures; never point it at development
or deployed data. This session created `committeeflow-bug016-test`, PostgreSQL 17,
bound to `127.0.0.1:55416`, database `committeeflow_test`, with no host volume.
The suite's SMTP fixture is an isolated loopback protocol server and forwards no
messages. Existing Mailpit and Pinggy containers are untouched.
The disposable database container is stopped after verification; start it before
repeating the commands below.

From the repository in PowerShell:

```powershell
docker start committeeflow-bug016-test
$env:TEST_DATABASE_URL='postgres://committeeflow:committeeflow@127.0.0.1:55416/committeeflow_test'
npm run test --workspace server -- tests/integration/outbox-delivery.test.ts tests/integration/audit-notifications.test.ts tests/unit/mailer.test.ts
npm test
npm run typecheck
npm run lint
npm run build
node qa/tools/verify-outbox-migration.mjs
```

Manual local UI/SMTP retest (NOT executed in this session):

1. Start a separate local development database and Mailpit without any tunnel;
   apply the forward migration there. Use only synthetic `.test` recipients.
2. Set SMTP to that local Mailpit, set worker enabled false, and configure a local
   Cron secret privately. Start the API/client; sign in as a synthetic Engineer.
3. Create, update, cancel one booking. Confirm three parent rows and matching
   history entries. Start two concurrent POST requests to
   `/api/internal/process-outbox` with that secret in the Authorization header
   (keep it out of screenshots, shell history and evidence). Drain due work.
4. With up to 50 recipients expect 3 SMTP messages. With exactly 530 recipients
   expect 33 batch messages: 11/event, 50×10 + 30 recipients/event. Verify 530
   unique intended recipients/event, no address exposed in headers and no extra
   sender envelope recipient. Repeat processing; counts must remain unchanged.
5. Stop the local SMTP sink before delivery of a fresh event. Booking must still
   commit; worker must record FAILED/backoff. Restart the sink after due time;
   event must deliver and reach SENT. Do not clear before messages to simplify counts.
6. Run the protocol/DB tests above for partial batch failure, RCPT rejection,
   stalled greeting, accepted DATA without reply, crash recovery and DB commit
   failure; these faults need a controlled fixture, not a fabricated Mailpit screenshot.

## Authorized deployment sequence — not executed

1. Obtain explicit authorization before changing Supabase, Vercel or Cron or
   sending test emails. Preserve before evidence and take a database backup.
2. Pause every old worker source (Cron and process timer); wait for outstanding
   invocations/SMTP sessions to finish. An old binary ignores new leases, so do
   not allow old/new workers to overlap. Review existing unsent/FAILED rows for
   previous possible delivery; do not mass reset/requeue historical rows.
3. Apply migration `1700000000006_outbox-delivery.sql` with the approved migration
   mechanism; deploy the corrected backend while processing remains paused.
   Existing SENT rows stay SENT and are never initialized for delivery. Existing
   eligible unsent rows snapshot their batches on first claim.
4. Configure backend settings: recipient batch 50, SMTP deadline 30000ms, run
   budget 50000ms, lease 120s, ambiguous delay 900s, max attempts 6. Require host
   function duration **greater than** budget plus DB/response overhead (e.g. at
   least 60s if permitted, adjusted using measured overhead). If the platform
   limit is shorter, reduce timeout and budget together; validation enforces
   budget > timeout + 5s and lease > timeout + 10s. Set the Cron HTTP timeout to
   accommodate the run and avoid needlessly overlapping schedules. Use Cron
   rather than an in-process interval for serverless operation.
5. Keep SMTP routed exclusively to the authorized synthetic test sink, verify
   the tunnel and actual recipient count, then resume the corrected worker.
   No code here changes Vercel maxDuration or Supabase Cron automatically.
6. Do not downgrade to the old worker while batch history exists. Pause workers
   and roll forward if a problem occurs. The down migration deliberately refuses
   to discard delivery state; backup restoration requires a delivery reconciliation plan.

## Deployed realistic retest and closure — pending

Repeat the original three-month dataset and mixed 10-user workload with the
synthetic roles and approximately 530 enabled recipients. Record exact enabled
count, commit/build, timestamps, settings and JMeter plan identity. First run a
single lifecycle, then the mixed load; correlate events by parent delivery key
and batches by Message-ID. Exercise two concurrent worker invocations.

For exactly 530 recipients and default batching, acceptance is **3 logical
notifications, 33 SMTP transactions, 1590 recipient-event deliveries**, not
three raw Mailpit messages. Every recipient should get created/updated/cancelled
once in the normal test. Each batch attempt count should be 1 absent faults;
parent totals should be 11, not interpreted as duplicate retries. Compare raw
message count against expected batch count and recipient-event uniqueness.

Export `logs/BUG-016-outbox-after.csv` and `logs/BUG-016-batches-after.csv`:

```sql
SELECT id, delivery_key, event_type, status, attempt_count, sent_at,
       next_attempt_at, (claim_token IS NOT NULL) AS claimed, lease_until,
       cardinality(recipients) AS recipient_count
FROM email_outbox ORDER BY id;
SELECT outbox_id, batch_no, status, attempt_count, in_flight, last_error, sent_at,
       cardinality(recipients) AS original_count,
       cardinality(remaining_recipients) AS remaining_count
FROM email_outbox_batches ORDER BY outbox_id, batch_no;
```

Filter both queries to the test's IDs. Save Mailpit after metadata/screenshot as
`logs/BUG-016-mailpit-after.json` / `screenshots/BUG-016-mailpit-after.png` with the
same redaction rules. Keep all addresses private; locally calculate recipient-
event uniqueness and export counts, or stable anonymous aliases if needed.
Save redacted worker/Cron durations as `logs/BUG-016-worker-after.json` and the
new JTL/HTML report under `performance/BUG-016/retest-<timestamp>/`. Record p50,
p95, p99 HTTP timings separately from queue wait/delivery completion and SMTP
attempt durations; do not claim improved performance from the pre-fix JTL alone.

Reinvoke after completion and verify no new captured messages. With an approved
controlled SMTP interruption, verify retry delay and successful-batch retention.
Use an isolated test fixture to lose DATA acknowledgement; record the known
possible duplicate and bounded retry honestly rather than declaring exactly-once.

Regression: create/update/cancel/no-op writes, history, import summary (one event
per import), notification audiences/opt-out, Viewer write denial and Excel/PDF
exports. Record each actually executed case, outcome and evidence. Deployment
and manual regression remain pending even if local automated suites pass.

Only after successful deployed verification append `## BUG-016` to
`CommitteeFlow_Fix_Comments.md`: conventional summary, 3–5 precise implementation
bullets, actual `Retest:` dataset/build/counts and actual `Regression:` results
plus unchecked cases. Update the journey and defect status together. Do not use
this procedural document as a successful fix comment.
