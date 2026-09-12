# CommitteeFlow — QA journey

This record separates historical documentation, user-reported deployment facts
and checks executed in this session. It does not retroactively claim tests.

| Stage | Evidence and outcome |
|---|---|
| Development and exploratory QA | [BUG-001–015](CommitteeFlow_Bug_Reports.md) record UI, authentication UX, responsive, import and export defects; [fix comments](CommitteeFlow_Fix_Comments.md) record their historical corrections/retests. Original [screenshots](QA-Evidence/screenshots/INDEX.md) and [measurements](QA-Evidence/logs/) retained. |
| Fixing/regression during development | Historical reports distinguish jsdom limitations for hidden elements and browser/font comparison for Arabic PDF rendering. These historical results were inspected, not recreated in this task. |
| Deployment | User reports Vercel backend/frontend and Supabase PostgreSQL/Cron deployment. Build identifier and deployed environment settings remain to be exported. |
| Realistic performance testing | Three-month plan, synthetic Engineer/Viewer accounts, about 530 recipients, mixed 10-user JMeter workload. [Two preserved JTL runs and hashes](QA-Evidence/performance/BUG-016/manifest.json) each contain 307 samples and zero reported HTTP failures. Which run belongs to the reported lifecycle remains to be confirmed. |
| First deployed performance defect | [BUG-016](CommitteeFlow_Bug_Reports.md#bug-016--notifications-deployed-mixed-workload-delivers-repeated-booking-emails): 27 messages for three logical notifications. [Reported outbox counts](QA-Evidence/logs/BUG-016-observation.md) 5/9/13; [read-only Mailpit metadata](QA-Evidence/logs/BUG-016-mailpit-before.json) independently confirms corresponding counts and 530 BCC recipients per message. |
| Technical reproduction and root cause | [Before test](QA-Evidence/logs/BUG-016-before-test.txt) shows two sends under controlled competing workers. Source confirms row locks were released before SMTP without durable claims; exact deployed overlap/timeout sequence remains unverified. |
| Local correction | [Implementation and changed files](BUG-016-Retest.md#implementation-and-acceptance-criteria): durable fenced leases, persistent recipient batches, bounded SMTP sockets/retries, partial acceptance tracking and stable identifiers. [Forward migration](../server/migrations/1700000000006_outbox-delivery.sql) preserves delivery history. |
| Automated retest/regression | [Verification record](QA-Evidence/logs/BUG-016-verification.md): 17 new delivery tests; full suite 327 server + 83 client passes, four unavailable real-workbook cases skipped; typecheck/lint/build pass. Real PostgreSQL and isolated SMTP protocol fixture used. |
| Deployment/manual performance retest | PENDING. [Exact local/deployed procedure and evidence requests](BUG-016-Retest.md). No Supabase/Vercel changes or external email sending authorized/performed. |
| Fix comment/closure | PENDING successful deployed retest. [Fix-comment register](CommitteeFlow_Fix_Comments.md) intentionally has no successful BUG-016 entry yet. Update it, this journey and the bug status only with actual results. |

This lifecycle demonstrates why HTTP performance success is insufficient:
the JMeter requests passed while notification side effects duplicated. Application
and database knowledge made it possible to reproduce the worker race, correct
the claim lifetime and test failure boundaries. Generic SMTP ambiguity remains
explicitly documented rather than hidden behind a premature SENT update.

No feature was implemented and no feature log was created. Future features need
their own requirement, acceptance criteria, implementation/test/evidence links
and deployment status, separate from the defect count.
