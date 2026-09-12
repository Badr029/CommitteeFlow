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
| BUG-017 local correction | One child per scheduling quantum, current-time requeue, two bounded parent lanes and booking-scoped predecessor ordering. Durable BUG-016 safety remains intact; no schema/client/dependency change. |
| BUG-017 automated regression | [Verification](QA-Evidence/logs/BUG-017-verification.md): 45 focused passes; full suites 335 server + 83 client passes with four pre-existing skips; typecheck, lint, build, migration compatibility, Compose config and diff check pass. |
| BUG-017 deployment/manual performance retest | PENDING. Follow the [safe deployment, SQL/log evidence and pass/fail procedure](BUG-017-Retest.md). No cloud, Cron, tunnel, Mailpit or external mail action was performed here. |

The main QA lesson is that HTTP throughput and success are only one layer.
Notification correctness needs durable database state, SMTP correlation and
worker timing evidence. The application/backend investigation enabled controlled
reproductions and fixes, while the reports keep unmeasured deployment hypotheses
explicitly unverified.

No feature was implemented and no feature log was created. Future features need
their own requirement, acceptance criteria, implementation/test/evidence links
and deployment status, separate from the defect count.
