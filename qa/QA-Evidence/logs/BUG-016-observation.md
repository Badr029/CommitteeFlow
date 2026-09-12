# BUG-016 — original observation

Recorded 2026-09-12 from the user's task description; not an independently
captured database or Mailpit export.

Discovery: first deployed performance defect, after development/exploratory QA,
fixes, regression and deployment to Vercel/Supabase.
Environment: Nodemailer SMTP → temporary Pinggy TCP tunnel → local Mailpit;
Supabase PostgreSQL/Cron; realistic three-month plan; synthetic Engineer/Viewer
accounts; approximately 530 enabled recipients; mixed 10-user JMeter workload.

| Event | Reported final status | Reported attempts |
|---|---|---:|
| Created | SENT | 5 |
| Updated | SENT | 9 |
| Cancelled | SENT | 13 |

Reported Mailpit total: 27 rather than 3. Attempts sum to 27. This correlation
does not distinguish overlapping workers from SMTP acknowledgement loss.
Actual deployed build, timeout settings, job overlap and SMTP responses remain
unverified until original exports are supplied.

Source inspection before implementation: claimDueMessages only SELECTs with
FOR UPDATE SKIP LOCKED. processOutboxBatch commits that transaction before SMTP;
no claim state survives COMMIT. markSent/markFailed are unfenced updates, and
attempts increment after delivery. No lease, batch state or stable Message-ID
exists. The timer's process-local guard does not cover the internal Cron route.
The mailer submits all recipients in one transaction and ignores accepted/
rejected recipient results. Its visible To sender is also an envelope recipient
because no explicit envelope is supplied. Exact deployed causal contribution
of each finding is not yet established.

## Subsequent read-only corroboration

`BUG-016-mailpit-before.json` was captured from the existing local Mailpit API
after the local implementation/testing work. The new tests used their own SMTP
fixture; they did not send anything to Mailpit. The API returned all 27 messages:
5 created, 9 updated and 13 cancelled, three distinct subjects and 27 unique
Message-IDs. Every message listed 530 BCC recipients and one visible To recipient.
Original message timestamps span 2026-09-12 12:36:49.341Z to 12:43:19.164Z.
Names, addresses, subject text, body and snippets were omitted. No message was
deleted, edited or marked read. Database attempt counts/final states remain
user-reported; the message count is now independently observed.

The local PostgreSQL reproduction is `BUG-016-before-test.txt`: the original
worker sends twice under a controlled overlap. The post-change full suite is
`BUG-016-full-tests.txt`. Neither establishes the exact deployed timeout/overlap
sequence without the original worker and database evidence.

## Supplied Supabase screenshot

Original preserved without alteration as
`../screenshots/BUG-016-outbox-before.png`. This is user-captured evidence,
not a database query executed by Codex.

| Outbox ID | Event | Status | Attempts | Recipients |
|---|---|---|---:|---:|
| 56 | BOOKING_CREATED | SENT | 5 | 530 |
| 57 | BOOKING_UPDATED | SENT | 9 | 530 |
| 58 | BOOKING_CANCELLED | SENT | 13 | 530 |

All three rows show the same booking ID. The screenshot corroborates the
previously reported final states and attempt counts. Cron/worker timing evidence
is still pending. No database changes, commits or deployment performed.
