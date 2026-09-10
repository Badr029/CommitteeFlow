# Business rules

The specification marks several rules as **open** and instructs the
implementation not to invent them (spec §46, §78, §79). This document records
which have since been confirmed, what was decided, why, and what remains open.

Rules 1 to 4 are stored in the `app_settings` table and edited from
**Plan Configuration → Booking rules**. Changing one takes effect immediately —
no migration, no redeploy, no code change. That is the whole point: a plan's
rules outlive any single decision about them.

Rules 5 to 7 are different in kind. They are not preferences to be toggled but
corrections to what the data *means* — what Status is, what Cancel and Delete
each do, who owns a project. They are settled in the schema and in the code, and
this document records the decision rather than a setting.

---

## 1. Committee slot exclusivity — **CONFIRMED**

> Spec §46, §78.1 — *"The coding agent must not invent this rule."*

**Setting:** `booking_slot_uniqueness` **Confirmed value:** `NONE`

### The decision

**A committee slot is not exclusive.** `Date + Time + Committee` identifies a
**shared Committee Session**, not a unique booking.

One committee sitting at one date and time reviews **several projects**. South
Committee at 10:00 may have four different projects booked into that single
session. Different committees may also run in parallel at the same date and time.

Concretely:

- No `UNIQUE` constraint on `(booking_date, booking_time, committee)`.
- A second booking into an occupied session is **never rejected**.
- Concurrent bookings into the same session may **all** succeed.
- The plan groups by `Date → Session → projects`, and the booking form shows what
  is already in the session being joined — as information, never as a block.

### Why the alternatives stay implemented

`DATE`, `DATE_TIME` and `DATE_TIME_COMMITTEE` remain implemented and fully
tested. If the business ever tightens the rule, it is a dropdown, not a project.

Enforcement, at any value, happens **inside the write transaction** under a
PostgreSQL advisory lock keyed on the exclusivity key
(`server/src/modules/bookings/bookings.service.ts`). The lock lives in the
database, so the guarantee holds across multiple application containers, and it
is released automatically when the transaction ends. `concurrency.test.ts` proves
it: with `DATE_TIME_COMMITTEE` set, three engineers submitting the same slot in
the same instant produce exactly one booking and two `409 SLOT_CONFLICT`
responses.

### If the rule is ever tightened

Add a partial unique index as a second line of defence, in a new migration:

```sql
-- Only if booking_slot_uniqueness becomes DATE_TIME_COMMITTEE.
CREATE UNIQUE INDEX CONCURRENTLY bookings_exclusive_slot_idx
    ON bookings (booking_date, booking_time, committee)
 WHERE booking_state = 'ACTIVE';
```

Existing data must be deduplicated first — under the confirmed rule, duplicates
are legitimate and expected.

---

## 2. Who may edit or cancel a booking — **CONFIRMED**

> Spec §41, §78.2

**Setting:** `booking_edit_policy` **Confirmed value:** `ANY_ENGINEER`

**Any Project Engineer may edit or cancel any booking.** This matches §41 read
literally and suits a shared monthly plan where whoever is available fixes a
time. Viewers can never write, whatever this is set to.

Ownership is never lost: `created_by` and `created_at` are immutable, `updated_by`
and `updated_at` track the last change, and every change is in the booking's
history with its author. The audit trail is what makes a permissive rule safe.

Alternatives, if the business later wants stricter ownership:

| Value | Effect |
|---|---|
| `CREATOR_ONLY` | Only the engineer who created the booking may change it. Nobody can fix a colleague's slot while they are on leave. |
| `CREATOR_OR_PLAN_MANAGER` | The creator, plus anyone holding `can_manage_plan_configuration`. A named escalation path. |

Enforced at the object level in `assertCanModify`, not only at the route
(spec §42) — knowing a booking's id never implies permission to change it.

---

## 3. How far ahead a booking may be made — **CONFIRMED**

> Spec §9, §78.3

**Setting:** `booking_future_horizon_months` **Confirmed value:** `6`

Bookings may be created up to **6 whole months ahead**, counted to the end of the
target month. Beyond that the API returns `422` naming the limit and the last
bookable date.

**Past dates stay open.** The horizon limits *future* planning only, so a booking
that was missed can always be entered into the record afterwards. Restricting the
past would make the plan a worse historical record without protecting anything.

Set to `null` for unlimited, or any value from 1 to 120 months.

---

## 4. Who receives notifications — **CONFIRMED**

> Spec §16 requires notifications for create, update and cancel. It does not say
> who receives them; §4.2 says Viewers receive notifications.

**Setting:** `notification_audience` **Confirmed value:** `ALL_ACTIVE_USERS`

Every active account receives booking notifications, and any individual may opt
out with `users.notify_by_email`. `ENGINEERS_ONLY` narrows it to Project
Engineers.

Recipients go in **BCC**: a plan-wide notification must not disclose the full
internal distribution list to everyone who receives it.

---

## 5. What Status means — **CORRECTED**

The `Status` column in the plan CommitteeFlow replaced was never a status. It
was being used for **transformer serial and reference numbers**:

```
010662606B-020662606B-030662606B-040662606B
DD-001600-022000-S289
invoice-010182515B-010442610B
```

CommitteeFlow imported those faithfully into a field it treated as a business
status, which is how a booking came to have a "status" of `010662606B`.

### The decision

**Status is the booking's lifecycle, and has exactly two values.**

```
PLANNED     a booking that is going ahead
CANCELLED   the committee is no longer coming
```

A new booking is PLANNED. Nothing else can be typed into it — Status is set by
the application, through the explicit Cancel action, and the booking form does
not offer it.

**Serial No.** (`serial_no`) is where the transformer serials live. Text, never
parsed as a number: leading zeros are significant, and one cell routinely holds
several references joined by hyphens.

### One lifecycle, not two

Before this, `booking_state` (ACTIVE/CANCELLED) drove cancellation while
`status` was free text. Two columns describing the same thing made
`status = 'Done', booking_state = 'CANCELLED'` representable — a contradiction
nothing could resolve. They are now one column, `bookings.status`, of type
`booking_status`.

Status is also no longer a field a plan manager can reshape. Its label, order
and visibility stay configurable; its type and its two values do not, because
the application depends on them.

---

## 6. Cancel and Delete are different things — **CONFIRMED**

### Cancel

The booking was legitimate; the committee is no longer coming.

**The booking stays on the plan, struck through.** This is the point of it, and
the reason confirmed by the business: people need to see that a committee they
were preparing for has been called off. A booking that simply vanished would
leave another team moving a transformer for a sitting that is not happening.

Cancelling records who did it and when, notifies the plan, and applies **to that
booking only** — a shared Committee Session with four projects in it does not
become cancelled because one of them did.

### Delete

The booking should never have existed: a duplicate, the wrong project, a row
entered by mistake.

**The booking leaves the plan**, and is not shown even when cancelled bookings
are asked for — there is nothing for anyone to see. But the row is kept, with
`deleted_at` and `deleted_by`: the plan is auditable, and "who removed this, and
when" has to survive a correction.

Deleting **never** sets the status to CANCELLED. They are separate events with
separate history entries, because a plan that showed a deletion as a
cancellation could no longer say which had happened.

Delete is a secondary action in the interface, behind a stronger confirmation
that names the alternative — most people reaching for it want Cancel.

---

## 7. Who owns a project — **CONFIRMED**

**Project Engineer** (`project_engineer_id`) is the engineer responsible for a
project being on the plan. It is a reference to a CommitteeFlow account, never
free text, so it keeps meaning when somebody is renamed.

It is assigned **automatically** from whoever is signed in. Nobody selects their
own name from a list.

### Why not `created_by`

They answer different questions, and the difference is not academic:

| | Answers |
|---|---|
| `project_engineer_id` | whose project this is |
| `created_by` | which account wrote the row |
| `updated_by` | which account last changed it |

For an ordinary booking they are the same person. They diverge the moment
anyone imports a sheet — one upload would otherwise make the importer the
"owner" of every project in the file — or books on a colleague's behalf.

### What does not change it

Ownership survives everything except an explicit reassignment, which the product
does not currently offer:

* Editing a booking does not reassign it.
* Cancelling it does not reassign it. If Ahmed placed it and Mohamed cancels it,
  the Project Engineer is still Ahmed and `cancelled_by` is Mohamed.
* Deleting it does not reassign it.

### Imports

An import leaves the Project Engineer **unknown** unless the file named someone
the system could match to exactly one account. Recording the importer would be
inventing ownership nobody stated, which is worse than admitting it is not
known. `created_by` still records who ran the import, so the row remains
auditable either way.

The **Project Engineer** filter on the plan replaced a "Created By" filter that
was answering the wrong question — after an import, every row in the month
shared one creator.

---

## Still open

Nothing currently blocks the MVP. These would each need a decision before the
matching feature could be built, and none has been guessed at.

### Password policy and account lifecycle

There is no self-service password reset and no user-administration screen — the
MVP sitemap deliberately excludes one (spec §7). Accounts are created with
`npm run seed` or directly in the database. Before wider rollout, confirm:

- minimum password requirements, and whether rotation is expected;
- who may create and deactivate accounts, and through what interface;
- whether this is superseded entirely by corporate SSO (spec §40), which would
  make most of the question moot — `users.external_identity_id` already exists
  for that mapping.

Currently: passwords are Argon2id-hashed with a 10-character minimum enforced by
the seed script, and accounts are locked for 15 minutes after
`LOGIN_RATE_LIMIT_MAX_ATTEMPTS` consecutive failures.

### Committee names

`committee` is free text. If the company has a fixed list, a plan manager can
convert it to a Select field with the real options from Plan Configuration —
the implementation permits `TEXT → SELECT` on a populated field precisely when
every stored value is already one of the new options, so nothing is lost. That is
a configuration change, not a code change; it simply needs the list.

### Business status values

`status` is likewise free text, and the same conversion path applies. The
implementation infers a colour from the wording (done/approved reads as success,
hold/review as caution, failed/rejected as danger) and anything unrecognised
reads as neutral, so an unconfirmed vocabulary degrades gracefully.

### Retention

Cancelled bookings, booking history and configuration history are kept
indefinitely. If a retention or archival policy applies to company records, it
has not been stated and nothing has been assumed.

### Notification batching

Every create, update and cancel sends an email. On a busy month that is a lot of
mail. Whether the business wants digesting, throttling or per-committee
subscriptions is unconfirmed; the outbox schema would support all three without a
migration.

---

## How to change a rule

**Through the interface** — sign in as a user holding
`can_manage_plan_configuration`, open **Plan Configuration → Booking rules**, and
change it. The change is recorded with its author.

**Directly**, for a scripted deployment:

```sql
UPDATE app_settings
   SET value = '"DATE_TIME_COMMITTEE"'::jsonb, updated_at = now()
 WHERE key = 'booking_slot_uniqueness';
```

Values are cached in-process for 30 seconds, so a direct change reaches every
application container within that window without any coordination infrastructure.
