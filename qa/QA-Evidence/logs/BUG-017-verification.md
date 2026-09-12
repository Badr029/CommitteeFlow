# BUG-017 local verification

Date: 2026-09-12
Database: disposable PostgreSQL 17 container on loopback port 55416
External systems changed: none

## Test-first reproduction

`BUG-017-before-test.txt` preserves the failing pre-fix fairness test. Expected
independent parent B before A's final child; actual index was 3 versus 2.

## Automated results

* Focused outbox, audit and mailer run: 3 files passed, 45 tests passed.
  The outbox file contains 19 tests: 11 BUG-016 durability tests and eight
  BUG-017 fairness/ordering/concurrency tests.
* Full server: 15 files passed; 335 tests passed, four skipped, 339 total.
* Full client: five files passed; 83 tests passed.
* Combined: 418 passed, four skipped.
* Typecheck: server and client PASS.
* Lint: server and client PASS with zero warnings.
* Production build: client Vite build and server TypeScript build PASS. A first
  sandboxed build attempt failed with Windows `EPERM` while deleting generated
  `client/dist/assets`; the unchanged command with repository write access
  passed. No compiler or bundler defect was involved.
* Migration verification: PASS. Legacy SENT/PENDING rows preserved, delivery
  keys present, down migration refused as designed, verification transaction
  rolled back.
* Docker Compose configuration: PASS with synthetic required placeholders; no
  service was created or changed.
* `git diff --check`: PASS; only Git's LF-to-CRLF notices appeared.

## BUG-017 scenarios

1. Large A and small independent B: B progresses before A completes.
2. Three independent parents: smaller parents progress before A's final batch.
3. Same booking CREATED → UPDATED → CANCELLED: strict order; independent booking
   progresses while CREATED is incomplete.
4. Claim overlap: a later same-booking parent cannot be claimed, but an
   independent parent can.
5. NULL-booking plan events remain serialized.
6. Two concurrent worker invocations over several parents produce no duplicate
   Message-ID and all parents finish once.
7. Slow SMTP permits no more than the configured two active sends per invocation.
8. An independent parent starts while a large parent's SMTP child remains
   deliberately blocked, regardless of which independent lane starts first.
9. Existing BUG-016 tests continue to cover retry isolation, partial acceptance,
   ambiguous acknowledgement, expired leases, stale-token fencing, crash
   recovery, simultaneous claims, attempt limits and budget resume.

## Structured-log check

A focused synthetic run emitted two simultaneous lanes, then scheduled parent 3
before parent 1's final child. Summary: `sent=3`, `failed=0`,
`attemptsStarted=6`, `parentConcurrency=2`, `stopReason=NO_ELIGIBLE_WORK`.
Fields contain IDs, event type, counts and timings only; no address, subject,
payload, credential or raw SMTP error is logged. Synthetic mailer durations of
zero milliseconds are not evidence of deployed SMTP performance.

An intermediate full run failed because the first version of the added slow-SMTP
test imposed an invalid start order on independent lanes. The failure and test
correction are retained in `BUG-017-slow-test-intermediate.md`; the corrected
focused and full runs above passed.

## Not executed

No deployment, Supabase query/change, Cron change, Pinggy tunnel, Mailpit cleanup,
real-recipient message or deployed JMeter retest was performed. Those remain in
`qa/BUG-017-Retest.md`.
