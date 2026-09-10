# CommitteeFlow — UI defect reports

Fifteen defects on the Committee Plan, the sign-in screen, the import, the
exports and the application shell. Each is something a user meets in the
interface, so each is reproducible black-box: no source access, no database, no
container.

* **BUG-001 to BUG-004** were found while building the application.
* **BUG-005 and BUG-006** were found while making it work on phones and tablets
  — BUG-005 had been in the product since the plan was first built, and only
  became visible once the plan was opened on a narrow screen.
* **BUG-007 to BUG-013** were reported by the product owner working with the
  real September plan, on the screens an ordinary pass reaches last: signing in
  with a saved password, signing out, reading a full month, importing the real
  sheet, and printing it.
* **BUG-014** was found while fixing BUG-013, in the same export.
* **BUG-015** was reported directly by the product owner exercising the new
  minimise controls from BUG-011.

**All fifteen are fixed.** The current build does not exhibit them, so raise
any of them only against a build older than this one. Each Actual Result
describes the build the defect was found in.

Each report below is one Jira issue: the **Priority** field, then the
**Description** body. The fix comments that go on the issues once the fixes land
are in [`CommitteeFlow_Fix_Comments.md`](CommitteeFlow_Fix_Comments.md), because
a fix note is a comment on an issue, not part of its description.

Screenshots and measurements are in `QA-Evidence/`. Regenerate them with
`npm run capture` and `npm run capture:responsive` from `qa/tools`.

---

## BUG-001 — Committee Plan: column headings and day counts are too faint to read

Screenshot: `QA-Evidence/screenshots/BUG-001-faint-column-headings.png`

Priority

Medium

Description

Steps to Reproduce

1. Set the operating system to the light appearance and sign in as a Project Engineer.
2. Open the Committee Plan on a month that has bookings.
3. Read the column headings above the table — OFF NO., ORDER NAME, QTY, KVA, KV, STATUS, NOTES, CUSTOMER NAME.
4. Read the session and project counts at the right of each day heading.
5. Measure the contrast of both against their backgrounds with a contrast checker.

Expected Result

* Every label on the plan is legible against its background.
* Text below 18.66px reaches the 4.5:1 contrast minimum.

Actual Result

* The column headings measure **4.11:1** — `rgb(111, 122, 133)` on `rgb(247, 248, 248)`, 11px, weight 600.
* The per-day session and project counts measure **3.76:1** — the same ink on the `rgb(236, 238, 240)` day-heading band.
* Both are below the 4.5:1 required at that size, and the day counts are below the 3:1 floor that applies even to large text.
* The headings are the only thing that says whether `1,500` in a row is KVA or KV, so on a bright office screen the first thing to disappear is the thing that gives the numbers their meaning.

---

## BUG-002 — Committee Plan: column headings scroll out of view, leaving rows unlabelled

Screenshot: `QA-Evidence/screenshots/BUG-002-headings-scrolled-away.png`

Priority

High

Description

Steps to Reproduce

1. Sign in and open the Committee Plan on a month whose bookings do not fit on one screen — September 2026 with 16 bookings at 1360 x 720 is enough.
2. Scroll down 600px, into the middle of the month.
3. Look at the top of the window.
4. Try to tell which of the two adjacent numeric columns is KVA and which is KV.

Expected Result

* The column headings and the day heading stay pinned at the top while the plan scrolls, so any row can be read against the columns it belongs to.
* The month navigator, search, filters and Book Committee Slot stay reachable without scrolling back up.

Actual Result

* The column heading row sits at `top: -466px` — entirely above the viewport.
* The application top bar has scrolled away with it, so the month navigator, the filters and Book Committee Slot are all off-screen.
* Eight columns of numbers and text are left unlabelled, and KVA and KV are adjacent numeric columns, so nothing on screen distinguishes them.
* The defect only appears once a month is long enough to overflow the window. A short month hides it, which is why it survived earlier passes.

---

## BUG-003 — Application: opens in the light theme for a user whose system is set to dark

Screenshot: `QA-Evidence/screenshots/BUG-003-light-theme-on-dark-system.png`

Priority

Medium

Description

Steps to Reproduce

1. Set the operating system, or the browser, to the dark appearance.
2. Open the application in a browser profile that has never stored a theme preference — a fresh profile, or after clearing site data.
3. Observe the plan.
4. Open the browser console.

Expected Result

* With no stored preference the application follows the system appearance and opens dark.

Actual Result

* The application opens white. `prefers-color-scheme: dark` reports true, yet the page background is `rgb(247, 248, 248)` and `<html data-theme>` is `light`.
* The theme control in the top bar still works, so the user can switch by hand — but the choice is not honoured on load, and any browser without a stored preference opens white again.
* The console reports: `Executing inline script violates the following Content Security Policy directive 'script-src 'self''. … The action has been blocked.`
* The theme is decided before first paint by a script the page's own security policy refuses to run, so it never runs for any user in any browser. The visible symptom is simply loudest for someone on a dark system.

---

## BUG-004 — Book Committee Slot: required fields are announced as optional

Screenshot: `QA-Evidence/screenshots/BUG-004-required-not-announced.png`

Priority

Medium

Description

Steps to Reproduce

1. Sign in as a Project Engineer and select Book Committee Slot.
2. Inspect the OFF No. field in the browser's accessibility panel, or read the form with a screen reader.
3. Leave OFF No. empty, complete the rest of the form, and select Book slot.

Expected Result

* A field the plan marks required is announced as required to every user, before they try to save — not only to those who can see the red asterisk.

Actual Result

* On the OFF No. control, `aria-required` is absent and `required` is absent.
* The label's text is `"OFF No.*"`, but its accessible name is `"OFF No."` — the asterisk carries `aria-hidden="true"`, so it is excluded from what is announced.
* A screen reader therefore presents an ordinary optional text box, and the first indication that the field was required is a validation error after the save is refused.
* Four of the eleven fields on the form are required, and which four is configurable from Plan Configuration, so a user who cannot see the asterisks has no way to learn the current set except by submitting and being refused.

---

## BUG-005 — Committee Plan: every screen under 1000px has to be dragged sideways to read a row

Screenshot: `QA-Evidence/screenshots/BUG-005-table-forced-sideways.png`

Priority

Highest

Description

Steps to Reproduce

1. Sign in as a Project Engineer on a phone, or narrow a desktop browser to a 375 x 812 viewport.
2. Open the Committee Plan on a month that has bookings.
3. Try to read the Qty, KVA, KV or Status of the first booking.
4. Drag the plan sideways until those columns are on screen.
5. Look for the OFF number of the row being read.

Expected Result

* The plan can be read on the screen it is opened on.
* Scrolling down a month is expected; scrolling sideways to read a single row is not.

Actual Result

* The plan renders its eight-column table at a fixed **1002px** inside a **375px** viewport, so every row extends 627px beyond the right edge.
* Reaching Status means dragging the plan sideways, and the OFF number — the column a booking is identified by — leaves the screen as you do, so the row being read is no longer labelled.
* Committee, date and time are headings above the rows rather than columns, so once the plan is scrolled right there is nothing on screen tying a value to a project **or** to a session.
* This is the screen the product exists for, and the one a Project Engineer is most likely to open away from a desk.

---

## BUG-006 — Committee Plan: a phone held sideways shows one row of the month

Screenshot: `QA-Evidence/screenshots/BUG-006-landscape-chrome.png`

Priority

Medium

Description

Steps to Reproduce

1. Sign in as a Project Engineer on a phone and open the Committee Plan.
2. Turn the phone sideways — roughly 667 x 375.
3. Read the plan without scrolling.
4. Count how many bookings are on screen.

Expected Result

* Turning the phone sideways gives the plan more usable room, or at worst the same.
* The controls exist to reach the plan, not to replace it.

Actual Result

* The plan is left **102px** of a 375px-tall screen. The other **273px** is the top bar, two rows of toolbar, the summary strip and the bottom navigation.
* What fits is one day heading, one session heading and the first line of one booking, so the screen shows a single project out of a month of them.
* The toolbar stacks the month row above the search row even at 667px wide, where both would fit on one line with room to spare, so the cost is paid in the dimension that is already short.

---

## BUG-007 — Sign out: the plan stays on screen and the session looks live

Screenshot: `QA-Evidence/screenshots/BUG-007-logout-leaves-plan-on-screen.png`
Measurements: `QA-Evidence/logs/BUG-007-logout-state.json`

Priority

High

Description

Steps to Reproduce

1. Sign in as a Project Engineer and open the Committee Plan on a month with bookings.
2. Press the sign-out control at the top right of the application bar.
3. Do not reload. Read the screen.
4. Open the browser's network panel and request `/api/auth/session`.

Expected Result

* Pressing sign out ends the session and the sign-in screen appears immediately.
* Nothing that requires a session stays on screen after it has ended.

Actual Result

* `GET /api/auth/session` answers **401** — the server session really has ended — while the plan, the account name and the role chip are all still rendered.
* The only way to reach the sign-in screen is to reload the page by hand.
* On a shared machine the screen says the previous user is still signed in, and every control on it is still offered. The plan itself is stale data from before the session ended: no write from it can succeed, and nothing says why.

---

## BUG-008 — Sign in: the button is dead on a form the password manager has just filled

Screenshot: `QA-Evidence/screenshots/BUG-008-signin-blocked-after-autofill.png`
Measurements: `QA-Evidence/logs/BUG-008-autofill-state.json`

Priority

High

Description

Steps to Reproduce

1. Sign in once and let the browser or password manager save the credentials.
2. Sign out, or reopen the application in a new session.
3. Let the browser fill the email and password fields. Do not type in either one.
4. Read both fields, then try to press **Sign in**.

Expected Result

* A form that visibly holds an email address and a password can be submitted.
* If a control cannot be used, it says why.

Actual Result

* Both fields visibly hold text — the email reads `ahmed@committeeflow.test` and the password shows 21 characters — and **Sign in** is disabled.
* Clicking into either field, or pressing any key in it, wakes the button up. Nothing on screen connects the two.
* The button was disabled from React state, and a password manager writes straight to the DOM value without firing the synthetic change React listens for. So the state the button consults is empty at exactly the moment the form is full.
* This is the first screen of the product, and it is broken for the users most likely to have saved their password — which after the first sign-in is all of them.

---

## BUG-009 — Sign in: a typed password cannot be checked before submitting

Screenshot: `QA-Evidence/screenshots/BUG-009-password-cannot-be-revealed.png`
Measurements: `QA-Evidence/logs/BUG-009-password-field.json`

Priority

Low

Description

Steps to Reproduce

1. Open the application signed out.
2. Type a password of fifteen characters or more into the password field.
3. Look for a way to check what was typed before submitting.

Expected Result

* The password can be revealed and re-hidden without clearing the field.
* The control announces whether the password is currently shown.

Actual Result

* The field is masked with no reveal control anywhere on the form.
* A mistyped password can only be found by clearing the field and typing the whole thing again, which is where a long passphrase gets abandoned for a short one.
* The failure that follows is the same "email address or password is incorrect" a wrong account produces, so the user cannot tell a typo from a wrong address.

---

## BUG-010 — Sign in: a successful sign-in is never acknowledged

Screenshot: `QA-Evidence/screenshots/BUG-010-no-sign-in-confirmation.png`
Measurements: `QA-Evidence/logs/BUG-010-sign-in-feedback.json`

Priority

Low

Description

Steps to Reproduce

1. Open the application signed out.
2. Sign in with valid credentials.
3. Watch the screen as the plan appears.

Expected Result

* A successful sign-in is confirmed, and says which account signed in.
* A read-only account learns that it is read-only before it tries to book something.

Actual Result

* Nothing is shown. The plan simply appears.
* Which account signed in is only discoverable by reading the top-right corner of the application bar, at 11px, after the fact.
* CommitteeFlow has two roles with materially different permissions. A Viewer signing in gets no indication that booking is unavailable until they look for a control that is not there.
* Every other outcome in the product is acknowledged — a booking, an import, an export failure. Sign-in is the one that is not.

---

## BUG-011 — Committee Plan: day, committee session and project are drawn at almost the same weight

Screenshot: `QA-Evidence/screenshots/BUG-011-grouping-indistinguishable.png`
Measurements: `QA-Evidence/logs/BUG-011-grouping-weights.json`

Priority

Medium

Description

Steps to Reproduce

1. Sign in and open the Committee Plan on a full month — September 2026, 16 bookings across 13 sessions, is enough.
2. Scroll to the middle of the month.
3. Without scrolling back, say which day and which committee session the row under the cursor belongs to.
4. Try to hide a day you have finished with, and try to look at one day on its own.

Expected Result

* The three levels of the plan — day, committee session, project — are told apart at a glance.
* A day that has been dealt with can be minimised, and the month can be narrowed to a single day.

Actual Result

* The day heading and the session heading sit one step apart in tone: `rgb(236, 238, 240)` against `rgb(241, 243, 245)`, both against white rows. Nothing bounds a day, so days run into one another as one continuous list.
* A row halfway down the month has no anchor: its date, time and committee are all headings that may be several screens above it.
* Nothing collapses. Reading the 24th means scrolling past the 1st to the 23rd every time.
* There is no way to filter to a day. The month is all-or-nothing, on the screen the product exists for.

---

## BUG-012 — Import: the KV column of the real Committee Plan cannot be imported at all

Screenshot: `QA-Evidence/screenshots/BUG-012-kv-column-cannot-be-imported.png`
Measurements: `QA-Evidence/logs/BUG-012-kv-mapping.json`

Priority

High

Description

Steps to Reproduce

1. Sign in as a Project Engineer and press **Import Plan**.
2. Upload a Committee Plan whose KV column holds voltage ratios — `11/0.4`, `22/0.4`, `6.6/0.42`. The September plan is one.
3. Read the KV row on the **Columns** step.
4. Try to choose a destination for it from the list offered.

Expected Result

* Every column of the plan the product is replacing can be brought into it.
* A voltage recorded as a ratio survives the import as it was written.

Actual Result

* KV is set to **Do not import**, with: *"KV stores a number, but this column holds values like "11/0.4". Map it to a text field, or ignore it."*
* There is no text field to map it to. KV is the only field that means voltage, and it was a numeric column, so the advice the message gives cannot be followed.
* The importer is behaving correctly — filing `11/0.4` in a numeric column would fail on every row. The column was modelled wrongly: a transformation ratio is two numbers and the relationship between them, which no single number can hold.
* The result is that a plan imported from the real sheet arrives with the voltage silently missing from every row, and the only record of it is the spreadsheet the import was meant to retire.

---

## BUG-013 — Export: the printed plan is not the form the plan is circulated on

Attachment: export any month as PDF from the application and compare it with the issued form.

Priority

Medium

Description

Steps to Reproduce

1. Sign in and open the Committee Plan on a month with bookings.
2. Press **PDF** in the summary strip.
3. Open the file beside the Committee Plan form the plan is currently circulated on.
4. Compare them as documents, not as data.

Expected Result

* The exported PDF is recognisable as the controlled form it replaces, so it can be circulated without re-typing.
* The month reads as a calendar: every day present, each day's rows grouped under one date.

Actual Result

* The export is a generic striped table: a dark blue heading strip, alternating grey rows, no cell rules, and a subtitle of ISO dates and an export timestamp.
* The document code and revision the form is controlled by (`Code : PM-FR-01-02-D`, `Rev: (0)`) are absent, so the output cannot be filed as an issue of that form.
* The date repeats on every row instead of covering the rows it applies to, so a committee sitting with four projects reads as four unrelated lines.
* Days with nothing booked are omitted. A month with bookings on six days prints six rows, and a reader cannot tell a free committee day from a day that fell off the end of a filter.
* The weekday, which the source form carries beside the date, is not printed at all.

---

## BUG-014 — Export: committee names outside Latin-1 reach the PDF as corrupted text

Screenshot: `QA-Evidence/screenshots/BUG-014-rtl-vs-browser.png`
Trace: `QA-Evidence/logs/BUG-014-trace.md`
Measurements: `QA-Evidence/logs/BUG-014-pdf-text-runs.json`

Priority

High

Description

Steps to Reproduce

1. Sign in and create or import a booking whose committee is written in Arabic — `وطنية` is one that appears in the September plan.
2. Open that month and press **PDF**.
3. Read the Committee column for that booking.
4. Confirm it against the file itself rather than the viewer: `node qa/tools/inspect-pdf-export.mjs <the exported file>`.

Expected Result

* A committee name is printed as it was entered, whatever script it is written in.
* If a name genuinely cannot be printed, that is visible as a failure rather than as different text.

Actual Result

* `وطنية` is printed as **`d†7dfJb•`**. Two further committee names in the same month come out as `dV5df9 bvFc6Hb¦C` and `bvDd␖1böHc0`.
* The bytes on the page are `64 86 37 64 66 4A 62 90` — the name has been encoded through a font that has no Arabic in it, one byte per character, and the result happens to be printable Latin.
* That is the dangerous part: the output does not look broken. It looks like corrupted data, and a reader has no way to tell that the PDF is at fault rather than the plan.
* The export uses the standard PDF fonts, which are Latin-1 only. Printing Arabic needs an embedded font that covers the script **and** right-to-left reordering, which the PDF library does not do on its own — so this is a change of substance, not a setting.
* Three of thirty-eight rows in the September plan are affected. The plan the product replaces is bilingual, so this is not an edge case in this deployment.

Where the value breaks

* Traced before anything was changed, because "the data is corrupted" and "the data cannot be printed" call for opposite fixes. The full trace is in `QA-Evidence/logs/BUG-014-trace.md`.
* **PostgreSQL** holds `وطنية` as 5 characters, 10 bytes, `d988d8b7d986d98ad8a9` — correct UTF-8 in logical order.
* **The API** returns the same five codepoints, byte for byte.
* **The export service** is handed the same string.
* **The generated PDF** is the first and only place it changes.
* This is therefore a **PDF font and text-rendering defect, not corrupted application data**. Nothing stored was repaired, because nothing stored was wrong — treating it as bad data would have rewritten correct records and left the export just as broken.

---

## BUG-015 — Committee Plan: minimising a day or session hides nothing

Screenshot: `QA-Evidence/screenshots/BUG-015-minimise-does-nothing.png`
Fixed, for comparison: `QA-Evidence/screenshots/BUG-015-fixed-for-comparison.png`
Measurements: `QA-Evidence/logs/BUG-015-collapse-state.json`

Priority

Medium

Description

Steps to Reproduce

1. Sign in and open the Committee Plan on a month with bookings.
2. Press the chevron beside a day heading — for example **09 September**.
3. Read the day's rows, or open the browser's element inspector on the day's body.

Expected Result

* Pressing the chevron hides that day's sessions and rows, and the day heading keeps its counts so the total is not lost.
* The same holds for a session's own chevron, one level down.

Actual Result

* The chevron itself works: it rotates, and `aria-expanded` on the button flips from `true` to `false` (`QA-Evidence/logs/BUG-015-collapse-state.json`).
* The `hidden` attribute is correctly set on the day's body element — confirmed directly on the DOM node — but every row underneath stays exactly as visible as before. Nothing on screen changes except the arrow.
* The cause is a CSS collision, not the click handler: `.dayBody { display: flex; flex-direction: column; }` and `.sessionBody { display: flex; flex-direction: column; }` share the same selector specificity as the browser's own built-in `[hidden] { display: none }` rule, and because the stylesheet is loaded after that rule, `display: flex` wins. Setting `hidden` on either element has no visible effect.
* A user pressing the control has no way to tell it did anything at all — there is no error, no partial effect, nothing. The only observable change is the arrow, which most people are not looking at.
* Same defect, same cause, on both levels: the day chevron and the session chevron.

---


## Summary

| ID | Title | Priority |
|---|---|---|
| BUG-001 | Committee Plan: column headings and day counts are too faint to read | Medium |
| BUG-002 | Committee Plan: column headings scroll out of view, leaving rows unlabelled | High |
| BUG-003 | Application: opens in the light theme for a user whose system is set to dark | Medium |
| BUG-004 | Book Committee Slot: required fields are announced as optional | Medium |
| BUG-005 | Committee Plan: every screen under 1000px has to be dragged sideways to read a row | Highest |
| BUG-006 | Committee Plan: a phone held sideways shows one row of the month | Medium |
| BUG-007 | Sign out: the plan stays on screen and the session looks live | High |
| BUG-008 | Sign in: the button is dead on a form the password manager has just filled | High |
| BUG-009 | Sign in: a typed password cannot be checked before submitting | Low |
| BUG-010 | Sign in: a successful sign-in is never acknowledged | Low |
| BUG-011 | Committee Plan: day, committee session and project are drawn at almost the same weight | Medium |
| BUG-012 | Import: the KV column of the real Committee Plan cannot be imported at all | High |
| BUG-013 | Export: the printed plan is not the form the plan is circulated on | Medium |
| BUG-014 | Export: committee names outside Latin-1 reach the PDF as corrupted text | High |
| BUG-015 | Committee Plan: minimising a day or session hides nothing | Medium |

Five of BUG-001 to BUG-006 are only visible under a condition an ordinary pass
would miss: a long month, a dark system, a screen reader, a narrow screen, or a
phone turned sideways. Worth carrying into the manual suite as **conditions
applied to the existing cases** rather than as six more one-off cases — the same
booking case run at 375px, at 375px landscape, and on a desktop finds all of
them.

BUG-007 to BUG-014 divide differently, and the division is worth keeping:

* **Four are about the second visit, not the first.** BUG-007 through BUG-010
  all sit on the sign-in and sign-out path, which a test pass walks through once
  at the start of every case and therefore never really examines. BUG-008 in
  particular cannot be found by a tester who types their password, only by one
  who has let the browser save it — which is everyone, after the first day.
* **Three are about the real data, not the fixture.** BUG-011, BUG-012 and
  BUG-013 needed the September plan: 38 projects across 22 sessions, voltages
  written as ratios, and a controlled form to compare the print against. A
  three-booking fixture shows none of them.
* **One was found by fixing another.** BUG-014 surfaced while BUG-013 was being
  worked, and is the more serious of the two: BUG-013 makes the export look
  wrong, BUG-014 makes it look right and read wrong.
* **One was found in the feature that fixed BUG-011.** BUG-015 is a CSS
  collision under the new minimise controls: the control itself works, but a
  stylesheet rule of equal specificity, loaded later, silently wins the
  cascade. A feature can pass every functional check — the state changes, the
  attribute is set — and still show the user nothing, which is why this class
  of defect needs a look at the rendered page and not only at the state.

BUG-014 and BUG-015 also share a lesson about what a test can be trusted to
prove. BUG-015's unit tests passed throughout, because jsdom has no competing
stylesheet for the browser's `[hidden]` rule to lose to; only a real browser
showed the defect. BUG-014's rendering cannot be judged by any assertion this
repository can write — whether Arabic letters joined, whether words run the
right way, whether digits inside them do not are three different failures with
identical byte-level symptoms. It is checked instead against a browser, which
shapes with HarfBuzz and orders with ICU, in `qa/tools/compare-rtl.mjs`. Where
the truth is visual, the check has to be too.

The standing lesson for the suite is the second bullet. Every one of the three
data-dependent defects would have been caught on day one by running the existing
cases against the real September file instead of the fixture, and none of them
needed a new case to find.
