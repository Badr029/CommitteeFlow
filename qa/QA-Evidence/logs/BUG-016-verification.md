# BUG-016 — verification record (2026-09-12)

Status: local correction verified; deployed defect remains open.
Environment: Windows, Node 24.20.0, disposable PostgreSQL 17 Docker container
`committeeflow-bug016-test` on loopback port 55416; no persistent host volume.
SMTP tests use an isolated loopback protocol fixture that never forwards mail.
The existing Mailpit was read through its metadata API only; Pinggy was untouched.

| Execution | Actual result / evidence |
|---|---|
| Original worker competing-send test | Expected failure: two sends instead of one. [Before](BUG-016-before-test.txt). |
| Intermediate focused runs | Failures retained in [first](BUG-016-focused-test.txt) and [second](BUG-016-focused-test-2.txt) logs: obsolete raw-error assertion; a test expired a SENT row without a token. Assertions/fixtures corrected, not delivery requirements weakened. |
| Full `npm test` | [Output](BUG-016-full-tests.txt): 327 server passes, four skips; 83 client passes. All 11 new PostgreSQL delivery tests and six new SMTP/config tests passed. |
| Migration from legacy schema/rows | [Output](BUG-016-migration-check.txt): prior SENT count/time and pending state retained; delivery keys added; down migration refused as designed. Isolated schema transaction rolled back. [Script](../../tools/verify-outbox-migration.mjs). |
| `npm run typecheck` | [Final pass](BUG-016-typecheck-final.txt). Earlier [failure](BUG-016-typecheck.txt) retained: test row needed a defined-value assertion. |
| `npm run lint` | [Final pass](BUG-016-lint-final.txt), both workspaces, zero warnings. |
| `npm run build` | [Pass](BUG-016-build.txt), SPA and server. [Server recompile](BUG-016-server-build-final.txt) after adding the startup schema prerequisite passed. |
| Docker Compose configuration | [Final pass](BUG-016-compose-check-final.txt), explicit synthetic placeholders, no services started. [Initial failure](BUG-016-compose-check.txt) lacked required POSTGRES_PASSWORD; Docker config access warning remained non-blocking. |
| Diff whitespace | `git diff --check` passed after removing a trailing blank line. |
| Manual local UI/real SMTP and deployed load retest | NOT RUN; [procedure](../../BUG-016-Retest.md). No new Mailpit emails sent. |

Automated regression covered booking lifecycle/history/outbox atomicity and
concurrency, authorization/session/CSRF, audience filtering, import summary,
plan access/configuration, Excel/PDF exports and client workflows. Four optional
real-workbook cases (three unit, one integration) skipped because the existing
fixture resolver did not find its workbook. Existing codepage warnings appeared
in workbook tests; passing synthetic tests do not replace those skipped cases.
No Docker image build, live UI walkthrough or deployed performance improvement
is claimed.

Decisions: one logical parent event with durable child batches; defaults 50
recipients, 30-second SMTP deadline, 50-second run budget, 120-second lease,
900-second ambiguous retry delay and six tries per batch. SQL fencing and attempt
accounting precede SMTP, but SENT follows acknowledgement. Partial accepted
recipients and completed batches are retained. Generic SMTP uncertainty is
bounded and documented, not eliminated. No new dependency or API payload change.

Files changed: notification repository/worker/mailer, environment validation and
example, Docker environment mapping, server startup schema prerequisite, forward
migration, two new delivery test files, audit test and recording harness, QA
register/README/journey/retest guide, migration-check tool and evidence files.
The pre-existing one-line diff in `server/src/app.ts` remains untouched.
The root README already contains merge markers; it was inspected and left
outside this defect's scope. No existing evidence was overwritten.

Database/environment: only the disposable local test database was migrated;
the dedicated migration-check schema was rolled back. The test container was
stopped after verification. Deployment requires an authorized forward migration
and coordinated pause of old workers before the corrected build starts; review
historical ambiguous rows before resuming. No changes were made to Supabase,
Vercel, Cron, production data or real credentials. No push or deployment performed.

Next: supply original outbox and redacted worker/Cron exports, confirm the affected
JMeter run/build, authorize deployment separately, then execute the realistic
retest. With 530 recipients and batch size 50, expect 33 raw SMTP batch messages
for three events and exactly three messages per recipient in normal delivery.
Append the actual deployed Retest/Regression fix comment only after it passes.
