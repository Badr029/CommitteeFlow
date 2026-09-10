# Implementation status

Tracked against the specification's MVP boundary (spec §73) and its recommended
build order (spec §80). Section numbers refer to
[`product-spec.md`](product-spec.md).

Last verified: 180 server tests, 33 client tests, both workspaces typecheck and
lint with zero warnings, production build and Docker image both succeed.

> **One gap, honestly stated.** The final three server changes — moving
> `/api/health` in front of the session middleware, the fail-fast schema check,
> and promoting `node-pg-migrate` to a runtime dependency — were typechecked,
> linted and reviewed, but the 180-test server suite has **not** been re-run
> against them, and `docker compose up` has not been re-verified after them. The
> development machine's system drive filled to 100% and wedged the Docker daemon,
> which both the test database and the compose stack depend on. Free space on
> `C:` and run `npm run db:up && npm test` to close it. See
> [Verification performed](#verification-performed).

---

## MVP boundary — BUILD NOW (spec §73)

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Authentication | ✅ | `server/src/modules/auth`, PostgreSQL session store |
| 2 | Two roles | ✅ | `PROJECT_ENGINEER`, `VIEWER` — enforced server-side |
| 3 | Restricted plan-config permission | ✅ | `can_manage_plan_configuration`, a flag not a third role |
| 4 | Committee Plan | ✅ | `client/src/features/plan` — home and default route |
| 5 | Previous / current / future month navigation | ✅ | Month key in the URL, so a view is shareable |
| 6 | Future-month booking | ✅ | Bounded by the confirmed 6-month horizon |
| 7 | Create booking | ✅ | `POST /api/bookings` |
| 8 | Edit booking | ✅ | `PATCH /api/bookings/:id`, optimistic concurrency |
| 9 | Cancel booking | ✅ | `POST /api/bookings/:id/cancel` — never a DELETE |
| 10 | Created/updated ownership and timestamps | ✅ | Shown on the detail view |
| 11 | Booking history | ✅ | `booking_history`, written in the same transaction |
| 12 | Activity | ✅ | `client/src/features/activity`, paginated |
| 13 | Search / filter | ✅ | Text, committee, status, creator, only-mine, show-cancelled |
| 14 | Create/update/cancel notifications | ✅ | All three events, not just create |
| 15 | Async email outbox | ✅ | Transactional outbox + in-process worker with backoff |
| 16 | Excel export | ✅ | ExcelJS, driven by the plan configuration |
| 17 | PDF export | ✅ | PDFKit, same configuration |
| 18 | Configurable plan fields | ✅ | `plan_field_definitions` |
| 19 | Rename / reorder / show-hide / required | ✅ | Plan Configuration screen |
| 20 | Custom fields | ✅ | Seven types, stored in `custom_fields` JSONB |
| 21 | Archive custom fields | ✅ | Archive and restore; values never deleted |
| 22 | Dynamic form / table / details / export | ✅ | One definition list drives all five surfaces |
| 23 | Docker | ✅ | Multi-stage, non-root, tini, healthcheck |
| 24 | Docker Compose | ✅ | App + PostgreSQL, database not published |
| 25 | PostgreSQL | ✅ | 17, `pg.Pool`, plain-SQL migrations |
| 26 | Logging | ✅ | Pino, structured, with redaction |
| 27 | Health endpoint | ✅ | In front of the session middleware, so it survives a DB outage |
| 28 | Security baseline | ✅ | See the README's security table |
| 29 | Automated tests | ✅ | 213 tests across server, database, frontend and security |

## MVP boundary — DO NOT BUILD NOW (spec §74)

None of these were built. The schema carries `data_source`, `external_reference`
and `users.external_identity_id` so ERP and SSO can arrive later without a
migration — but no integration code exists.

ERP · Oracle · automatic order import · field-source mapping engine · SSO ·
WebSockets · mobile app · microservices · Redis · Kafka · RabbitMQ · Kubernetes ·
analytics · management dashboard · AI · complex permission framework ·
spreadsheet builder.

---

## Build order (spec §80)

| Step | Status |
|---|---|
| 1. Confirm open business rules affecting constraints | ✅ confirmed — see [`open-business-rules.md`](open-business-rules.md) |
| 2. Repo / project structure | ✅ npm workspaces: `client`, `server`, `shared` |
| 3. Docker + PostgreSQL | ✅ dev compose and full compose |
| 4. Migrations / schema | ✅ 3 migrations, up and down, exercised every test run |
| 5. Auth / session foundation | ✅ |
| 6. Roles / permissions middleware | ✅ |
| 7. Plan field definition module | ✅ |
| 8. Booking domain / service | ✅ |
| 9. Booking history / audit | ✅ |
| 10. Email outbox | ✅ |
| 11. REST endpoints | ✅ 23 endpoints |
| 12. Backend tests | ✅ 180 |
| 13. React shell / routing / auth | ✅ |
| 14. Committee Plan month view | ✅ with session grouping |
| 15. Dynamic booking form | ✅ |
| 16. Booking detail / edit / cancel | ✅ |
| 17. Plan Configuration UI | ✅ including the business rules |
| 18. Activity page | ✅ |
| 19. Excel / PDF export | ✅ |
| 20. Email worker / SMTP integration | ✅ falls back to logging when SMTP is unset |
| 21. Security hardening | ✅ |
| 22. Performance / concurrency tests | ✅ genuinely simultaneous requests, not mocks |
| 23. Dockerised MVP deployment | ✅ image builds and runs |
| 24. Real-user workflow test | ⏳ **yours** — see below |

---

## Verification performed

| Gate | Result | Covers the final three server changes? |
|---|---|---|
| `npm run typecheck` | clean, both workspaces | yes |
| `npm run lint` | clean, zero warnings tolerated | yes |
| `npm run test:client` | 33 passed, 2 files | n/a — client only |
| `npm run build` | SPA + server compile | yes |
| `npm run test:server` | 180 passed, 9 files | **no — re-run needed** |
| `docker build` | image builds | **no — re-run needed** |
| `docker compose up` | app connects to PostgreSQL and serves the SPA | **no — re-run needed** |
| Browser walkthrough | sign in, plan, booking drawer, session preview, create, detail, history, activity, plan configuration, dark mode | partly |
| Contrast audit | every text/background pair ≥ 4.5:1 in both palettes | yes |

To close the gap:

```bash
npm run db:up && npm test && docker compose up -d --build
```

The three changes are low-risk by inspection — `/api/health` still sits behind
Helmet so the security-header assertions hold, the schema check runs only in
`server.ts` and never in the `createApp()` the tests exercise, and the dependency
move touches no code — but "low-risk by inspection" is not "tested".

### Defects found and fixed during verification

1. `--ink-muted` failed contrast at 11px in light mode (3.76:1). Token derived
   from the requirement instead of by eye.
2. The app shell used `min-height` rather than `height`, so the document scrolled
   and the sticky column and day headings never engaged.
3. The theme bootstrap was an inline `<script>`, which the CSP correctly blocked.
   Moved to `/theme-init.js` rather than weakening `script-src 'self'`.
4. `node-pg-migrate` was a devDependency, so the pruned production image could
   not migrate its own database.
5. `/api/health` sat behind the session middleware and returned 500 when the
   session table was missing — precisely when it most needed to answer.
6. The Dockerfile copied per-workspace `node_modules` directories that npm
   workspaces never create.
7. The required-field asterisk was `aria-hidden`, so screen readers never learned
   a field was required. Added `aria-required` on the control.
8. The client `typecheck` script masked its own failure with a `||` fallback, and
   emitted stray `.js` files into `src/`.

---

## Left for you

**Real-user workflow test (spec §80 step 24, §83).** Everything is verified
mechanically and by walking the interface, but the MVP's own success criterion is
that the real team can run the current workflow with less manual coordination.
That needs the actual engineers, on the actual September plan.

**Before real internal use:**

1. Set a real `SESSION_SECRET` and `POSTGRES_PASSWORD`.
2. Put HTTPS in front of it, then set `COOKIE_SECURE=true` and `TRUST_PROXY=1`.
3. Point `SMTP_HOST` at company SMTP. Until then, emails are logged, not
   delivered — deliberately visible in the log rather than silently dropped.
4. Create the real accounts and change the seeded password.
5. Schedule PostgreSQL backups and test a restore.
6. Decide the remaining open questions in
   [`open-business-rules.md`](open-business-rules.md) — none block the trial:
   password policy and account lifecycle, whether committee names and statuses
   should become fixed lists, retention, and notification batching.

**Specification updates worth making**, so the document and the system stay in
step (detailed in the README):

- §46 / §78.1 can be marked resolved: committee sessions are shared.
- §8's "one date = one booking" warning extends to "one session = one booking".
- Committee Sessions should be described as a product concept.
- `app_settings` and `GET /api/bookings/session-preview` should be added to §32
  and §38.
