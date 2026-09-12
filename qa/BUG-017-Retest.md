# BUG-017 — outbox fairness and throughput retest

Status: local correction verified; deployment and realistic SMTP retest pending.
No Vercel, Supabase, Cron, Pinggy or Mailpit state was changed in this work.

## Outcome and evidence boundary

The worker no longer drains one large parent before eligible independent parents.
Each successful child batch is one scheduling quantum: the unfinished parent is
requeued behind older eligible parents, and one invocation runs at most two
parent lanes by default. Durable BUG-016 claims, child batches, retry counters,
stable Message-IDs and acknowledgement fencing remain in use.

The observed `149`-advances-while-`150`–`157`-stay-at-zero state is explained by
the old claim policy: parent 149 stayed the oldest eligible row after every child
batch and was reclaimed on the next invocation. The 30-second Cron cadence is
verified from the supplied Cron export. The exact reason only one SMTP batch ran
per invocation is not verified: the code requires more than SMTP timeout + five
seconds before starting another send, but no deployed per-send duration or
function-runtime log was supplied. Pinggy latency is therefore a hypothesis, not
a confirmed root cause. The reported 49.5-minute drain is an estimate, not a
measurement.

## Implemented scheduling policy

1. Claim the oldest due parent that has no unfinished predecessor for the same
   `booking_id`.
2. Treat `booking_id IS NULL` events as one conservative plan-wide ordering
   scope.
3. Start one child batch for that parent, persist the result, release the lease,
   and claim again.
4. Run `OUTBOX_PARENT_CONCURRENCY=2` lanes per invocation (validated range 1–5).
5. Keep the existing global `OUTBOX_BATCH_SIZE` attempt cap and the 50-second
   invocation budget. Do not start an SMTP attempt unless the remaining budget
   exceeds `SMTP_SEND_TIMEOUT_MS + 5000`.
6. A permanently failed predecessor intentionally blocks later events for the
   same booking until an operator reconciles it; unrelated booking scopes remain
   eligible.

This is bounded concurrency per process, not a global Vercel-instance limit.
Database leases and child-batch fencing remain the duplicate-delivery controls
when multiple invocations overlap.

## Changed files

| File | Change |
|---|---|
| `server/src/modules/notifications/outbox.repository.ts` | Booking-scoped predecessor guard; requeue successful unfinished parents at the current time; claim timing metadata |
| `server/src/modules/notifications/outbox.worker.ts` | Two bounded lanes, one-child scheduling quantum, safe structured timing and stop-reason logs |
| `server/src/config/env.ts` | Validated `OUTBOX_PARENT_CONCURRENCY` setting |
| `.env.example`, `docker-compose.yml` | Default concurrency documented/wired |
| `server/tests/integration/outbox-delivery.test.ts` | Fairness, ordering, overlap, duplicate and slow-SMTP regression tests |
| `server/tests/unit/mailer.test.ts` | Environment default/range tests |

No migration, dependency or client change is required.

## Local verification completed

| Gate | Result |
|---|---|
| Before-fix reproduction | FAIL as expected: independent B appeared after all three A batches |
| Focused outbox/audit/mailer tests | 45 passed |
| Full server suite | 335 passed, 4 skipped |
| Full client suite | 83 passed |
| Typecheck | PASS, both workspaces |
| Lint | PASS, zero warnings |
| Production build | PASS, both workspaces; first sandboxed attempt hit Windows `EPERM` clearing generated `client/dist`, unchanged retry passed |
| Migration 006 compatibility | PASS; legacy rows preserved, down migration refused, transaction rolled back |
| Docker Compose config | PASS with synthetic required values |
| `git diff --check` | PASS; line-ending notices only |

See [verification](QA-Evidence/logs/BUG-017-verification.md), [analysis](QA-Evidence/logs/BUG-017-analysis.md),
[before test](QA-Evidence/logs/BUG-017-before-test.txt), and the
[performance baseline manifest](QA-Evidence/performance/BUG-017/baseline-manifest.json).

## Safe deployment sequence — not performed

1. Preserve the current database, Vercel worker, Cron and Mailpit/Pinggy evidence.
2. Pause only the notification Cron immediately before deployment. Allow an
   active invocation to finish; otherwise wait for/reconcile its lease. Do not
   reset attempts or delete outbox rows.
3. Deploy the backend containing this change. No database migration is needed.
4. Set `OUTBOX_PARENT_CONCURRENCY=2`; retain `DB_POOL_MAX=3` and the existing
   BUG-016 batch, lease, timeout, retry and budget values.
5. Verify the deployed function duration exceeds the 50-second worker budget
   plus response/database margin. This setting is not versioned in the repo.
6. Keep the in-process serverless worker disabled and the authenticated internal
   worker route enabled for Cron only.
7. Point SMTP at the synthetic Mailpit/Pinggy sink. Record a clean Mailpit count
   without deleting the interrupted-run evidence.
8. Re-enable the existing 30-second Cron. Do not shorten it to hide a scheduler
   defect.

## Realistic retest

Use the existing v3 runner and its supplied datasets. Run the 30-user mixed plan
against the frontend domain after creating three independent booking lifecycles:
large A, smaller B, and small C. Use synthetic users and recipients only.

```powershell
powershell -ExecutionPolicy Bypass -File ".\Run-CommitteeFlow-Performance.ps1" `
  -TestPlan ".\performance-tests\07-CommitteeFlow-Realistic-Mixed-30-Users.jmx" `
  -BaseDomain "committeeflow.vercel.app"
```

Record exact start/end times; do not describe elapsed time as measured unless
those timestamps are preserved. Capture redacted worker JSON logs containing
`runId`, `lane`, `outboxId`, event type, child batch, attempt, recipient count,
queue wait, SMTP duration, remaining budget, outcome and stop reason. Never
capture recipients, subject, payload, credentials, authorization headers or raw
SMTP errors.

### Read-only SQL evidence

Replace the placeholders with only the new synthetic parent IDs.

```sql
SELECT id, delivery_key, event_type, status, attempt_count, created_at,
       sent_at, next_attempt_at, (claim_token IS NOT NULL) AS claimed,
       lease_until, cardinality(recipients) AS recipient_count
FROM email_outbox
WHERE id = ANY (ARRAY[<parent_ids>])
ORDER BY id;

SELECT outbox_id, batch_no, status, attempt_count, in_flight,
       last_error, sent_at, cardinality(recipients) AS original_count,
       cardinality(remaining_recipients) AS remaining_count
FROM email_outbox_batches
WHERE outbox_id = ANY (ARRAY[<parent_ids>])
ORDER BY outbox_id, batch_no;

SELECT id, booking_id, event_type, status, created_at, sent_at
FROM email_outbox
WHERE id = ANY (ARRAY[<parent_ids>])
ORDER BY booking_id, id;
```

SQL can prove final durable state and event order. It cannot prove SMTP duration,
the moment each child started, or why an invocation stopped; use the new worker
logs for those facts.

## Pass/fail criteria

Pass only when all are true:

* The mixed run has 506 API samples, zero functional failures, and latency in the
  same general class as the valid 2.49–2.60 second p95 baselines; this is a
  comparison guard, not a newly invented SLA.
* All nine synthetic lifecycle parents become SENT. With 530 recipients and
  50-recipient batches, the expected clean result is 99 SENT child batches.
* In an unfaulted run every child has one attempt, Mailpit increases by exactly
  99, and all 99 stable Message-IDs are unique.
* B and C start/progress before A completes; the evidence comes from worker logs,
  not final SQL alone.
* Created, updated and cancelled events for one booking never overtake one
  another, while independent bookings make progress.
* A second worker invocation does not resend a SENT child or create an extra
  message.
* One invocation never exceeds two simultaneous SMTP attempts with the proposed
  setting, and API behavior remains healthy.

Fail on duplicate Message-ID/delivery, same-booking reordering, independent
parent starvation, more than two concurrent sends in one invocation, stuck
active leases/batches, or material API failures/regression.

## Still unverified

Deployment of this fix; actual Vercel function duration; deployed SMTP send
durations; the precise budget-stop sequence; Pinggy's latency contribution;
aggregate concurrency across Vercel instances; and a clean end-to-end 99-batch
drain. BUG-016's corrected deployed 3-event/33-batch retest is user-reported but
its after exports are absent from this checkout, so it is not portfolio-grade
closure evidence here.
