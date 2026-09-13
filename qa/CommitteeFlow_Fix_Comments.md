# CommitteeFlow — fix comments

One comment per issue, posted when the fix lands. Conventional-commit line, then
3–5 bullets of what changed, then Retest and Regression on their own lines.

**Every Retest line here describes a retest that actually ran.** Where something
was not re-checked, the Regression line says so rather than implying it was.


The reports themselves are in
[`CommitteeFlow_Bug_Reports.md`](CommitteeFlow_Bug_Reports.md).

---

## BUG-001

```
fix: derive muted ink from the contrast requirement instead of by eye

* --ink-muted moved from #6f7a85 to #606c77, set from the 4.5:1 floor against
  --surface-chrome, the lightest ground the 11px labels ever sit on
* The value is computed from the requirement, then confirmed by measuring the
  rendered page, rather than sampled by eye

Retest: column headings 4.11:1 -> 5.05:1, day counts 3.76:1 -> 4.62:1, measured in
the browser at 1360x860 (QA-Evidence/logs/BUG-001-contrast-measurements.json).
Regression: only the light palette's muted ink changed. The dark palette uses a
separate token, measured separately at 4.8:1 to 14.17:1 across headings, cells and
pills, and is untouched by this change.
```

---

## BUG-002

```
fix: give the application shell a fixed height so the plan body scrolls, not the page

* .shell and #root take height: 100dvh instead of min-height, with overflow hidden
* The plan body keeps its own overflow: auto, so the sticky column and day
  headings now have a scrollport that actually moves
* Top bar, month navigator and filters stay fixed at every scroll position

Retest: at 1360x720 scrolled 600px, the column heading row sits at top: 134px and
the document itself no longer scrolls (QA-Evidence/logs/BUG-002-scroll-measurements.json).
Regression: Plan Configuration re-checked by hand after the change — it scrolls
internally with its header fixed. Activity was left unchecked at the time and has
since been exercised at 320, 375, 390, 414, 768 and 1400px during the responsive
work: it scrolls internally with its own header fixed.
```

---

## BUG-003

```
fix: serve the theme bootstrap as a file so the page's own CSP admits it

* Theme bootstrap moved from an inline <script> to /theme-init.js
* Content-Security-Policy left at script-src 'self' — no unsafe-inline, no nonce
* No inline script remains anywhere in the application

Retest: on a dark system with no stored preference the shipped build opens with
data-theme="dark" and body background rgb(16, 20, 24)
(QA-Evidence/logs/BUG-003-console-and-theme.json).
Regression: every other capture in this register runs on a light system and opens
light. The toggle was exercised by hand in both directions. Persistence of a
stored choice across a reload was not re-tested.
```

---

## BUG-004

```
fix: convey requiredness through the control, not only the asterisk

* Field passes aria-required to whatever control it renders, driven by the plan
  field's own isRequired flag
* The asterisk stays aria-hidden and decorative, which is what it is
* Applies to every generated field, so a Plan Configuration change carries through

Retest: covered by client test "marks required fields and labels optional ones" —
OFF No. reports aria-required="true", Qty reports none. Full client suite passes.
Regression: full client suite re-run after the change, covering the booking form,
its validation and the plan table. The Plan Configuration screen has no automated
coverage and was not re-checked.
```

---

## BUG-005

```
fix: give the plan a session agenda below the width its table needs

* Below 1100px the plan renders Date -> Committee Session -> projects as an
  agenda instead of the column table; the table is unchanged above it
* Both layouts read the same query, the same permissions and the same
  Plan Configuration — only the presentation forks
* Quantities, voltages and notes move to the booking's own screen, which is
  the one place they were always fully readable

Retest: at 375px the plan's content width is 375px against a 375px viewport, so
there is no horizontal scrolling (QA-Evidence/logs/BUG-005-horizontal-scroll.json).
Checked by hand at 320, 375, 390, 414, 768 and 1400px, and in landscape.
Regression: at 1280px the column table still renders with its headings — covered
by "keeps the desktop table once there is width for its columns" in the suite.
```

---

## BUG-006

```
fix: let the plan's chrome give up height before the plan does

* The toolbar goes to a single row from 600px wide, which covers a phone in
  landscape as well as a tablet
* Under 460px of height the controls drop from 44px to 38px, the navigation
  drops its labels for 44px icon targets, and the summary strip tightens
* Nothing is removed: month navigation, search, filters, booking and export
  are all still on screen

Retest: at 667x375 the plan's visible height is 196px, up from 102px, with no
horizontal overflow (QA-Evidence/logs/BUG-006-landscape-space.json).
Regression: portrait phones are unaffected — the height rules only apply below
460px — and the desktop toolbar is untouched.
```

---

## BUG-007

```
fix: publish the signed-out session before dropping the rest of the cache

* useLogout called queryClient.clear() first, which removed the cache entry the
  mounted useSession observer was watching and left it attached to nothing
* The setQueryData that followed therefore wrote to an entry no component read,
  so the server session ended while the UI carried on rendering the plan
* Order reversed: publish null onto the session key, then cancel what is in
  flight, then remove every entry except that one
* The session entry is now deliberately kept rather than cleared, because it is
  the thing the whole shell is subscribed to

Retest: signed in, pressed sign out, and the sign-in screen appeared with no
reload — the plan is gone from the DOM and /api/auth/session answers 401
(QA-Evidence/logs/BUG-007-logout-state.json).
Regression: sign-in re-checked in the same pass, since it reads the same cache
entry from the other side. The month, filters and open-booking parameters in the
URL are untouched by logout and were not expected to change; they were not
re-checked.
```

---

## BUG-008

```
fix: read the credentials from the form on submit, not from React state

* The submit handler now takes email and password from a FormData of the form
  element, which always holds what the fields actually contain
* The disabled rule on Sign in is gone: emptiness is answered on submit, with a
  message naming the field that is missing, instead of by a control that cannot
  explain itself
* A password manager writes straight to the DOM value without firing React's
  synthetic change, so nothing derived from state can be trusted to know whether
  the form is filled

Retest: autofilled both fields without touching either, and Sign in was enabled
and submitted (QA-Evidence/logs/BUG-008-autofill-state.json). Typed entry and the
empty-form message were both re-checked by hand.
Regression: the two fields stay controlled for the typed path and for the reveal
toggle, so nothing else on the form changed. Server-side validation is unchanged
and still answers the same way.
```

---

## BUG-009

```
feat: let the password be revealed while it is being typed

* A toggle inside the password field switches the input between password and
  text, without clearing it
* It carries aria-pressed rather than a label that changes meaning, so a screen
  reader hears the state instead of inferring it from the icon
* The target is 34px on a desktop and 42px on a phone, where it is a thumb

Retest: typed a passphrase, revealed it, re-hid it, and submitted — the value
survives both toggles (QA-Evidence/logs/BUG-009-password-field.json).
Regression: autocomplete="current-password" is unchanged, and the browser still
offers to save and fill the field with the toggle present.
```

---

## BUG-010

```
feat: acknowledge a successful sign-in, and say what the account may do

* A toast on success names the account, and states in one line whether it can
  book and change slots or has read-only access
* Chosen over a banner because it is an outcome, not a state: it belongs with
  the booking, import and export confirmations already in the product

Retest: signed in as a Project Engineer and read the confirmation on screen
(QA-Evidence/logs/BUG-010-sign-in-feedback.json).
Regression: the Viewer wording is taken from the same session response and is
covered by the client tests, but was not exercised in a browser in this pass.
```

---

## BUG-011

```
feat: give a day its own box, and let days and sessions be minimised

* Each day is now a bounded panel with an accent heading; sessions are bands
  inside it and projects are hairline rows, so the three levels read at three
  weights instead of two
* Both a day and a session carry a disclosure control, and collapsing is held as
  view state rather than in the URL — which days someone folded while reading is
  not something they would send to a colleague
* A collapsed day is hidden, not unmounted, so reopening it restores exactly the
  sessions that were left folded
* The toolbar gains a day filter that narrows the month to one date. It lists
  only days that have bookings, and it lives in the URL beside the month, so a
  single day can be sent to someone
* Column headings stay stated once at the top rather than repeating inside every
  day box: the columns are identical for all of them, so repeating cost a row of
  height per day and told the reader nothing

Retest: read September 2026 at 1360x860 — day boxes, disclosure controls on both
levels and the day filter all present and working
(QA-Evidence/logs/BUG-011-grouping-weights.json). Seven client tests cover the
filter, the two collapse levels and the fold-memory across a reopened day.
Regression: the agenda used on phones and tablets is a separate component and is
unchanged. The desktop plan's own tests — grouping, dynamic columns, role gating,
month navigation, filters, empty and error states — were re-run and pass.
```

---

## BUG-012

```
fix: store KV as text, because a voltage ratio is not a number

* bookings.kv moves from numeric(10, 3) to text, with the non-negative check
  replaced by a length ceiling, and the KV plan field becomes TEXT with it
* Existing values pass through trim_scale first, so a stored 11.000 arrives as
  "11" rather than as a precision nobody entered
* COLUMN_FIELD_KINDS.kv follows, which is what lets the importer's type check
  accept the column and what makes KV configurable as a Select list later
* The down migration is lossy by nature and says so: a ratio cannot survive the
  trip back to a number, so it is set to null rather than failing the migration
* KVA and Qty stay numeric. Those really are quantities, and the plan totals them

Retest: previewed the real September workbook — KV auto-maps to KV and the
ratios import intact (QA-Evidence/logs/BUG-012-kv-mapping.json). The migration
ran against the development database and converted eight rows of 11, two of 132,
two of 0.4 and one of 33 with no change in what they read as.
Regression: the Excel export keeps numbers as numbers for Qty and KVA and now
writes KV as text, which is correct — totalling a ratio was never meaningful. The
importer's type veto is still exercised, on Qty, where a column of ranges is
genuinely not a number.
```

---

## BUG-013

```
feat: print the Committee Plan as the controlled form it replaces

* The PDF now carries the form's own furniture: the document code and revision
  strip, a yellow title band naming the month, and a green column-heading row
* Every cell is ruled, and the day and date are merged down the rows they cover,
  as are the time and committee across one committee sitting — so a session with
  four projects reads as one block rather than four unrelated lines
* The weekday is printed beside the date, derived from it rather than stored
* Every day of the month appears, booked or not: a free committee day is a fact
  about the month, and printing only the booked days turned "nothing on the 12th"
  into "no 12th"
* The colours are the source form's own, sampled from it rather than chosen —
  which is why they are flat primaries rather than the palette used on screen
* Column order, labels and visibility still come from Plan Configuration. There
  is no second column list in the export

Retest: exported September 2026 and read it beside the issued form — title band,
code strip, heading row, merged day cells, ruled grid and all thirty days
present. Five integration tests now assert the form's title, code, revision,
colours, the empty days and the weekday, and that a renamed field follows through.
Regression: the Excel export is untouched and its tests pass. An empty month and
a month whose rows span three pages were both exported; the heading block repeats
per page and no row is split across a break.
```

---

---

## BUG-014

```
fix: embed a Unicode font and order bilingual text with the bidi algorithm

* The export drew with Helvetica, one of PDF's fourteen standard fonts, which
  are Latin-1 and contain no Arabic glyph at all — measured, Helvetica sets
  widthOfString('وطنية') to 0. Cairo (SIL OFL 1.1) is now embedded from
  server/assets/fonts and covers Latin, Arabic, digits and punctuation in one
  file, so a cell holding محول 1500 KVA needs no font switch mid-line
* New server/src/modules/export/pdf-text.ts owns direction: the export service
  calls renderPdfText/measurePdfText and knows nothing about scripts. Values
  reach it exactly as they came from the database — nothing upstream reverses
  or reshapes a string, which would make the algorithm's job impossible
* Ordering is bidi-js, an implementation of UAX #9, not a hand-rolled reversal.
  It reorders *runs* and never the characters inside one, so fontkit still sees
  Arabic written the way Arabic is written and picks the right contextual forms.
  Brackets are mirrored through the algorithm's own map
* Two ordering faults sat behind the encoding one. fontkit reverses an entire
  run for an RTL script, which turned the OFF number in `وطنية 202601066` into
  660106202. And PDFKit's own layout() splits a string on spaces, shapes each
  word separately and re-concatenates them in source order — invisible in Latin,
  but it silently undid the reordering of every multi-word Arabic name. Passing
  a features array takes PDFKit's other branch, which lays the whole string out
  in one pass; the widths are identical either way
* Free-text columns now follow their own direction, so an Arabic committee name
  sits against the right edge of its cell as it does on the sheet this form
  replaces. Numeric and label columns keep their fixed alignment
* Dockerfile copies server/assets into the runtime image and fails the build if
  the fonts are missing — the base image has no Arabic font, so an absent asset
  would not break the build, it would ship a silently broken export

Retest: traced the value through PostgreSQL, the API, the export service and the
generated PDF before changing anything (QA-Evidence/logs/BUG-014-trace.md) —
correct at every stage but the last, so this was fixed as a rendering defect and
no stored data was touched. Twenty unit tests pin the run ordering for pure
Arabic, multi-word Arabic, Arabic+Latin, Arabic+OFF number, Arabic+rating,
brackets, voltage ratios and English-only. Five integration tests take the same
values through the real export endpoint and read the finished document back with
a PDF reader. The generated page was then rendered and compared against the same
strings set by Chromium — HarfBuzz shaping, ICU bidi, the same font file — and
matches on every case (QA-Evidence/screenshots/BUG-014-rtl-vs-browser.png).
Regression: English-only exports are unchanged and asserted so; Latin runs come
back from a reader verbatim and in one piece. The Excel export does not go
through this path and is untouched. Its widths are identical before and after,
so the table's column geometry does not move. The built server (dist, not
sources) was run directly to confirm the font resolves from the compiled module
and is embedded as a subset.
```

---

## BUG-015

```
fix: make the hidden attribute mean hidden, in the reset rather than per component

* The click handler, the collapsed-set state and the hidden attribute were all
  correct — confirmed on the DOM node after clicking. This was a cascade bug
* .dayBody and .sessionBody declare display: flex, which carries the same
  specificity as the browser's own [hidden] { display: none }. Author CSS loaded
  after a UA rule of equal weight wins, so the attribute silently stopped working
* Fixed once in client/src/styles/base.css with [hidden] { display: none
  !important } rather than twice at the call sites: any component that sets a
  display value on an element it also toggles hidden on would hit this, and the
  next one would not think to look

Retest: in a real browser, minimising a day collapses it to its heading and
minimising a session folds it inside a day that stays open — both bodies compute
to display: none and take zero height
(QA-Evidence/screenshots/BUG-015-fixed-for-comparison.png).
Regression: the existing client tests passed throughout this defect and still
do, which is the point worth carrying — jsdom has no competing stylesheet, so it
could not have caught this. The guard is in the browser harness instead. Nothing
else in the application currently sets a display value on an element it also
hides, so the reset changes no other component's rendering.
```

---

## BUG-016 — evidence status correction

The corrected deployed lifecycle (three events and 33 durable child batches) is
reported as having completed without the old duplicate pattern. This checkout
does not contain the after database, Mailpit or worker exports, deployed build ID
or exact elapsed timestamps. Keep the issue evidence-controlled rather than
marking it portfolio-verified from this repository alone.

---

## BUG-017 — refined correction; deployed functional retest passed

```
fix: drain independent outbox parents with bounded child concurrency

* Two bounded parent lanes allow independent booking scopes to progress.
* Each parent drains durable child batches in waves of three while retaining its
  lease; default total SMTP concurrency is bounded at six per invocation.
* A lower-ID unfinished event blocks later events for the same booking; NULL
  booking events use one conservative plan-wide ordering scope.
* Existing leases, persistent child batches, retry counters, stable Message-IDs,
  partial-acceptance handling and acknowledgement fencing are preserved.
* Supabase pg_net wakes the authenticated worker asynchronously after enqueue;
  the existing 30-second Cron remains the fallback.

Local retest: the pre-fix test failed with independent B after A's final batch.
After the refined change, the complete suites passed 338 server tests and 86
client tests with four pre-existing skips.

Deployed retest (product-owner review, 2026-09-13): nine of nine parents `SENT`,
99 expected children complete, no duplicate observed, and same-booking lifecycle
order retained. Functional result: PASS. Exact timings and raw after exports are
not present in this checkout and remain excluded from verified portfolio numbers.
```

---

## BUG-018 to BUG-026 — authentication and plan refinements

```
fix: harden sign-in, account security and plan defaults

* Replaced the protected-plan startup skeleton with a sign-in-shaped skeleton.
* Preserved the requested pathname and query string through login.
* Suppressed the browser-native search cancellation control so only one clear action remains.
* Required script-created accounts to replace the temporary password before app access.
* Removed Current password from first-login replacement only; normal Change password still verifies it.
* Added reveal controls for replacement fields and retained Cancel as the normal dialog's only close action.
* Added Change password to the account menu while leaving the dark-mode switch outside that menu.
* Rejected past booking dates/times against Africa/Cairo on client and server.
* Hid elapsed days by default only in the current month; Show past days restores them.
* Made cancelled bookings visible by default; Hide cancelled reverses the filter.
* Paginated Who can configure the plan and Configuration history independently.
* Added optional Keep me signed in: session-only when clear, rolling 30 days when selected.
* Preserved the persistence choice through first-login password replacement and session-ID rotation.

Local evidence: typecheck, lint and build pass; 29 targeted client tests and 108
server unit tests pass (three skipped). Server
integration execution is pending because Docker/PostgreSQL was unavailable in
the continuation session. Same-browser mobile, browser-restart and email-link
deployment checks remain pending.
```
