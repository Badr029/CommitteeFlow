# BUG-017 local verification

Date: 2026-09-13
Database: local disposable PostgreSQL 17 test database
External systems changed: none

This file records the local verification phase. A later deployed functional
retest passed by product-owner review; see `../../BUG-017-Retest.md`. Its raw
after exports and exact timings are not present in this checkout.

## Test-first reproduction

`BUG-017-before-test.txt` preserves the failing pre-fix fairness test. Expected
independent parent B before A's final child; actual index was 3 versus 2.

## Automated results

* Focused outbox/auth run: two files passed, 38 tests passed.
  The outbox file contains 20 durability/fairness/ordering/concurrency tests.
* Full server: 15 files passed; 338 tests passed, four skipped, 342 total.
* Full client: six files passed; 86 tests passed.
* Combined: 424 passed, four skipped.
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
* Impeccable frontend detector: PASS; zero findings across all changed UI files.
* Local visual QA: PASS at desktop and 390 × 844 mobile. Verified the login-
  shaped boot path, required non-dismissible password dialog, account password
  action, `Hide cancelled`, and current-month `Show past days`. A synthetic
  account and disposable local test database were used.

## BUG-017 scenarios

1. Large A and small independent B: both parent lanes progress in one invocation.
2. Three independent parents: a freed lane admits the third parent.
3. Same booking CREATED → UPDATED → CANCELLED: strict order; independent booking
   progresses while CREATED is incomplete.
4. Claim overlap: a later same-booking parent cannot be claimed, but an
   independent parent can.
5. NULL-booking plan events remain serialized.
6. Two concurrent worker invocations over several parents produce no duplicate
   Message-ID and all parents finish once.
7. Slow SMTP permits no more than parent concurrency multiplied by child
   concurrency: six active sends with defaults.
8. An independent parent starts while a large parent's SMTP child remains
   deliberately blocked, regardless of which independent lane starts first.
9. Existing BUG-016 tests continue to cover retry isolation, partial acceptance,
   ambiguous acknowledgement, expired leases, stale-token fencing, crash
   recovery, simultaneous claims, attempt limits and budget resume.

## Structured-log check

A focused synthetic run verified two parent lanes, three concurrent children per
parent, and a six-send default ceiling. Structured fields contain IDs, event
type, counts and timings only; no address, subject, payload, credential, or raw
SMTP error is logged. Synthetic mailer durations are not evidence of deployed
SMTP performance.

An intermediate full run failed because the first version of the added slow-SMTP
test imposed an invalid start order on independent lanes. The failure and test
correction are retained in `BUG-017-slow-test-intermediate.md`; the corrected
focused and full runs above passed.

## Not executed

No deployment, Supabase query/change, Cron change, Pinggy tunnel, Mailpit cleanup,
real-recipient message or deployed JMeter retest was performed. Those remain in
`qa/BUG-017-Retest.md`.
