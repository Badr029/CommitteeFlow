# Managing users

CommitteeFlow has no user-administration screen. The MVP sitemap does not
include one (spec §7), and inventing one would have meant inventing the rules
around it — who may create accounts, whether people can be deleted, what happens
to their bookings. So accounts are managed from the command line, with one
exception: **who can configure the plan** is a control on the Plan Configuration
screen, because that permission changes daily work and the people who hold it
are the ones who need to see the list.

Everything below runs on the machine that can reach the database, from the
project root. It reads `.env` for `DATABASE_URL`, the same as the server does.

---

## The one thing you can do in the application

**Plan Configuration → Who can configure the plan.**

Tick or untick an account. That grants or revokes the permission to rename
fields, change what is required, add and archive fields, and set the booking
rules — and it is recorded in the configuration history like any other change.

Two things it will refuse:

* **Removing your own access.** Ask a colleague. This is the one mistake that
  cannot be undone from inside the application.
* **Removing the last plan manager.** Give someone else access first.

Everything else about an account — creating it, the password, engineer vs
viewer, deactivating someone who has left — is below.

---

## Everything else: `npm run users`

```bash
npm run users -- list
```

Prints every account, what it can do, and when it last signed in. Run this
first; the commands below take the **email address** as the identifier.

### Add someone

```bash
npm run users -- add "Ahmed Fathy" ahmed@example.com --engineer
```

| Flag | Meaning |
|---|---|
| *(none)* | **Viewer** — reads the plan and exports it, changes nothing |
| `--engineer` | **Project Engineer** — creates, edits and cancels bookings |
| `--can-configure` | may also change Plan Configuration |
| `--no-email` | no booking notifications |

You are prompted for a password. It is never taken as an argument, where it
would sit in your shell history. To script it, set `CFLOW_PASSWORD` for the one
command instead:

```bash
CFLOW_PASSWORD='a long first password' npm run users -- add "Ahmed Fathy" ahmed@example.com --engineer
```

On Windows PowerShell:

```powershell
$env:CFLOW_PASSWORD = 'a long first password'; npm run users -- add "Ahmed Fathy" ahmed@example.com --engineer; Remove-Item Env:CFLOW_PASSWORD
```

Ask them to change it after their first sign-in.

### Change someone

```bash
npm run users -- password ahmed@example.com          # forgotten password
npm run users -- role ahmed@example.com viewer       # or: engineer
npm run users -- configure ahmed@example.com on      # or: off
npm run users -- rename ahmed@example.com "Ahmed Fathy Ibrahim"
```

`configure` does the same thing as the tick box on the Plan Configuration
screen, and applies the same last-plan-manager guard.

### When someone leaves

```bash
npm run users -- deactivate ahmed@example.com
```

They can no longer sign in. Their name stays on the bookings they made, in the
history of every booking they touched, and as the Project Engineer of their
projects — which is the point: the plan has to stay readable backwards. Nothing
in this tool deletes a user, and neither should you: the foreign keys would
either fail or blank out the record of who did what.

If they come back:

```bash
npm run users -- activate ahmed@example.com
```

This also clears a lockout from repeated failed sign-ins.

---

## The very first account

On a fresh database there is nobody to sign in as. The seed script creates one:

```bash
SEED_ADMIN_NAME="Your Name" \
SEED_ADMIN_EMAIL="you@example.com" \
SEED_ADMIN_PASSWORD="a long first password" \
npm run seed
```

It creates a Project Engineer who can configure the plan, and it is idempotent —
running it again on an existing account changes nothing, including the password.
It will refuse to run without `SEED_ADMIN_PASSWORD` rather than invent one.

---

## Doing it in SQL directly

You can, for everything except passwords, which are Argon2 hashes the database
cannot produce. If you are already in `psql`:

```sql
-- who is who
SELECT name, email, role, can_manage_plan_configuration, is_active FROM users ORDER BY name;

-- make someone an engineer
UPDATE users SET role = 'PROJECT_ENGINEER', updated_at = now() WHERE lower(email) = 'ahmed@example.com';

-- grant Plan Configuration
UPDATE users SET can_manage_plan_configuration = true, updated_at = now() WHERE lower(email) = 'ahmed@example.com';

-- deactivate
UPDATE users SET is_active = false, updated_at = now() WHERE lower(email) = 'ahmed@example.com';
```

`role` is `'PROJECT_ENGINEER'` or `'VIEWER'`. Email is unique case-insensitively,
so match with `lower(email)`.

Two warnings if you go this way:

* Nothing checks that a plan manager remains. `UPDATE users SET
  can_manage_plan_configuration = false` with no `WHERE` locks the Plan
  Configuration screen away from everyone, and only SQL can open it again.
* `DELETE FROM users` is not a way to remove someone. Use `is_active = false`.

For a password, use `npm run users -- password`.

---

## What the roles mean

| | Viewer | Project Engineer | + can configure |
|---|---|---|---|
| Read the plan, filter, export | ✓ | ✓ | ✓ |
| Create, edit and cancel bookings | | ✓ | ✓ |
| Import a spreadsheet | | ✓ | ✓ |
| Plan Configuration and booking rules | | | ✓ |

Who may edit *someone else's* booking is a separate rule, set on the Plan
Configuration screen under **Booking rules → Who can edit a booking**.
