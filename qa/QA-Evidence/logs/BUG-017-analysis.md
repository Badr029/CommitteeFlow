# BUG-017 analysis — parent fairness after BUG-016

> Historical analysis note: the one-child rotation design described below was
> the first local correction. It was superseded on 2026-09-13 by the accepted
> refinement: two parent lanes, three concurrent child batches per parent, and
> an asynchronous Supabase `pg_net` wake with the 30-second Cron retained as
> fallback. See `../../BUG-017-Retest.md` for the active design.

Date: 2026-09-12

## Confirmed from source and supplied evidence

* Supabase Cron is scheduled every 30 seconds and calls the internal worker
  asynchronously through `pg_net`.
* The BUG-016 worker claimed one parent and drained its child batches in an inner
  loop until completion, failure or the budget guard.
* A successful unfinished parent retained its old `next_attempt_at`. Once its
  lease was released, it remained older than untouched parents and was selected
  again by the next non-overlapping invocation.
* The screenshot shows parents 56–58 for one booking as SENT with 5/9/13 attempts
  and 530 recipients. The later parent-149/150–157 observation is supplied in the
  handoff; its original database export is not present in this checkout.
* The pre-fix regression test failed because the independent parent was sent
  fourth, after all three child batches of the large parent.

Conclusion: parent selection and drain policy is sufficient to explain the
fairness defect. Cron cadence controls how often the defect is visible; it does
not create the starvation policy.

## Plausible but not proved

The worker's guard starts another SMTP transaction only with more than
`SMTP_SEND_TIMEOUT_MS + 5000` remaining. With a 50-second run budget and a
30-second SMTP timeout, an SMTP send lasting over roughly 15 seconds would leave
too little guarded time for a second send. That is compatible with one batch per
Cron tick, but no supplied worker log records SMTP duration or a `RUN_BUDGET`
stop. The temporary Pinggy tunnel may add latency, but its contribution is not
measured. Do not cite either as the confirmed root cause.

The old durable lease allowed another invocation to claim an independent parent
while the first parent was leased. The observed untouched parents suggest there
was no effective overlap at that time, but available evidence cannot prove
serverless invocation overlap or absence of overlap.

## Implemented correction

The claim query rejects a parent while an unfinished lower-ID event exists in
the same booking scope. Successful unfinished parents receive a current
`next_attempt_at`, release their lease after one child, and re-enter the global
due queue. Two bounded lanes let independent scopes progress concurrently.
NULL-booking plan events are serialized conservatively. Existing durable child
state, attempt-before-send accounting, stable Message-ID and claim fencing are
unchanged.

No schema change was necessary. Existing indexes and migration 006 remain valid.
At much larger queue scale, the predecessor anti-join should be measured before
adding an index; no speculative migration was added for the current evidence.

## Performance evidence interpretation

The newest worker-on 30-user run contains 506 API samples, zero HTTP assertion
failures, 1208.77 ms mean, 2494 ms p95 and 5.096 requests/second. It proves API
health during the interrupted SMTP drain, not notification completion or
fairness. Exact source paths, hashes and all six comparison runs are recorded in
`../performance/BUG-017/baseline-manifest.json`.

## Safety boundary

Generic SMTP still cannot provide exactly-once delivery across SMTP acceptance
and the PostgreSQL acknowledgement commit. BUG-016's ambiguous-delivery cooldown
and stable Message-ID reduce/reveal the risk but do not make SMTP transactional.
This change addresses scheduling fairness and bounded throughput; it does not
claim impossible exactly-once semantics.
