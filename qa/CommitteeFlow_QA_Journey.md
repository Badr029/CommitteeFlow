# CommitteeFlow — QA journey

This record separates historical documentation, user-reported deployment facts,
source-backed conclusions and checks executed in this repository. It does not
retroactively claim tests or convert estimates into measurements.

| Stage | Evidence and outcome |
|---|---|
| Development and exploratory QA | [BUG-001–015](CommitteeFlow_Bug_Reports.md) cover UI, authentication UX, responsive, import and export defects. Historical [fix comments](CommitteeFlow_Fix_Comments.md), [screenshots](QA-Evidence/screenshots/INDEX.md) and measurements remain intact. |
| Deployment | User reports Vercel frontend/backend and Supabase PostgreSQL/Cron. The deployed build ID, function-duration setting and complete environment export remain missing. |
| First realistic workload | A three-month plan, synthetic Engineer/Viewer users and about 530 notification recipients exposed [BUG-016](CommitteeFlow_Bug_Reports.md#bug-016--notifications-deployed-mixed-workload-delivers-repeated-booking-emails). API JTL success did not reveal duplicate side effects. |
| BUG-016 evidence | Outbox attempts 5/9/13 were user-reported; [Mailpit metadata](QA-Evidence/logs/BUG-016-mailpit-before.json) independently confirms 27 messages in those event groups and 530 BCC recipients each. Local source/test evidence proved the unfenced-worker duplicate path, without claiming the exact deployed overlap sequence. |
| BUG-016 correction | Durable UUID leases, persistent 50-recipient child batches, attempt-before-send accounting, stable Message-IDs, partial acceptance, bounded SMTP behavior and conservative ambiguous-result recovery were implemented and locally verified. [Retest record](BUG-016-Retest.md). |
| BUG-016 deployed follow-up | A clean three-event/33-child-batch lifecycle without the old duplicate pattern is user-reported. After database/Mailpit/worker exports, build ID and exact elapsed timestamps are absent from this checkout; portfolio-grade closure remains evidence-incomplete. |
| Performance scaling | Six v3 JTLs record the pool/worker progression. The latest worker-on 30-user run has 506 API samples, zero failures, 1208.77 ms mean, 2494 ms p95 and 5.096 requests/second. The SMTP drain was interrupted, so these are API results only. [Exact paths and hashes](QA-Evidence/performance/BUG-017/baseline-manifest.json). |
| Second deployed performance defect | [BUG-017](CommitteeFlow_Bug_Reports.md#bug-017--notifications-one-large-outbox-parent-starves-independent-notification-events): a large parent repeatedly retained oldest eligibility while independent parents remained untouched. The 30-second Cron cadence is verified; actual SMTP duration, budget stop and Pinggy contribution are unverified. |
| BUG-017 test-first reproduction | [Before test](QA-Evidence/logs/BUG-017-before-test.txt) failed as intended: independent B was fourth, after A's three child batches. [Causal analysis](QA-Evidence/logs/BUG-017-analysis.md) separates confirmed scheduling behavior from timing hypotheses. |
| BUG-017 refined local correction | Two parent lanes each drain durable child batches in waves of three, with a six-send per-invocation bound, booking-scoped predecessor ordering, and an asynchronous Supabase `pg_net` wake. The 30-second Cron remains fallback. |
| Current automated regression | [Verification](QA-Evidence/logs/BUG-017-verification.md): full suites 338 server + 86 client passes with four pre-existing skips; final lint/build/diff results recorded there. |
| BUG-017 deployment/manual performance retest | PASS by product-owner review on 2026-09-13: 9/9 parents `SENT`, 99 expected child batches complete, no duplicate observed and same-booking ordering retained. Raw SQL/Mailpit/worker exports, build ID and exact timings are missing from this checkout, so those details remain user-attested rather than portfolio-verified. |
| Authentication and plan regression | [BUG-018–026](CommitteeFlow_Bug_Reports.md#bug-018--sign-in-protected-plan-skeleton-flashes-before-authentication-resolves) record the login skeleton, route return, search clear, password, Cairo-time booking, current-month and cancelled defaults, and session-persistence work. Screenshots 391/392/399 are the only supplied images in scope. |
| Continuation verification | Typecheck, lint and production build pass; 29 targeted client tests and 108 server unit tests pass (3 skipped). A full client run passed 88 tests with one load-related timeout; that test's complete 13-test file passed immediately in isolation. Server integration rerun was blocked by unavailable local Docker/PostgreSQL, and deployed mobile/session retest remains pending. |

The main QA lesson is that HTTP throughput and success are only one layer.
Notification correctness needs durable database state, SMTP correlation and
worker timing evidence. The application/backend investigation enabled controlled
reproductions and fixes, while the reports keep unmeasured deployment hypotheses
explicitly unverified.

New behavior is tied to BUG-018–026 rather than presented as untracked feature
work. Deployment status and missing evidence remain explicit.
