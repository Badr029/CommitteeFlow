# BUG-018–026 verification

Date: 2026-09-13

## Evidence boundary

Only user-supplied screenshots 391, 392 and 399 belong to this work. They record
the pre-fix login-route context, protected-plan loading skeleton and duplicate
search clear control. No adjacent screenshots were used.

## Local checks

- Server and client TypeScript: PASS.
- Server and client lint: PASS, zero warnings.
- Impeccable detector across changed UI files: PASS, zero findings.
- Targeted client regression: 4 files, 29 tests, all PASS.
- Full client run: 88 tests passed; one unrelated booking-form test timed out
  under the parallel full-suite load. Its complete 13-test file passed on an
  immediate isolated rerun, including the timed-out case.
- Server unit suite: 5 files, 108 tests passed, 3 skipped.
- Production client/server build: PASS.
- Server integration rerun: NOT EXECUTED; local Docker engine/PostgreSQL was unavailable.
- Deployment/mobile retest: NOT EXECUTED.

## Covered behavior

- Sign-in-shaped authentication loading state; no plan skeleton.
- Exact pathname/query return after login.
- Mandatory non-dismissible first-login password replacement.
- First login omits Current password; normal Change password requires it.
- Password reveal controls; normal dialog retains Cancel without a second close icon.
- Independent pagination for plan-access accounts and configuration history.
- Optional Keep me signed in request reaches the API.
- Server implementation selects a session cookie when clear and a rolling
  30-day cookie when selected, preserves it across session-ID rotation, and
  leaves server-side session-only records bounded by `SESSION_TTL_HOURS`.

## Required deployed checks

1. Same-browser tabs/windows share one login.
2. With Keep me signed in selected, close/reopen the browser and confirm login remains.
3. Without it selected, close the browser session and confirm reauthentication is required.
4. Follow an email link in the default browser and confirm exact-route return.
5. Test the email application's in-app browser separately; isolated webview
   cookies cannot be supplied by CommitteeFlow and may require Open in browser.
