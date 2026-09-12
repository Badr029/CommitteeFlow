# BUG-016 — supplied Cron execution history

Source: user pasted results of the read-only cron.job_run_details query for
2026-09-12 12:33–12:45 UTC. Exact supplied values preserved in
`BUG-016-cron-before.csv`; not queried directly by Codex.

23 runs, job 1, run IDs 948–970, all SQL executions marked succeeded.
Start times are approximately 30 seconds apart. Rounded SQL durations are
0.00–0.01 seconds, not proof of SMTP success or backend execution duration.

Pending: inspect the job invocation method without exporting its command or
secrets. If it uses pg_net, HTTP runs asynchronously; successful SQL execution
does not prove HTTP completion. Source: https://supabase.com/docs/guides/database/extensions/pg_net

These records alone do not prove overlapping backend invocations. HTTP response
records/Vercel request timings are still required. No deployed changes or commits.
