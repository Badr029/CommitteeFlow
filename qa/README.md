# QA

## Current scope (2026-09-12)

The register now covers development/exploratory defects and deployed performance
defects. BUG-016 has a user-reported corrected deployed retest but lacks the
after exports required for portfolio-grade closure. BUG-017's fairness correction
is locally verified and awaits deployment/realistic SMTP retesting. The older
UI-only scope and counts below describe the original capture work, not the
current register.

* [QA journey](CommitteeFlow_QA_Journey.md): chronology and lifecycle links.
* [BUG-016 implementation/retest plan](BUG-016-Retest.md): migration, limits,
  evidence requests and remaining deployed checks.
* [BUG-017 fairness/retest plan](BUG-017-Retest.md): confirmed scheduler cause,
  bounded implementation, deployment sequence and pass/fail criteria.
* `QA-Evidence/performance/BUG-016/`: sanitized JTL copies and original hashes.
* `QA-Evidence/performance/BUG-017/`: read-only inventory and hashes for six
  supplied performance runs; it does not claim SMTP completion.
* `QA-Evidence/logs/BUG-016-*`: reported observation, real local reproduction
  and automated verification output. Failed intermediate runs are retained.
* `QA-Evidence/logs/BUG-017-*`: failed pre-fix reproduction, causal analysis and
  local verification. The pre-fix file is preserved unchanged.

Preserve original evidence. The historical capture commands below can overwrite
files; do not use them to replace before evidence. Capture new comparisons under
distinct filenames. Feature delivery should use a separate requirement/acceptance
record; no feature log exists and none is created for this defect.

UI defect reports for CommitteeFlow, with the evidence behind them.

```
qa/
├── CommitteeFlow_Bug_Reports.md    the six reports, as Jira issues
├── CommitteeFlow_Fix_Comments.md   the comment posted on each issue when fixed
├── QA-Evidence/
│   ├── screenshots/                annotated PNGs: URL strip, red box on the defect
│   └── logs/                       the measurements each report quotes
└── tools/                          the capture harness (gitignored install)
```

Each report carries a **Priority** field and a **Description** body of Steps to
Reproduce / Expected Result / Actual Result, so it can be imported as an issue
without being rewritten. A fix note is a comment on an issue rather than part of
its description, so those live in their own file.

Every screenshot carries the route it was taken on across the top. The harness
serves the same built client from an ephemeral port, so the strip names the
canonical development origin — `http://localhost:5173` — with the real path.

## Scope

Black-box, user-visible defects only. Six are in the register:

| ID | Where | Symptom |
|---|---|---|
| BUG-001 | Committee Plan | Column headings and day counts too faint to read |
| BUG-002 | Committee Plan | Column headings scroll away, leaving rows unlabelled |
| BUG-003 | Application shell | Opens light for a user whose system is dark |
| BUG-004 | Book Committee Slot | Required fields announced as optional |
| BUG-005 | Committee Plan | Every screen under 1000px scrolls sideways to read a row |
| BUG-006 | Committee Plan | A phone held sideways shows one row of the month |

Four other defects found in the same period are **not** here, because a tester
working through the interface cannot see them: a Dockerfile copying directories
npm workspaces never create, a migration tool pruned out of the production image,
`/api/health` returning 500 rather than `degraded` when the database was
unreachable, and a typecheck script that hid its own failure. Those are in
`../docs/implementation-status.md`.

All four in the register were found and fixed during development. The current
build does not exhibit them.

## Regenerating the evidence

```bash
npm run build --workspace client

cd qa/tools
npm install
npx playwright install chromium
npm run capture              # BUG-001 to BUG-004, BUG-007 to BUG-012
npm run capture:responsive   # BUG-005 and BUG-006
```

Roughly two minutes, and it overwrites `QA-Evidence/`.

The browser lands in `qa/tools/browsers`, so both commands need
`PLAYWRIGHT_BROWSERS_PATH` pointed at it if it is not already exported:

```bash
PLAYWRIGHT_BROWSERS_PATH="$(pwd)/browsers" npm run capture
```

### The PDF export

`npm run capture` photographs a browser, and the export is a document with no
browser to photograph. Three tools cover it, because a PDF can be wrong in three
different ways that look identical from the outside.

**Is the text encoded at all?** `inspect-pdf-export.mjs` reads the document's
own operators and reports any run that reached the page mis-encoded — the
difference between "my reader shows squares" and "the bytes in the file are
wrong". This is what caught BUG-014.

```bash
# export a month from the running application first
node inspect-pdf-export.mjs plan.pdf
```

**What does it look like?** `render-pdf.mjs` rasterises it with pdf.js, so the
page can be looked at rather than reasoned about.

```bash
node render-pdf.mjs plan.pdf my-prefix --scale=2 --pages=1
```

**Is the Arabic right?** Nobody on this repository can answer that from memory,
so `compare-rtl.mjs` does not ask anyone to. It sets the export's output beside
the same strings rendered by Chromium — HarfBuzz for shaping, ICU for ordering,
loading the same font file — and screenshots both together. Agreement with a
browser is the strongest evidence available without a reader of the language; a
difference is a bug in the export.

```bash
npm run fixture:rtl --workspace server -- /tmp/rtl.pdf   # from the repo root
node compare-rtl.mjs /tmp/rtl.pdf BUG-014-rtl-vs-browser
```

The fixture draws each case twice — once straight through PDFKit, once through
the export's own text layer — so the resulting image is a three-way comparison:
the reference, the defect, and the fix.

### How the reproductions work

Each defect is put back at run time against the **real built client** —
`client/dist`, the shipped stylesheet, the shipped markup:

| ID | What is restored |
|---|---|
| BUG-001 | `--ink-muted` set back to `#6f7a85` on the document element |
| BUG-002 | The shell given `height: auto` again, so the document scrolls instead of the plan body |
| BUG-003 | `index.html` served with the theme bootstrap inline, under the production CSP header |
| BUG-004 | `aria-required` removed from the OFF No. control |
| BUG-005 | `matchMedia` forced to match every `min-width`, so the shipped build picks the desktop table at 375px — which is what it did at every width before this work |
| BUG-006 | The pre-fix chrome heights put back with a stylesheet: two toolbar rows, labelled navigation, full-padding summary strip |

The API is stubbed (`tools/stub-server.mjs`) because all six defects are in
client CSS, markup and layout, and none of them depends on the database. Every
measurement in the reports — contrast ratios, scroll offsets, accessible names,
the CSP console message, the widths and heights — is read from the live page,
not written by hand.

### The capture will not lie for you

Every reproduction asserts its own condition before the screenshot is saved, and
throws if it does not hold. This is not decoration: the first version of this
harness produced a "the headings have scrolled away" image in which the headings
were plainly still on screen, because the stub month fitted the viewport and
nothing had scrolled. A screenshot that contradicts its own caption is worse than
no screenshot, so the assertions came in and the stub month grew to a realistic
sixteen bookings.

## Note on the tooling

`qa/tools` is a standalone package, deliberately outside the npm workspaces, so
Playwright and its browser never reach the application image. Both
`node_modules/` and the downloaded `browsers/` are gitignored; the browser
download is about 700 MB, so it installs to `qa/tools/browsers` rather than the
system drive.
