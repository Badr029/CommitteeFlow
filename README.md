# CommitteeFlow

**Live Committee Planning & Booking System for industrial operations.**

React · Node.js · PostgreSQL · Docker

CommitteeFlow replaces the manually maintained monthly Committee Plan spreadsheet
and its repeated email-attachment cycle with one live, shared, auditable plan.
Project Engineers book committee slots; everyone else always sees the current
state. Excel and PDF exports remain available, but they are **snapshots** — the
application is the source of truth.

The full product specification is in [`docs/product-spec.md`](docs/product-spec.md).
Section references throughout the codebase (`spec §46`) point at it.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Running the full stack in Docker](#running-the-full-stack-in-docker)
- [Environment variables](#environment-variables)
- [Commands](#commands)
- [Architecture](#architecture)
- [Importing a Committee Plan](#importing-a-committee-plan)
- [Business rules](#business-rules)
- [Security](#security)
- [Testing](#testing)
- [Deployment notes](#deployment-notes)
- [Where the implementation differs from the specification](#where-the-implementation-differs-from-the-specification)

---

## What it does

The primary action is **Book Committee Slot**. Everything supports that loop:

```
Engineer opens the Committee Plan
        ↓  finds the month (past, current or future)
        ↓  books a slot — or adds a project to an existing committee session
        ↓  the plan updates immediately for everyone
        ↓  creator and timestamp are recorded
        ↓  a notification is queued and sent asynchronously
        ↓  the change is in the audit history, permanently
```

**Three screens, deliberately** (spec §6, §7):

| Screen | Who | What |
|---|---|---|
| **Committee Plan** (home) | everyone | Month navigation, search and filters, booking details and history, Excel/PDF export. Project Engineers also create, edit and cancel. |
| **Activity** | everyone | Paginated feed of every change: who, what, from what, to what, when. |
| **Plan Configuration** | `can_manage_plan_configuration` only | Rename, reorder, show/hide and require plan fields; add and archive custom fields; set the booking rules. |

There is no separate Dashboard, Projects, Orders, Customers, My Bookings or
Reports section. *My bookings* is a filter checkbox on the plan, and creating a
booking is an action, not a destination.

### Committee Sessions

A **Committee Session** is one committee sitting at one date and time. A session
holds **several project bookings** — the plan groups `Date → Session → projects`.
Adding a project to an occupied session is normal and is never rejected;
different committees may run in parallel at the same time.

---

## Quick start

**Requirements:** Node.js 22+ (24 recommended), Docker Desktop, and about five
minutes.

```bash
git clone <this repository>
cd CommitteeFlow
npm install
```

```bash
cp .env.example .env
```

Then edit `.env` and set at least:

- `SESSION_SECRET` — generate one with
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
- `SEED_ADMIN_PASSWORD` — the first account's password

Start PostgreSQL (the application itself runs on the host, so Vite HMR stays fast):

```bash
npm run db:up
```

Create the schema and the first account:

```bash
npm run migrate:up
npm run seed
```

Run both halves:

```bash
npm run dev
```

- SPA with hot reload: <http://localhost:5173>
- API: <http://localhost:4000/api>

The Vite dev server proxies `/api` to the Node server, so the session cookie
behaves in development exactly as it does in production, where one process
serves both.

### Optional demo accounts

For exercising role behaviour during internal testing:

```bash
npm run seed --workspace server -- --with-demo-users
```

This adds `engineer@committeeflow.local` (Project Engineer) and
`viewer@committeeflow.local` (read-only), both with `SEED_ADMIN_PASSWORD`.
Never run this against a real deployment.

---

## Running the full stack in Docker

One image serves the built SPA and the API; PostgreSQL runs beside it and is
**not published to the network** (spec §64).

```bash
cp .env.example .env      # then set POSTGRES_PASSWORD and SESSION_SECRET
docker compose up -d --build
```

Migrations are run explicitly rather than on boot, so several app containers
starting at once cannot race each other:

```bash
docker compose run --rm committee-app npm run migrate:up --workspace server
docker compose run --rm committee-app npm run seed --workspace server
```

The application is then on <http://localhost:4000> (override with `APP_PORT`).

If you start the app before migrating, it **refuses to serve** and says so:

```
the database has not been migrated — run `npm run migrate:up --workspace server` and start again
```

That is deliberate. A container that starts but answers every request with a 500
looks like a bug; this looks like the missing deployment step it is.

```bash
docker compose logs -f committee-app   # follow the structured logs
docker compose down                    # stop
docker compose down -v                 # stop and delete the database volume
```

---

## Environment variables

Every value is **backend-only**. Nothing here is compiled into the React bundle
(spec §63). See [`.env.example`](.env.example) for the annotated list.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables HSTS and `upgrade-insecure-requests`. |
| `PORT` | `4000` | |
| `DATABASE_URL` | — | **Required.** |
| `TEST_DATABASE_URL` | — | Used only by `npm test`; the suite truncates it. |
| `SESSION_SECRET` | — | **Required**, ≥16 characters. |
| `SESSION_NAME` | `committeeflow.sid` | |
| `SESSION_TTL_HOURS` | `12` | Rolling — activity extends the session. |
| `COOKIE_SECURE` | `false` | **Set `true` behind HTTPS.** |
| `COOKIE_SAMESITE` | `lax` | |
| `TRUST_PROXY` | `0` | Number of proxy hops to trust. `1` behind nginx. |
| `CORS_ORIGINS` | — | Development only; empty in production. |
| `LOG_LEVEL` | `info` | |
| `LOGIN_RATE_LIMIT_WINDOW_MINUTES` | `15` | |
| `LOGIN_RATE_LIMIT_MAX_ATTEMPTS` | `10` | Also the account-lock threshold. |
| `WRITE_RATE_LIMIT_WINDOW_MINUTES` | `1` | |
| `WRITE_RATE_LIMIT_MAX` | `60` | |
| `SMTP_HOST` | — | **Empty means emails are logged, not delivered.** |
| `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USERNAME` / `SMTP_PASSWORD` | | |
| `SMTP_FROM` | | |
| `APP_PUBLIC_URL` | `http://localhost:4000` | Used for the deep link in notification emails. |
| `OUTBOX_WORKER_ENABLED` | `true` | |
| `OUTBOX_POLL_INTERVAL_MS` | `15000` | |
| `OUTBOX_BATCH_SIZE` | `20` | |
| `OUTBOX_MAX_ATTEMPTS` | `6` | Exponential backoff, then the row stays `FAILED` with its error. |
| `SEED_ADMIN_NAME` / `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | | `npm run seed` only. |
| `CLIENT_DIST_PATH` | auto | Where the built SPA lives. Set in the image. |

Secrets never belong in Git, the Dockerfile, or the React bundle.

---

## Commands

Run from the repository root.

| Command | Does |
|---|---|
| `npm run dev` | API and SPA together, both watching. |
| `npm run build` | Builds the SPA then compiles the server. |
| `npm run typecheck` | Type-checks both workspaces. |
| `npm run lint` | ESLint over both workspaces, zero warnings tolerated. |
| `npm test` | Server suite, then client suite. |
| `npm run test:server` | Server only (needs `npm run db:up`). |
| `npm run test:client` | Client only (no database needed). |
| `npm run migrate:up` | Applies pending migrations. |
| `npm run migrate:down` | Reverts the most recent migration. |
| `npm run seed` | Creates the first account. Idempotent. |
| `npm run db:up` / `npm run db:down` | Local PostgreSQL for development and tests. |

Migrations live in [`server/migrations`](server/migrations) as plain SQL with
`-- Up Migration` / `-- Down Migration` sections. Both directions are exercised
by the test suite, which rebuilds the schema from scratch on every run.

---

## Architecture

A **modular monolith** (spec §26). No microservices, no gateway, no queue.

```
Browser
   │  HTTPS
   ▼
React 19 + TypeScript + Vite            client/
   │  REST, session cookie
   ▼
Node 24 + Express 5 + TypeScript        server/
   ├── auth            sessions, passwords, CSRF
   ├── bookings        the booking domain and committee sessions
   ├── plan-config     plan field definitions and business rules
   ├── users           accounts and notification recipients
   ├── audit           booking history, configuration history, activity
   ├── notifications   transactional outbox, worker, SMTP
   └── export          Excel and PDF
   │
   ▼
PostgreSQL 17
   users · bookings · booking_history · plan_field_definitions
   configuration_history · email_outbox · app_settings · session
   │
   ▼
SMTP (asynchronous, never on the request path)
```

`shared/api-types.d.ts` is the HTTP contract. **Both workspaces compile against
it**, so a response shape cannot change on one side without breaking the other's
build.

### The hybrid data model (spec §30)

- Operational fields and today's standard business fields are **real columns**,
  with real constraints.
- **Future custom fields** live in `bookings.custom_fields` (`JSONB`).
- `plan_field_definitions` describes the business-facing layer.

The Committee Plan is configurable; the database schema is not (spec §20). A
field's `field_key` is stable forever; its `label` is free to change.

### One configuration, five surfaces (spec §35, §77)

`plan_field_definitions` drives the booking form, the plan table, the booking
detail view, the Excel export and the PDF export. There is no second column list
anywhere. Rename *Customer Name* to *Client Name* and all five change together.

### Concurrency (spec §47, §48)

- **Edits** use optimistic concurrency. Every booking carries a `version`; a
  stale save returns `409 VERSION_CONFLICT` with the current version so the UI
  can offer to reload. The check is in the `UPDATE ... WHERE version = $n`
  clause, so it is atomic with the write.
- **Slot exclusivity** is enforced inside the write transaction under a
  PostgreSQL advisory lock keyed on the exclusivity key. That holds across
  multiple app containers with no extra infrastructure. The confirmed rule is
  that sessions are *shared*, so nothing is currently rejected — but the
  machinery and its tests are in place if the rule is ever tightened.

### Notifications (spec §50)

A transactional outbox. The booking row, its history entry and its email are
written in **one transaction**; an in-process worker delivers them afterwards
with exponential backoff. SMTP being slow or down cannot delay — let alone fail —
a booking. Workers claim rows with `FOR UPDATE SKIP LOCKED`, so moving the worker
to its own container later is a deployment change, not a rewrite.

### Design

One visual world — an "instrument panel": dense rows, hairline rules, tabular
figures, accent colour spent only on selection and meaning. Light and dark are
the same instrument in two palettes, switched from the top bar and remembered
per browser. Tokens live in [`client/src/styles/tokens.css`](client/src/styles/tokens.css);
every colour is defined once and only redefined for dark.

Barlow is **self-hosted** via `@fontsource`, so the app renders identically on a
machine with no internet access and the CSP needs no external font host.

### Responsive layout

One application, three shapes. The breakpoints come from the content, not from
device names:

| Width | Plan | Navigation | Overlays |
|---|---|---|---|
| `< 768px` — phone | Session agenda | Bottom bar, account menu in the header | Sheets from the bottom edge |
| `768–1099px` — tablet | Session agenda, two columns | Top bar with short labels | Side drawer |
| `≥ 1100px` — desktop | Column table, unchanged | Full top bar | Side drawer |

Desktop starts at 1100px because the plan table needs roughly 1000px before its
columns collide. Below that the plan is the same information — Date → Committee
Session → projects — read down the screen instead of across it, with the
engineering quantities moved to the booking's own screen rather than squeezed
into a column that cannot be labelled.

The choice is made in JavaScript ([`client/src/lib/viewport.ts`](client/src/lib/viewport.ts)),
not by hiding one layout with CSS: rendering both would put two copies of the
plan in the accessibility tree and build a twelve-column grid nobody sees. Only
the presentation forks — the query, the permissions, the session grouping, the
Plan Configuration metadata and the validation are shared by every layout.

Touch surfaces size from `--tap-min` (44px) rather than the desktop's 28px
controls, form inputs are 16px on phones so iOS Safari does not zoom on focus,
and sticky actions clear the home indicator through `env(safe-area-inset-*)`.
Under 460px of height — a phone held sideways — the chrome gives up padding
before the plan gives up space.

---

## Importing a Committee Plan

A Project Engineer can load a month of bookings from a spreadsheet:
**Committee Plan → Import Plan**, beside the exports.

### Supported formats

| Format | Extension |
|---|---|
| Excel workbook | `.xlsx` |
| Excel 97–2003 workbook | `.xls` |
| Comma-separated values | `.csv` |

**PDF is deliberately not supported**, and neither are `.xlsm`, `.xlsb`, `.ods`
or Word documents. Structured spreadsheets are the only formats where the
importer can be confident about what a cell means; anything else would be
guesswork dressed up as data. Each is refused by name, with what to do instead.

### Expected sheet

One row per booking, with a header row naming the columns. These headings are
recognised automatically:

```
Date · Time · OFF No. · Order Name · Committee · Qty · KVA · KV
Status · Serial No. · Project Engineer · Notes · Customer Name
```

A **Day** column is not needed — the weekday is derived from the date, and
importing it would create a second source of truth for the same fact.

Two of those columns are not imported from the sheet even when it has them:

* **Status** is the booking's lifecycle, PLANNED or CANCELLED, and CommitteeFlow
  sets it. Every imported booking starts Planned.
* **Project Engineer** is a reference to a CommitteeFlow account, not a name. An
  import leaves it unknown rather than recording that whoever ran the import
  owns every project in the file.

A sheet headed `Status` is almost certainly **Serial No.** — that column was
being used for transformer serial numbers, which is the whole reason Serial No.
now exists — so the importer maps it there and says so in the preview. A
`Status` column that really does hold `Planned` and `Cancelled` is left
unmapped, with the same explanation.

Matching is on the **stable field key**, not the visible label. Renaming
`Customer Name` to `Client Name` in Plan Configuration does not break a single
existing spreadsheet: the header is matched against the key, the current label,
and the labels this product has historically used.

If a workbook has several sheets, one named `CommitteeFlow_Import` wins;
otherwise the first is read and the rest are offered.

### The workflow

```
Upload → Parse → Map columns → Validate → Preview → Confirm → Insert → Result
```

**The upload endpoint never writes a booking.** `POST /api/imports/preview`
parses and validates; `POST /api/imports/:id/confirm` writes. Nothing reaches
the plan until someone has seen what CommitteeFlow made of the file and pressed
a button that says so.

Confirm **re-parses and re-validates the file** rather than trusting a
client-held copy of the preview — otherwise a crafted request could write values
that never passed validation.

### Mapping

Every column is listed with a suggestion and sample values. A column is left for
the user to decide when the importer is not confident, and it says why:

- no plan field matches the heading;
- another column already claims that field;
- the heading matches a field the column's own values contradict.

That last case is the common one in practice. A `KV` column holding `11/0.4` is
a voltage ratio, not a number — auto-filing it into the numeric KV field would
fail validation on every row for a reason nobody could have foreseen. Instead
the suggestion is withheld and the column can be sent to a text field, or left
out. The veto needs at least three sample values and a majority disagreement, so
a column with one typo is still mapped and the typo stays a row-level error.

Custom fields are created in **Plan Configuration**, not here — the importer
never duplicates those rules.

### Validation

Imported rows go through **the same `normalizeBookingValues` the booking form
uses**. There is no weaker path for imports: requiredness, types, lengths,
select options and the future-month horizon are all read from the live Plan
Configuration, so an imported booking cannot enter the plan in a state a typed
one could not.

Each row comes back as **Valid**, **Warning** or **Error**:

| | |
|---|---|
| **Valid** | ready to import |
| **Warning** | imports, but worth a look — an inherited value, a possible duplicate, or an optional field left blank where the rest of that column is filled |
| **Error** | never imported |

Blank optional cells only warn when the column carries data on other rows. A
real plan leaves Notes and Customer Name empty on most rows, and "34 warnings"
that mean nothing would hide the rows that need attention.

### Merged cells

Real plan sheets merge Date, Time, Committee, OFF No. and Order Name across the
rows they cover, leaving the rows beneath them blank. Those five fields inherit
the last value above them — and **the row says that it did**, as a warning. A
merged sheet and a sheet with a forgotten date look identical to a parser, so
the inheritance is shown rather than performed silently. No other field is ever
carried forward: inventing a quantity nobody wrote down is worse than leaving it
empty.

### Shared Committee Sessions

`Date + Time + Committee` is a **shared session**, not a uniqueness key. Several
projects in one session is the normal shape of a plan, and an import loads them
together. No row is ever rejected for joining an occupied session, and no
constraint enforces one.

A **possible duplicate** is something narrower: the same OFF number, on the same
date, at the same time, with the same committee. Even then it is only a warning
with a Skip / Import anyway choice, because one order legitimately spans several
technical lines with repeated OFF numbers.

### Limits

| | |
|---|---|
| File size | 5 MB |
| Rows | 5000 |
| Columns | 60 |
| Files per request | 1 |

A Committee Plan month is tens of rows; the reference September workbook is 8 KB.
These bounds exist so a hostile upload cannot exhaust memory — parsing happens
in memory and the file is never written to disk.

### Security

- extension allowlist, then MIME check, then the file's own magic bytes — the
  only one of the three a sender cannot forge;
- the original filename is sanitised for display and never used as a path;
- macros are never parsed or executed, and formulas are read as values only;
- uploads are never stored, never served, and hold no filesystem path;
- both endpoints require authentication, a CSRF token, and the Project Engineer
  role, re-checked in the service as well as at the route;
- the write rate limiter applies;
- parser exceptions never reach the user — every rejection is a plain sentence
  naming the problem and the recovery.

### Batch tracking and audit

Every import writes an `import_batches` row: the filename, type, size, sheet,
the confirmed column mapping, the row counts, the dates touched, who uploaded
it and when. Imported bookings carry `data_source = 'IMPORT'` and an
`import_batch_id`, so a booking's origin is never ambiguous.

Imported bookings get **the same booking history a typed one does**, and behave
identically afterwards — edit, cancel and audit all work the same way.

The whole confirm step is one transaction: bookings, history, batch completion
and the notification commit together or not at all. A failure rolls everything
back and marks the batch `FAILED` rather than leaving it `PENDING` forever.

### Notification

One import sends **one** email — `PLAN_IMPORTED` — through the existing outbox,
never one per booking. A 34-row import produces a single message naming the
file, the counts and the range of dates affected. Manual booking, update and
cancellation emails are unchanged.

---

## Business rules

Three rules the specification deliberately left open (spec §78) are stored in
`app_settings` rather than hardcoded, and are editable from **Plan Configuration
→ Booking rules** with no migration and no redeploy.

| Rule | Confirmed value | Alternatives |
|---|---|---|
| **Committee slot exclusivity** | **None — sessions are shared.** `Date + Time + Committee` groups bookings; it is not a uniqueness key. | `DATE`, `DATE_TIME`, `DATE_TIME_COMMITTEE` |
| **Who may edit or cancel a booking** | **Any Project Engineer.** | `CREATOR_ONLY`, `CREATOR_OR_PLAN_MANAGER` |
| **How far ahead bookings may be made** | **6 months.** Past dates stay open so the record can always be corrected. | any 1–120 months, or unlimited |
| Notification audience | Everyone with an account (individually opt-out-able) | Project Engineers only |

Full reasoning, including what is still open, is in
[`docs/open-business-rules.md`](docs/open-business-rules.md).

---

## Users

There is no user-administration screen — the MVP sitemap does not include one
(spec §7), and building one would have meant inventing the rules around it. One
permission is an exception, because it changes daily work: **Plan Configuration
→ Who can configure the plan** grants and revokes plan-manager access, and
refuses to remove the last plan manager or your own.

Everything else is a command:

```bash
npm run users -- list
npm run users -- add "Ahmed Fathy" ahmed@example.com --engineer
npm run users -- password ahmed@example.com
npm run users -- deactivate ahmed@example.com
```

Nothing deletes a user — bookings, history and project ownership refer to them.
Someone who has left is deactivated. Full instructions, including the first
account on a fresh database and the SQL equivalents, are in
[`docs/managing-users.md`](docs/managing-users.md).

---

## Security

Authorisation is enforced on the **backend**; hiding a control in React is UX,
not security (spec §41). Every write additionally re-checks permission against
the specific object it is about to change (spec §42).

| Concern | How |
|---|---|
| Authentication | `express-session` with a PostgreSQL store; HttpOnly, `SameSite=Lax`, `Secure` when configured. No token in `localStorage`. |
| Passwords | Argon2id (19 MiB, t=2, p=1) via `@node-rs/argon2`. |
| Session fixation | The session id is regenerated on login. |
| Account enumeration | Wrong password, unknown address and disabled account return an identical response and burn comparable CPU. |
| Brute force | Per-IP-and-account rate limit plus an account lock after repeated failures. |
| CSRF | Synchroniser token in the session, echoed by the SPA from a readable mirror cookie. CORS is explicitly *not* treated as CSRF protection. |
| SQL injection | Everything is a bound parameter. The only identifiers that ever reach SQL text come from a closed allow-list (`server/src/modules/plan-config/field-keys.ts`). |
| XSS | React escapes by default; no `dangerouslySetInnerHTML` anywhere. Notification HTML escapes every interpolated value. |
| Headers | Helmet with a strict CSP: `script-src 'self'` — no `unsafe-inline`, no nonce, no inline script anywhere in the app. |
| Revocation | The session's user is re-read on every request, so a deactivated account loses access on its next request rather than when the cookie expires. |
| Audit integrity | History is written by the application and read by authorised users. No endpoint updates or deletes it (spec §67). |
| Secrets | Environment only. Never in Git, the image, or the client bundle. |

Deactivated accounts, permission changes and role changes all take effect
immediately.

---

## Testing

```bash
npm run db:up      # once
npm test           # 180 server + 33 client
```

**Server (180 tests, 9 files)** run against a real PostgreSQL instance — most of
CommitteeFlow's correctness lives in constraints, transactions, advisory locks
and a version check inside a `WHERE` clause, and mocking that would only test the
mocks. The suite drops and rebuilds the schema from the migrations on every run,
so a broken migration fails the whole suite at setup.

| File | Covers |
|---|---|
| `auth.test.ts` | Sessions, cookie flags, CSRF, enumeration, lockout, fixation, headers |
| `bookings.test.ts` | Create/read/update/cancel, validation, month ranges, filters, authorisation |
| `concurrency.test.ts` | Version conflicts, simultaneous edits, every slot rule, transaction atomicity |
| `committee-sessions.test.ts` | Shared sessions, session preview, the 6-month horizon |
| `audit-notifications.test.ts` | History, activity pagination, the outbox, retries, escaping |
| `plan-config.test.ts` | Permission, rename/reorder/hide/require, custom fields, archiving, type locking |
| `export.test.ts` | Real `.xlsx` and PDF output, driven by the configuration |
| `dates.test.ts`, `booking-values.test.ts` | Calendar handling and the dynamic value engine |

**Client (33 tests)** render real components against a stubbed `fetch`, so they
exercise the real query client, CSRF handling and error mapping: role-based UI,
dynamic fields from configuration, month navigation, filters, session grouping,
stale-edit conflicts, empty/error/loading states.

A newman-runnable Postman collection covering every endpoint is in
[`docs/postman`](docs/postman).

---

## Deployment notes

1. **HTTPS is required.** Internal does not mean unencrypted. Terminate TLS at
   nginx, a company reverse proxy or a load balancer, then set `COOKIE_SECURE=true`
   and `TRUST_PROXY=1`.
2. **Keep PostgreSQL private.** The compose file does not publish it. Do not add
   a port mapping without a specific operational need.
3. **Back up the database.** A Docker volume is persistence, not a backup
   (spec §68). Schedule `pg_dump`, keep it off the same host, and test a restore.
4. **Run migrations as a deployment step**, before or alongside the new image.
5. **Rate limiting is in-process.** Fine for one app container. Behind several,
   either limit at the reverse proxy or introduce a shared store — the spec rules
   Redis out of the MVP, so this is a deliberate boundary, not an oversight.
6. **The outbox worker runs in-process.** Multiple containers are safe
   (`FOR UPDATE SKIP LOCKED`). Set `OUTBOX_WORKER_ENABLED=false` on all but one
   if you would rather it did not.
7. **Watch `email_outbox`.** Rows stuck at `FAILED` with `attempt_count` at the
   maximum mean SMTP has been rejecting mail; `last_error` says why.
8. **Health check:** `GET /api/health` → `200 {"status":"ok"}` or `503` with
   `"degraded"`. It sits in front of the session middleware, so it still answers
   when the database is the thing that is broken.

### Not built, on purpose (spec §74)

ERP/Oracle integration, SSO, WebSockets, a mobile app, microservices, Redis,
Kafka, Kubernetes, analytics, a management dashboard, AI, a complex permission
framework, and a generic spreadsheet builder. The schema carries `data_source`
and `external_reference` so ERP data can arrive later without a migration, and
`users.external_identity_id` so SSO can map onto existing accounts.

---

## Where the implementation differs from the specification

Everything below is a deliberate, documented decision. Nothing silently drifts.

1. **Committee slot exclusivity — resolved, not guessed.** §46 marked this open
   and forbade inventing it. Confirmed with the business: sessions are *shared*.
   The setting keeps every stricter rule available and tested.
   *The specification should be updated:* §46 and §78.1 can be marked resolved,
   and §8's "one date = one booking" warning extended to "one session = one
   booking".

2. **Committee Sessions are a product concept, not just a grouping.** The plan
   groups `Date → Session → projects`, and the booking form previews the session
   being joined. This follows directly from rule 1 and is not in the original
   sitemap. *The specification should be updated* to describe it.

3. **Type changes on standard fields are allowed where the column can hold
   them.** §24 locks types once data exists. Rather than a blanket ban, the
   implementation checks what the column can actually store: `Status` may become
   a Select list (both are text) while `Qty` may not become text (its column is
   an integer). `TEXT → SELECT` on populated data is permitted only when every
   stored value is already one of the new options. Stricter than §24 in the
   places that matter, more useful in the places that do not.

4. **`app_settings` is a table the specification does not list.** §78/§79 require
   open rules to stay easy to change. A settings table was the smallest way to do
   that without inventing policy. *The specification should be updated* to
   include it.

5. **A `session-preview` endpoint** exists to support rule 1. Not in §38's route
   list.

6. **`node-pg-migrate` is a runtime dependency, not a dev dependency,** because
   the production image has to be able to migrate its own database.

7. **Rate limiting is per-IP *and* per-submitted-account** on login. §62 asks for
   rate limiting; bucketing by IP alone would let one attacker lock out every
   colleague by guessing their addresses.

8. **The theme bootstrap is a separate `/theme-init.js`**, not an inline script,
   so the CSP can stay `script-src 'self'` with no `unsafe-inline` and no nonce.

9. **`booking_date` and `booking_time` never become JavaScript `Date` objects.**
   node-postgres would parse them in the server's timezone and silently shift a
   plan date across a day boundary. They are handled as `YYYY-MM-DD` and `HH:MM`
   strings end to end, and the weekday is derived (spec §9, §11).

---

## Repository layout

```
CommitteeFlow/
├── client/                    React SPA
│   ├── src/
│   │   ├── api/               HTTP client and TanStack Query hooks
│   │   ├── components/        App shell and the UI vocabulary
│   │   ├── features/          auth · plan · bookings · plan-config · activity
│   │   │                      · plan-import
│   │   ├── lib/               dates, formatting, theme
│   │   └── styles/            design tokens and the base layer
│   └── tests/
├── server/                    Express API
│   ├── src/
│   │   ├── config/            environment parsing
│   │   ├── db/                pool, query helpers, transactions, seed
│   │   ├── lib/               errors, logging, HTTP helpers, dates
│   │   ├── middleware/        auth, CSRF, rate limiting, error handling
│   │   └── modules/           auth · bookings · plan-config · users · audit
│   │                          · notifications · export · plan-import
│   ├── migrations/            plain SQL, up and down
│   └── tests/
├── shared/api-types.d.ts      the HTTP contract, compiled by both sides
├── docs/
│   ├── product-spec.md        the specification
│   ├── open-business-rules.md what was confirmed, what is still open
│   ├── managing-users.md      adding people and changing what they can do
│   └── postman/               newman-runnable API collection
├── docker-compose.yml         app + PostgreSQL
├── docker-compose.dev.yml     PostgreSQL only, for development
└── Dockerfile                 multi-stage, non-root runtime
```
