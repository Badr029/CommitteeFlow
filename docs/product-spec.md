# ELSEWEDY ELECTRIC Committee Plan MVP
## Product, Sitemap, Technical Architecture, Security, Performance, and Extensibility Specification

**Status:** Confirmed working specification based on the discussion so far  
**Target:** MVP for real-world internal testing at ELSEWEDY ELECTRIC  
**Primary stack:** React + Node.js/Express + PostgreSQL + Docker  
**Primary product action:** **Book Committee Slot**

---

# 1. Project Context

The current Committee Plan is created manually in Excel by one person.

The monthly workflow today is roughly:

1. A Committee Plan Excel sheet is prepared for the month.
2. Project Engineers choose dates for their projects.
3. The person responsible for the Excel sheet manually updates it.
4. Every time something changes, an updated copy of the Excel file is sent again by email.
5. Multiple people can end up relying on different file versions.
6. There is no strong live source of truth, and ownership/history of changes is harder to track.

The existing Committee Plan contains the following current business fields:

- Day
- Date
- OFF No.
- Order Name
- Committee
- Qty
- KVA
- KV
- Status
- Notes
- Customer Name

The uploaded reference is:

`Committee Plan for September V5 8-9.pdf`

The current sheet also demonstrates that:

- Multiple bookings/orders may exist on the same date.
- Future-month dates may be planned while the current month is being worked on.
- The application must therefore support navigation to and booking in future months.

---

# 2. Product Claim

The product is not “a website that edits an Excel sheet.”

The product claim is:

> **Replace the manually maintained monthly Committee Plan and repeated Excel/email update cycle with one live, shared, auditable source of truth where Project Engineers manage committee bookings and other users always see the latest plan.**

The application becomes the source of truth.

Excel/PDF exports remain available for compatibility and reporting, but they are **snapshots**, not the authoritative data source.

---

# 3. One Primary Product Action

The one primary action is:

> **Book Committee Slot**

Everything in the MVP should support that workflow.

The core loop is:

```text
Engineer opens Committee Plan
        ↓
finds the desired date/month
        ↓
Book Committee Slot
        ↓
enters booking/project information
        ↓
Save
        ↓
Plan updates immediately
        ↓
Creator + timestamp are recorded
        ↓
Notification is queued/sent
        ↓
Everyone sees the same current plan
```

The system must also support later:

```text
Edit Booking
Cancel Booking
```

with the same audit + notification behavior.

---

# 4. Roles and Access

The MVP has **two normal application roles**.

## 4.1 Project Engineer

Project Engineers have full booking control.

They can:

- View the Committee Plan
- Navigate previous/current/future months
- Search/filter
- Create bookings
- Edit bookings
- Cancel bookings
- View booking details
- View creator/update information
- View history
- Export Excel/PDF

## 4.2 Viewer / Normal User

Normal users have read-only access.

They can:

- View the Committee Plan
- Navigate months
- Search/filter
- View booking details
- View history where appropriate
- Export Excel/PDF
- Receive notifications

They cannot:

- Create bookings
- Edit bookings
- Cancel bookings

Write controls should not merely be hidden in React; the backend must enforce the permission.

---

# 5. Plan Configuration Permission

The plan structure itself must be configurable without creating a large role system.

Do **not** introduce many roles just for this.

Keep the two normal roles and add a restricted permission such as:

```text
can_manage_plan_configuration = true
```

Only trusted authorized users should receive this permission.

They can manage the business-facing structure of the Committee Plan.

---

# 6. Confirmed Sitemap

The sitemap should stay small and focused.

```text
Login
│
└── Committee Plan                         ← HOME / DEFAULT PAGE
    │
    ├── Month Navigation
    │   ├── Previous Months
    │   ├── Current Month
    │   └── Future Months
    │
    ├── Search / Filters
    │   ├── Date
    │   ├── Committee
    │   ├── Status
    │   └── Created By
    │
    ├── + Book Committee Slot              ← PRIMARY ACTION / Project Engineer
    │
    ├── Booking Details
    │   ├── Configured Plan Fields
    │   ├── Created By
    │   ├── Created At
    │   ├── Updated By
    │   ├── Updated At
    │   └── Booking History
    │
    ├── Edit Booking                       ← Project Engineer
    ├── Cancel Booking                     ← Project Engineer
    │
    ├── Export
    │   ├── Excel
    │   └── PDF
    │
    └── Activity
        └── Full Booking Change History


Plan Configuration                        ← RESTRICTED PERMISSION
│
├── Plan Fields
│   ├── Rename Field Label
│   ├── Show / Hide Field
│   ├── Reorder Fields
│   ├── Required / Optional
│   ├── Add Custom Field
│   └── Archive Custom Field
│
└── Preview Committee Plan
```

---

# 7. Deliberately NOT in the MVP Sitemap

Do not add unnecessary enterprise-style sections.

Do not create separate pages for:

- Dashboard
- Projects
- Orders
- Customers
- My Bookings
- Notifications
- Reports dashboard
- Users administration unless absolutely required for MVP setup
- Separate “Create Booking” navigation page

Creating a booking is an **action**, not a top-level destination.

“My Bookings” should initially be handled with a filter such as:

```text
Created By: Everyone
[ ] Only my bookings
```

The Committee Plan itself is the operational dashboard.

---

# 8. Committee Plan Screen

The current month should be the default landing view.

Example:

```text
Committee Plan                         September 2026

< August          September 2026          October >

[Today]   Search...   Committee ▼   Status ▼   Created By ▼

                                        + Book Committee Slot

-----------------------------------------------------------------
Date        OFF No.     Order             Committee        Time
-----------------------------------------------------------------
09 Sep      202601066   2B                ...              10:00
09 Sep      202501261   HV Cable Box      ...              13:00

10 Sep      202601449   Aweer Maintenance ...              09:00
...
```

Important:

- Multiple bookings may exist on the same date.
- The UI must not assume “one date = one booking.”
- Users can freely navigate to future months.
- Project Engineers can create bookings in future months.
- Viewers can see future plans as well.

---

# 9. Future-Month Booking

Future planning is a confirmed requirement.

Example:

```text
Today: 09 September 2026
Booking Date: 06 October 2026
```

These are distinct values:

```text
booking_date = 2026-10-06
created_at   = 2026-09-09T...
```

Never confuse booking date with creation date.

The product is a continuous Committee Plan with month navigation; there is no separate “Future Plan” module.

A future booking belongs to the month of its `booking_date`.

---

# 10. Booking Form

The primary CTA is:

```text
+ Book Committee Slot
```

The form may open as a modal, drawer, or dedicated temporary form route, but it should not be a permanent top-level navigation item.

Initial business fields come from the current standard:

```text
Date
Time
OFF No.
Order Name
Committee
Qty
KVA
KV
Status
Notes
Customer Name
```

The exact displayed form fields must later be driven by Plan Configuration.

Important distinction:

- `booking_date` is real structured date data.
- `booking_time` is real structured time data.
- Time must not be stored inside Notes or another loosely defined text field.

---

# 11. Day Field

The existing sheet displays Day and Date.

The system should store a real `booking_date`.

The displayed Day can be derived from the date rather than manually typed.

Example:

```text
booking_date = 2026-09-10
display_day  = Thursday
```

The date remains the authoritative value.

---

# 12. Booking Details and Ownership

Booking ownership and change information must be visible.

Store and display:

```text
created_by
created_at
updated_by
updated_at
```

A detail view should expose:

- Configured business fields
- Booking date/time
- Created by
- Created at
- Last updated by
- Last updated at
- Booking history

This changes the workflow from “someone changed the Excel” to a traceable operation.

---

# 13. Audit Requirements

Maintain booking history.

Conceptually:

```text
booking_history
---------------
id
booking_id
action
actor_id
old_values
new_values
created_at
```

Typical actions:

```text
CREATE
UPDATE
CANCEL
```

The application must be able to answer:

- Who created this booking?
- When was it created?
- Who last changed it?
- What changed?
- When did it change?
- Who cancelled it?
- What was the booking before the change?

---

# 14. Activity Page

Activity remains because the product promises an auditable source of truth.

Example:

```text
Recent Activity

15:14
Mohamed Ali changed OFF 202601066
Time: 10:00 → 11:00

14:52
Ahmed Hassan created OFF 202601401
04 Oct · North Committee

13:37
Omar Khaled cancelled OFF 202601142
```

Activity history should be paginated rather than loading everything forever.

---

# 15. Cancellation Instead of Hard Deletion

Do not normally hard-delete bookings.

Use an application lifecycle state:

```text
ACTIVE
CANCELLED
```

Potential cancellation data:

```text
cancelled_by
cancelled_at
cancellation_reason
```

or record equivalent data in the audit history.

Cancelled records may disappear from the default active plan view while remaining available in history.

---

# 16. Email / Notification Behavior

Notifications must cover:

```text
BOOKING_CREATED
BOOKING_UPDATED
BOOKING_CANCELLED
```

Do not only notify on create.

A notification should identify what changed and provide access to the current live plan.

---

# 17. The App Is the Source of Truth

Do **not** recreate the old workflow by attaching a new Excel file to every email.

Avoid:

```text
committee-plan-v4.xlsx
committee-plan-v5.xlsx
committee-plan-final.xlsx
committee-plan-final2.xlsx
```

Instead:

```text
Email / notification
        ↓
"The Committee Plan has changed."
        ↓
View Current Plan
```

Excel/PDF remains a user-triggered export of the current state.

---

# 18. Excel and PDF Export

Exports stay on the Committee Plan page.

```text
Committee Plan
September 2026

[Export Excel] [Export PDF]
```

The export structure must reflect the configured Plan Fields.

The same configuration should drive:

- Booking form
- Booking detail display
- Committee Plan columns
- Excel headers
- PDF headers

---

# 19. Configurable Committee Plan Structure

The current Excel format is the default standard, **not a permanent hardcoded format**.

Authorized users must be able to adjust business-facing fields later without requiring code changes for every change.

Examples:

```text
Rename "Customer Name" → "Client Name"

Add:
Project Manager
Factory
Production Line
Inspection Type

Hide:
KVA

Reorder:
Committee before Order Name
```

---

# 20. Critical Configuration Principle

> **Make the Committee Plan configurable. Do not make the database schema itself editable.**

Distinguish:

1. Stable technical keys/core application behavior
2. Business-facing field definitions and labels

Example:

```text
technical key: customer_name
display label: Customer Name
```

Later:

```text
technical key: customer_name
display label: Client Name
```

The technical key remains stable.

---

# 21. Three Field Classes

## System / Operational Fields

```text
booking_date
booking_time
created_by
created_at
updated_by
updated_at
booking_state
version
```

These exist because the application needs them and cannot be casually deleted.

## Standard Business Fields

```text
off_no
order_name
committee
qty
kva
kv
status
notes
customer_name
```

These can be renamed/reordered/shown-hidden and can support configurable requiredness where valid, while preserving stable technical keys.

## Custom Fields

Future examples:

```text
project_manager
factory
production_line
inspection_type
```

They can be:

- Added
- Renamed
- Reordered
- Shown/hidden
- Archived

---

# 22. Do Not Build a Mini Excel/Airtable

Initial supported custom field types can stay limited to:

```text
Text
Long Text
Number
Select
Date
Time
Checkbox
```

Do not build:

- Formula language
- Custom scripts
- Nested tables
- Custom SQL
- Arbitrary relations
- Spreadsheet formulas
- Complex conditional formatting
- Generic app-builder behavior

---

# 23. Field Deletion / Archiving

Never hard-delete a custom field that already contains historical data.

Use:

```text
is_active = false
```

or:

```text
archived_at = ...
```

Old bookings preserve their values.

New forms no longer show the field.

---

# 24. Field Type Changes

Once a field contains data, its technical key and data type should normally be locked.

Recommended behavior:

```text
Label           ✅ change
Display order   ✅ change
Visible         ✅ change
Required        ✅ carefully
Select options  ✅ carefully
Type            ❌ normally locked after data exists
Technical key   ❌ locked
```

---

# 25. Configuration Audit

Plan configuration changes should also be auditable.

Conceptually:

```text
configuration_history
---------------------
id
field_id
action
old_value
new_value
changed_by
changed_at
```

---

# 26. Technical Architecture Principle

Build a **modular monolith**.

```text
Browser
   │
   ▼
React SPA + TypeScript
   │ HTTPS / REST
   ▼
Node.js + Express + TypeScript
   │
   ├── Auth
   ├── Bookings
   ├── Plan Configuration
   ├── Audit
   ├── Notifications
   └── Export
   │
   ▼
PostgreSQL
   │
   ├── users
   ├── bookings
   ├── plan_field_definitions
   ├── booking_history
   ├── configuration_history
   └── email_outbox
   │
   ▼
SMTP / Email
```

Do not build microservices for the MVP.

---

# 27. Recommended Technology Choices

## Frontend

- React
- TypeScript
- Vite
- React Router
- TanStack Query
- React Hook Form
- Zod

Redux is not required.

## Backend

- Node.js LTS
- Express
- TypeScript
- Zod
- `pg`
- A simple migration tool such as `node-pg-migrate`

An ORM is optional, not required.

## Database

- PostgreSQL
- `pg.Pool` for connection pooling

## Email

- Nodemailer
- Company SMTP when available

## Logging

- Pino or equivalent structured logging

## Testing

- Jest or Vitest
- Supertest for API integration tests

## Security

- Helmet
- Session-based authentication
- Secure cookies
- Rate limiting
- CSRF protection

## Deployment

- Docker
- Docker Compose

---

# 28. Backend Structure

```text
server/
│
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   ├── bookings/
│   │   ├── plan-config/
│   │   ├── users/
│   │   ├── audit/
│   │   ├── notifications/
│   │   └── export/
│   │
│   ├── middleware/
│   ├── db/
│   ├── config/
│   ├── app.ts
│   └── server.ts
│
├── migrations/
├── tests/
├── Dockerfile
└── package.json
```

Do not create:

```text
Auth Service
Booking Service
Notification Service
Audit Service
API Gateway
Kafka
Redis
Kubernetes
```

for the MVP.

---

# 29. Deployment Shape

React does not need its own runtime container for the MVP.

Use a multi-stage Docker build:

```text
Stage 1
Build React
   ↓
dist/

Stage 2
Node runtime
   ↓
serve React dist/
serve /api/*
```

Docker Compose:

```text
docker compose
│
├── committee-app
└── postgres
```

This is intentionally simple.

---

# 30. Hybrid Database Model

Do not make every future business field a PostgreSQL column.

Do not put the entire booking into unstructured JSON either.

Use:

- Operational/frequently queried fields as real columns
- Current standard business fields as real columns
- Future custom fields in `JSONB`
- Field definitions to describe business-facing fields

This preserves both integrity and flexibility.

---

# 31. `users` Table

Conceptual shape:

```text
users
-----
id
name
email
password_hash            nullable in future
role
can_manage_plan_configuration
is_active
external_identity_id     nullable for future SSO
created_at
updated_at
```

Roles:

```text
PROJECT_ENGINEER
VIEWER
```

---

# 32. `bookings` Table

Conceptual shape:

```text
bookings
--------
id UUID PK

booking_date DATE
booking_time TIME

off_no
order_name
committee
qty
kva
kv
status
notes
customer_name

custom_fields JSONB

booking_state

data_source
external_reference

created_by UUID FK users
created_at TIMESTAMPTZ

updated_by UUID FK users
updated_at TIMESTAMPTZ

version INTEGER
```

Potential application states:

```text
ACTIVE
CANCELLED
```

Important:

`status` from the business plan and `booking_state` from the application lifecycle are **not the same thing**.

---

# 33. Future Integration Metadata

Useful future-facing values:

```text
data_source:
MANUAL
ERP
IMPORT
```

and:

```text
external_reference
```

Do not build ERP integration now.

---

# 34. `plan_field_definitions`

Conceptual shape:

```text
plan_field_definitions
----------------------
id
field_key
label
field_type

field_class
    SYSTEM
    STANDARD
    CUSTOM

storage_strategy
    COLUMN
    CUSTOM_JSONB

is_required
is_visible
display_order
options
is_active

created_at
updated_at
```

`field_key` is stable.

`label` is user-facing and configurable.

The exact schema may change, but this behavior must remain.

---

# 35. Dynamic UI from Field Definitions

The frontend should retrieve Plan Fields, for example:

```http
GET /api/plan-fields
```

The same configuration should render:

```text
Create Booking Form
Edit Booking Form
Committee Plan Table
Booking Details
Excel Export
PDF Export
```

Do not hardcode separate field definitions in all of those places.

---

# 36. Future ERP / Oracle Automation

Today:

```text
Engineer manually enters:
OFF No.
Order Name
Customer
Qty
KVA
KV
Committee
Status
Notes
```

Future:

```text
Engineer selects OFF No.
        ↓
ERP / Oracle lookup
        ↓
Order Name      AUTO
Customer        AUTO
Qty             AUTO
KVA             AUTO
KV              AUTO
        ↓
Engineer chooses:
Date
Time
Committee
        ↓
Conflict validation
        ↓
Booking
        ↓
Plan update
Notifications
Audit
```

Eventually the app may offer “My Active Orders.”

That is future scope, not MVP scope.

---

# 37. Future Field Source Concept

The model can later support:

```text
field_source:
MANUAL
ERP
CALCULATED
```

without implementing full mapping now.

---

# 38. REST API Shape

Keep the API simple.

Possible route groups:

```text
/auth
/bookings
/activity
/plan-fields
/exports
/health
```

Examples:

```http
GET    /api/bookings?from=2026-09-01&to=2026-09-30
GET    /api/bookings/:id

POST   /api/bookings
PATCH  /api/bookings/:id
POST   /api/bookings/:id/cancel

GET    /api/activity

GET    /api/plan-fields
POST   /api/plan-fields
PATCH  /api/plan-fields/:id
POST   /api/plan-fields/:id/archive

GET    /api/export/excel?from=...
GET    /api/export/pdf?from=...

GET    /api/health
```

Exact route naming can vary.

---

# 39. Authentication

For the MVP use secure browser sessions.

Recommended direction:

```text
express-session
+
PostgreSQL-backed session store
+
HttpOnly cookie
Secure cookie
SameSite policy
```

Avoid JWT/session tokens in `localStorage`.

If local accounts are used temporarily, hash passwords with Argon2 or bcrypt.

---

# 40. Future Authentication Target

If accepted as an official company system, corporate SSO should become the preferred target.

Example:

```text
Microsoft Entra ID / company identity provider
        ↓
company authenticates employee
        ↓
app receives identity
        ↓
app maps identity to business role
```

Do not block the MVP waiting for SSO unless company IT requires it.

---

# 41. Backend Authorization Is Mandatory

Hiding buttons in React is UX, not security.

Backend rules must enforce:

```text
GET bookings          VIEWER + PROJECT_ENGINEER
GET booking details   VIEWER + PROJECT_ENGINEER

POST booking          PROJECT_ENGINEER
PATCH booking         PROJECT_ENGINEER
CANCEL booking        PROJECT_ENGINEER
```

The ownership rule for editing another engineer's booking remains an open business rule.

---

# 42. Object-Level Authorization

Knowing a booking ID must never imply permission to modify it.

Every write request must perform backend authorization for that action/object.

---

# 43. Validation

Use layered validation:

```text
React
↓
Form/Zod validation

Node
↓
Zod/API validation

PostgreSQL
↓
constraints
```

Examples:

- `qty > 0`
- Valid booking date/time
- Length limits
- Required configured fields
- Allowed select values

---

# 44. SQL Injection

Always use parameterized SQL/prepared queries.

Never concatenate user-controlled values into SQL.

---

# 45. PostgreSQL Constraints

Use PostgreSQL constraints for critical rules:

```text
NOT NULL
CHECK
UNIQUE
FOREIGN KEY
```

Do not rely only on frontend validation.

---

# 46. Slot Uniqueness / Conflict Rule — OPEN

The term “slot” still needs a confirmed business definition.

Possible exclusivity keys include:

```text
Date
Date + Time
Date + Time + Committee
```

The current sheet confirms multiple bookings can exist on the same date, but it does not define the exact exclusive-slot rule.

**The coding agent must not invent this rule.**

Once confirmed, enforce it at the database level where appropriate.

---

# 47. Create Concurrency

If a slot is exclusive, the database—not the frontend—must prevent two users from booking it simultaneously.

Example race:

```text
Ahmed sees slot available
Mohamed sees slot available
Ahmed saves
Mohamed saves milliseconds later
```

The final uniqueness constraint depends on the business rule above.

---

# 48. Edit Concurrency / Lost Updates

Use optimistic concurrency:

```text
version INTEGER
```

Example:

```text
Ahmed opens version 3
Mohamed saves → version 4
Ahmed submits version 3
```

Return:

```http
409 Conflict
```

UI:

```text
This booking was changed by another user.
Refresh before saving.
```

---

# 49. Live Updates without Overengineering

Do not start with WebSockets.

For MVP, TanStack Query should refresh on:

- Booking create
- Booking update
- Booking cancel
- Browser tab refocus
- Optional 20–30 second interval

If real usage later requires immediate push changes, consider Server-Sent Events (SSE) before WebSockets.

---

# 50. Email Reliability / Outbox Pattern

Do not block booking creation on SMTP.

Use:

```text
POST booking
        ↓
PostgreSQL transaction
        ├── INSERT booking
        ├── INSERT booking_history
        └── INSERT email_outbox
        ↓
COMMIT
        ↓
HTTP 201
```

Then a worker processes pending emails.

Initially the worker may run inside the same Node process.

Later it can become a separate worker container.

No Kafka/RabbitMQ is required.

---

# 51. `email_outbox`

Conceptual shape:

```text
email_outbox
------------
id
event_type
booking_id
recipients / target group
subject
payload
status
attempt_count
last_error
created_at
sent_at
next_attempt_at
```

The exact schema can be simplified.

---

# 52. Performance Philosophy

Do not optimize for imaginary internet-scale traffic.

Focus on:

- Date-range queries
- Correct indexes
- Connection pooling
- Pagination
- Async email
- Avoiding full-table loads
- Measuring real use

---

# 53. Date-Range Queries

Good:

```http
GET /api/bookings?from=2026-09-01&to=2026-09-30
```

Do not fetch every historical booking for every page load.

---

# 54. Indexes

Start with likely access patterns.

Example:

```sql
INDEX bookings(booking_date)
```

Potential later composite index:

```sql
INDEX bookings(booking_date, committee)
```

Do not index every field automatically.

---

# 55. PostgreSQL Connection Pool

Use:

```text
pg.Pool
```

Do not create/destroy a new DB connection per request.

---

# 56. Activity Pagination

Example:

```http
GET /api/activity?page=1&limit=50
```

Do not load all audit records forever.

---

# 57. MVP Performance Targets

Reasonable targets:

```text
Monthly plan API:
< 500 ms under normal internal load

Create booking:
< 500 ms excluding async email

Update/cancel:
< 500 ms

Search/filter:
feels instant

Email:
eventually delivered
never blocks booking creation
```

Measure before further optimization.

---

# 58. Security Priorities

Main concerns:

- Broken authorization
- Object-level authorization
- SQL injection
- XSS
- CSRF
- Session theft
- Brute-force login
- Secrets leakage
- Database exposure
- Audit manipulation
- Container security
- Dependency vulnerabilities
- Backups/data loss

---

# 59. Secure Cookies

Use appropriate cookie settings:

```text
HttpOnly
Secure
SameSite
```

HTTPS is required for real company use.

---

# 60. CSRF

Because browser sessions/cookies are planned, implement CSRF protection appropriate to the final architecture.

Do not treat CORS as CSRF protection.

---

# 61. XSS / Security Headers

Use Helmet early.

Use a sensible Content Security Policy.

Do not render arbitrary HTML from notes/custom fields.

---

# 62. Rate Limiting

At minimum rate-limit sensitive endpoints such as:

- Login
- Password reset if ever added
- Potentially abusive write endpoints

---

# 63. Secrets

Never store secrets in:

- Git
- Dockerfile
- React source
- Frontend environment variables compiled into the client bundle

Backend-only secrets include:

```text
DATABASE_URL
SESSION_SECRET
SMTP_USERNAME
SMTP_PASSWORD
SSO secrets
```

Use deployment environment variables/company secret management.

---

# 64. PostgreSQL Network Exposure

The browser never talks directly to PostgreSQL.

```text
Company Network / HTTPS
        ↓
committee-app
        ↓
private Docker network
        ↓
PostgreSQL
```

Do not publish PostgreSQL to the company network without a specific operational need.

---

# 65. HTTPS

Internal does not mean unencrypted.

For real deployment, use HTTPS.

TLS can terminate at:

- Nginx
- Company reverse proxy
- Load balancer

---

# 66. Docker Security

Use:

- Multi-stage build
- Non-root runtime user
- No secrets baked into image
- Small runtime image where practical

---

# 67. Audit Protection

Do not expose general user APIs that arbitrarily modify/delete history.

History should conceptually be:

```text
application writes
authorized users read
```

---

# 68. Backups

A Docker volume is persistence, **not a backup**.

POC:
- Manual backup may be enough temporarily

Company adoption:
- Scheduled PostgreSQL backups
- Company backup system if available
- Restore testing

---

# 69. Health Endpoint

Add:

```http
GET /api/health
```

Basic response:

```json
{
  "status": "ok"
}
```

This helps separate container, Node, DB, and frontend failures during deployment/testing.

---

# 70. Logging

Use structured logs.

At minimum log:

- Request errors
- Authentication failures
- Booking create/update/cancel outcomes
- Email failures/retries
- Database errors
- Configuration changes

Never log passwords, secrets, or session values.

---

# 71. Testing Expectations

## Backend / API

Test:

- Login/session behavior
- Viewer cannot create/edit/cancel
- Engineer can create/edit/cancel
- Server-side validation
- Configured required fields
- Date/time behavior
- Future-month booking
- Audit creation
- Email outbox creation
- Cancellation
- Version conflict → 409
- Confirmed slot conflict rule
- Plan-field authorization
- Archived fields
- Export behavior

## Database

Test:

- Constraints
- Foreign keys
- Invalid data
- Transaction rollback
- Audit/outbox consistency

## Frontend

Test:

- Role-based UI
- Dynamic fields
- Month navigation
- Future-month booking
- Refresh after mutations
- Stale-edit conflict
- Read-only mode
- Search/filter

## Security

Test:

- Unauthorized writes
- Object authorization
- Input validation
- SQL injection attempts
- Sessions/cookies
- CSRF

---

# 72. Transactions

Important write operations should be atomic.

Create example:

```text
BEGIN

INSERT booking
INSERT booking_history
INSERT email_outbox

COMMIT
```

If one required step fails:

```text
ROLLBACK
```

Apply similar consistency to updates/cancellations.

---

# 73. MVP Boundary — BUILD NOW

- Authentication
- Two roles
- Restricted plan-config permission
- Committee Plan
- Previous/current/future month navigation
- Future-month booking
- Create booking
- Edit booking
- Cancel booking
- Created/updated ownership and timestamps
- Booking history
- Activity
- Search/filter
- Create/update/cancel notifications
- Async email outbox
- Excel export
- PDF export
- Configurable plan fields
- Rename/reorder/show-hide/required behavior
- Custom fields
- Archive custom fields
- Dynamic form/table/details/export
- Docker
- Docker Compose
- PostgreSQL
- Logging
- Health endpoint
- Security baseline
- Automated tests

---

# 74. MVP Boundary — DO NOT BUILD NOW

- ERP integration
- Oracle integration
- Automatic order import
- Full field-source mapping engine
- Company SSO unless required for the trial
- WebSockets
- Mobile app
- Microservices
- Redis
- Kafka
- RabbitMQ
- Kubernetes
- Advanced analytics
- Management dashboard
- AI
- Complex permission framework
- Generic spreadsheet/app builder

---

# 75. Future Scalability Path

```text
MVP
│
├── React
├── Node modular monolith
├── PostgreSQL
├── Company/local SMTP
├── Docker Compose
└── Configurable Committee Plan
        │
        │ Approved
        ▼
Company Application
│
├── Corporate SSO
├── Oracle/ERP integration
├── Automatic OFF/order data
├── Centralized SMTP
├── Proper backups
├── Central monitoring/logging
└── Possibly SSE
        │
        │ Usage grows
        ▼
Larger Deployment
│
├── Separate frontend hosting if useful
├── Multiple API containers
├── Separate email worker
├── Company/managed PostgreSQL
└── Load balancer
```

The goal is to avoid a future “rewrite everything.”

---

# 76. Scalability Principle

The primary scalability target is **functional scalability**:

- New fields
- Renamed fields
- New business rules
- New notifications
- ERP/Oracle data
- SSO
- More users
- More history/months
- Future reporting

without replacing the core system.

---

# 77. One Source of Field Configuration

Plan Configuration should drive:

```text
Plan Field Definitions
         │
         ├── Create Form
         ├── Edit Form
         ├── Committee Plan Table
         ├── Booking Details
         ├── Excel Export
         └── PDF Export
```

Do not hardcode six separate versions of the field list.

---

# 78. Open Business Rules — DO NOT GUESS

## 78.1 Exact slot uniqueness

Still to confirm:

```text
Date
Date + Time
Date + Time + Committee
or another rule
```

Multiple bookings on the same date are already known to be valid.

## 78.2 Engineer ownership rule

Still to confirm:

```text
All Project Engineers can edit all bookings
```

vs.

```text
Only the creator can edit
```

vs.

```text
Creator + privileged users
```

## 78.3 Future booking horizon

Future-month booking is confirmed.

Still to confirm whether the allowed horizon is:

```text
Unlimited
Next N months
Current year
Another company policy
```

Do not hardcode an arbitrary company policy.

---

# 79. Coding-Agent Rule for Unconfirmed Requirements

When a business rule is not confirmed:

- Keep implementation easy to change
- Use configuration/TODO where suitable
- Do not make irreversible schema assumptions
- Do not invent company policy
- Do not add complex infrastructure for hypothetical situations

---

# 80. Recommended Build Order

```text
1. Confirm open business rules that affect constraints
2. Initialize repo/project structure
3. Docker + PostgreSQL
4. Database migrations/schema
5. Auth/session foundation
6. Roles/permissions middleware
7. Plan field definition module
8. Booking domain/service
9. Booking history/audit
10. Email outbox
11. REST endpoints
12. Backend tests
13. React shell/routing/auth
14. Committee Plan month view
15. Dynamic booking form
16. Booking detail/edit/cancel
17. Plan Configuration UI
18. Activity page
19. Excel/PDF export
20. Email worker/SMTP integration
21. Security hardening
22. Performance/concurrency tests
23. Dockerized MVP deployment
24. Real-user workflow test
```

---

# 81. Suggested Repository Shape

```text
committee-plan/
│
├── client/
│   ├── src/
│   │   ├── api/
│   │   ├── components/
│   │   ├── features/
│   │   │   ├── auth/
│   │   │   ├── bookings/
│   │   │   ├── plan/
│   │   │   ├── plan-config/
│   │   │   └── activity/
│   │   ├── routes/
│   │   ├── schemas/
│   │   └── main.tsx
│   └── package.json
│
├── server/
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── bookings/
│   │   │   ├── plan-config/
│   │   │   ├── audit/
│   │   │   ├── notifications/
│   │   │   └── export/
│   │   ├── middleware/
│   │   ├── db/
│   │   ├── config/
│   │   ├── app.ts
│   │   └── server.ts
│   ├── migrations/
│   ├── tests/
│   └── package.json
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
├── README.md
└── docs/
    └── product-spec.md
```

---

# 82. Non-Goals

Do not let implementation silently expand into:

- Rebuilding Oracle ERP
- Building a generic project-management suite
- Building an Excel replacement
- Building a full CMS
- Building microservices
- Building real-time chat
- Building unnecessary analytics
- Building a no-code app builder
- Building complex user administration before required

---

# 83. Definition of MVP Success

The MVP succeeds if the real team can use it to perform the current workflow with less manual coordination:

```text
Project Engineer logs in
        ↓
opens the correct month
        ↓
books a committee slot
        ↓
booking is stored
        ↓
creator is recorded
        ↓
plan updates
        ↓
viewers see latest state
        ↓
notification is delivered
        ↓
engineer can later update/cancel
        ↓
history shows what happened
        ↓
export reproduces current plan when required
```

Additionally, authorized users can modify the business-facing Committee Plan structure without a code change for every label/new field.

---

# 84. Core Engineering Principles

1. **The app is the source of truth.**
2. **Book Committee Slot is the primary action.**
3. **Keep the sitemap small.**
4. **Use a modular monolith.**
5. **Do not build infrastructure for hypothetical scale.**
6. **Use PostgreSQL constraints for critical rules.**
7. **Treat concurrency as a real multi-user problem.**
8. **Email must be asynchronous/reliable.**
9. **Authorization belongs on the backend.**
10. **Audit important business changes.**
11. **Cancel/archive rather than destroy history.**
12. **Use secure browser sessions.**
13. **Keep the database private.**
14. **Use HTTPS for real deployment.**
15. **Back up real company data.**
16. **Current Excel fields are the default, not the permanent limit.**
17. **Stable technical keys, configurable business labels.**
18. **Core fields remain structured; future custom fields use JSONB.**
19. **One Plan Configuration drives forms, tables, details, and exports.**
20. **Do not build a generic spreadsheet/app builder.**
21. **Design for future ERP/Oracle/SSO integration without implementing it now.**
22. **Do not invent unconfirmed business rules.**

---

# 85. Official / Security References

- Node.js release lifecycle / LTS  
  https://nodejs.org/en/about/previous-releases

- Docker build best practices  
  https://docs.docker.com/build/building/best-practices/

- PostgreSQL constraints  
  https://www.postgresql.org/docs/current/ddl-constraints.html

- PostgreSQL JSON / JSONB  
  https://www.postgresql.org/docs/current/datatype-json.html

- PostgreSQL indexes  
  https://www.postgresql.org/docs/current/indexes.html

- Express production security best practices  
  https://expressjs.com/en/advanced/best-practice-security.html

- Express production performance/reliability  
  https://expressjs.com/en/advanced/best-practice-performance.html

- OWASP API Security — Broken Object Level Authorization  
  https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/

- OWASP Session Management Cheat Sheet  
  https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

---

# 86. Final Instruction to the Coding Agent

Build this as a **small internal operational product**, not as a demo and not as an oversized enterprise platform.

The MVP must be:

```text
simple to understand
simple to deploy
secure enough for internal testing
auditable
multi-user safe
configurable where the business is likely to change
easy to extend after approval
```

Do not add architectural complexity unless it directly solves a confirmed requirement.

When forced to choose between clever architecture and clear, testable, maintainable code, choose the second.

The product must prove the workflow first.

If the MVP is approved, expand integration and automation around the stable booking/audit/configuration core.
