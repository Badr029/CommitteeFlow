# API collection

Every CommitteeFlow endpoint, in one collection that runs end to end under
[newman](https://github.com/postmanlabs/newman).

The run signs in as a Project Engineer, walks the whole booking lifecycle
(create → read → history → update → version conflict → cancel), checks the
shared-committee-session rule, exercises Plan Configuration as a plan manager,
confirms a Viewer is refused every write, and downloads both exports.

## Coverage

| Group | Endpoints |
|---|---|
| Health | `GET /api/health` |
| Authentication | `POST /api/auth/login`, `GET /api/auth/session`, `POST /api/auth/logout` |
| Bookings | `GET /api/bookings`, `GET /api/bookings/:id`, `GET /api/bookings/:id/history`, `GET /api/bookings/session-preview`, `POST /api/bookings`, `PATCH /api/bookings/:id`, `POST /api/bookings/:id/cancel` |
| Plan configuration | `GET /api/plan-fields`, `POST /api/plan-fields`, `PATCH /api/plan-fields/:id`, `POST /api/plan-fields/reorder`, `POST /api/plan-fields/:id/archive`, `POST /api/plan-fields/:id/restore`, `GET /api/plan-fields/history` |
| Settings | `GET /api/settings`, `PATCH /api/settings` |
| Activity | `GET /api/activity` |
| Export | `GET /api/export/excel`, `GET /api/export/pdf` |

Beyond the happy paths, the run asserts the behaviour that matters: 401 when
signed out, 403 without CSRF, 403 for a Viewer's writes, 403 for plan
configuration without the permission, 422 for validation, 409 for a stale
version, 400 for a malformed id or an unbounded range, and that a SQL injection
attempt in `search` is treated as literal text.

## Prerequisites

The API running with the demo accounts seeded:

```bash
npm run db:up
npm run migrate:up
npm run seed
npm run seed --workspace server -- --with-demo-users
npm run dev
```

`--with-demo-users` creates `engineer@` and `viewer@`, both with
`SEED_ADMIN_PASSWORD`. Set `password` in the environment file to match.

## Running it

```bash
npx newman run docs/postman/CommitteeFlow.postman_collection.json \
  -e docs/postman/CommitteeFlow.local.postman_environment.json
```

With an HTML report for QA evidence:

```bash
npx newman run docs/postman/CommitteeFlow.postman_collection.json \
  -e docs/postman/CommitteeFlow.local.postman_environment.json \
  -r cli,html --reporter-html-export newman-report.html
```

Against a deployed environment, override the base URL and credentials:

```bash
npx newman run docs/postman/CommitteeFlow.postman_collection.json \
  --env-var baseUrl=https://committeeflow.internal.example \
  --env-var password="$COMMITTEEFLOW_TEST_PASSWORD"
```

Never commit a real password. Pass it from the shell or a CI secret.

## How it authenticates

CommitteeFlow uses session cookies, not bearer tokens. Newman keeps a cookie jar
across requests, so signing in once is enough. A collection-level pre-request
script reads the CSRF token from the readable `committeeflow.csrf` mirror cookie
and echoes it in `X-CSRF-Token` — exactly what the SPA does.

Two requests deliberately override that script: the CSRF-failure case (which
sends a wrong token on purpose) and the system-field case (which first looks up
the `booking_date` field's id).

## What the run leaves behind

It creates bookings in `{{month}}` under `{{committee}}` (default *Postman
Committee*, October 2026) and cancels one of them. It restores every setting it
changes and archives the custom field it adds. Point it at a test database, not
at the real plan.
