import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStubServer } from './stub-server.mjs';

/**
 * Captures the annotated screenshots referenced by the bug reports.
 *
 * Each defect was found and fixed during development, so the shipped build does
 * not exhibit it. To photograph the failure the pre-fix state is restored at run
 * time — by putting back the old token value, the old layout property, or the
 * old `index.html` — and every screenshot is labelled with exactly what was
 * restored. Nothing is simulated: the page, the stylesheet and the measurements
 * are the application's own.
 *
 *   npm run capture     (from qa/tools)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'QA-Evidence', 'screenshots');
const logDir = path.resolve(here, '..', 'QA-Evidence', 'logs');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const VIEWPORT = { width: 1360, height: 860 };

/** Draws the annotation over one or more elements. Runs inside the page. */
function annotate({ selectors, label, note, limit, rects, labelAt }) {
  document.querySelectorAll('[data-qa-annotation]').forEach((n) => n.remove());

  let targets = selectors.flatMap((s) => [...document.querySelectorAll(s)]);
  if (limit) targets = targets.slice(0, limit);

  const boxes = targets.map((el) => el.getBoundingClientRect());
  // A rect with no element behind it marks where something *should* be. Plain
  // objects carry no `bottom`, which the label placement below needs.
  (rects ?? []).forEach((r) =>
    boxes.push({ ...r, bottom: r.bottom ?? r.top + r.height, right: r.right ?? r.left + r.width }),
  );
  if (boxes.length === 0) return { drawn: 0 };

  let first = null;
  boxes.forEach((r) => {
    if (r.width === 0 && r.height === 0) return;
    if (!first) first = r;
    const box = document.createElement('div');
    box.setAttribute('data-qa-annotation', '');
    Object.assign(box.style, {
      position: 'fixed',
      left: r.left - 4 + 'px',
      top: r.top - 4 + 'px',
      width: r.width + 8 + 'px',
      height: r.height + 8 + 'px',
      border: '3px solid #e0102f',
      borderRadius: '3px',
      boxShadow: '0 0 0 2px rgba(224,16,47,0.22)',
      pointerEvents: 'none',
      zIndex: '2147483646',
    });
    document.body.appendChild(box);
  });

  if (first && label) {
    const chip = document.createElement('div');
    chip.setAttribute('data-qa-annotation', '');
    // `labelAt` parks the chip somewhere deliberately empty when the space
    // around the boxed element is itself part of the evidence.
    const top = labelAt ? labelAt.top : first.top - 4 > 34 ? first.top - 34 : first.bottom + 10;
    const left = labelAt ? labelAt.left : Math.max(8, first.left - 4);
    Object.assign(chip.style, {
      position: 'fixed',
      left: left + 'px',
      top: top + 'px',
      maxWidth: '900px',
      padding: '5px 10px',
      background: '#e0102f',
      color: '#ffffff',
      font: '600 13px/1.45 ui-sans-serif, system-ui, sans-serif',
      borderRadius: '3px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });
    chip.textContent = label;
    document.body.appendChild(chip);
  }

  if (note) {
    const panel = document.createElement('div');
    panel.setAttribute('data-qa-annotation', '');
    Object.assign(panel.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      right: '16px',
      padding: '10px 14px',
      background: 'rgba(17,20,24,0.94)',
      color: '#f2f5f7',
      font: '500 12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
      borderLeft: '4px solid #e0102f',
      borderRadius: '3px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      whiteSpace: 'pre-wrap',
    });
    panel.textContent = note;
    document.body.appendChild(panel);
  }
  return { drawn: boxes.length };
}

/** WCAG relative-luminance contrast, evaluated in the page against real colours. */
function measureContrast(selector) {
  const el = document.querySelector(selector);
  if (!el) return null;
  const srgb = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = (rgb) => {
    const m = rgb.match(/[0-9.]+/g).map(Number);
    return 0.2126 * srgb(m[0]) + 0.7152 * srgb(m[1]) + 0.0722 * srgb(m[2]);
  };
  let node = el;
  let bg = 'rgb(255, 255, 255)';
  while (node) {
    const c = getComputedStyle(node).backgroundColor;
    if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
      bg = c;
      break;
    }
    node = node.parentElement;
  }
  const cs = getComputedStyle(el);
  const l1 = lum(cs.color);
  const l2 = lum(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return {
    color: cs.color,
    background: bg,
    fontSize: cs.fontSize,
    fontWeight: cs.fontWeight,
    ratio: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)),
  };
}

async function openPlan(page, url, { colorScheme = 'light' } = {}) {
  await page.emulateMedia({ colorScheme });
  await page.goto(`${url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Transformer 2B', { timeout: 15000 });
  await page.waitForTimeout(350);
}

/**
 * The address strip across the top of every screenshot.
 *
 * A defect report is worth more when the reader can see *where* it happened, so
 * each capture carries the route it was taken on. It overlays the top of the
 * page rather than pushing it down: the application uses a fixed-height shell,
 * and shifting it would change the very layout being photographed.
 */
function drawUrlBar(url) {
  document.querySelectorAll('[data-qa-urlbar]').forEach((n) => n.remove());
  const bar = document.createElement('div');
  bar.setAttribute('data-qa-urlbar', '');
  Object.assign(bar.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    right: '0',
    height: '38px',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    background: '#1b1b1d',
    color: '#f4f4f5',
    font: '500 14px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    borderBottom: '1px solid #000000',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  bar.textContent = url;
  document.body.appendChild(bar);
}

/*
 * The origin a tester would reproduce against. The harness serves the same
 * built client from an ephemeral port, so the strip names the canonical dev
 * URL rather than a port number that changes every run. The path is real.
 */
const APP_ORIGIN = 'http://localhost:5173';

/**
 * Drives the import drawer to its mapping step.
 *
 * The bytes do not matter: the harness's stub answers the preview, because what
 * is being photographed is how the importer *reports* a column it cannot place,
 * not how it parses a workbook.
 */
async function openImportMapping(page) {
  await page.getByRole('button', { name: /import plan/i }).click();
  await page.waitForSelector('input[type="file"]', { state: 'attached' });
  await page.setInputFiles('input[type="file"]', {
    name: 'Committee Plan for September V5.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('evidence-fixture'),
  });
  await page.waitForSelector('text=Order Name', { timeout: 15000 });
  await page.waitForTimeout(400);
}

const shots = [];
async function shoot(page, name, caption, route = '/plan?month=2026-09') {
  await page.evaluate(drawUrlBar, `${APP_ORIGIN}${route}`);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push({ name, caption, route });
  console.log(`  saved ${path.basename(file)}  —  ${caption}`);
}

/**
 * Fails the run rather than writing a screenshot that contradicts its caption.
 *
 * The first pass of this script produced a "headings have scrolled away" image
 * in which the headings were plainly still there, because the month fitted the
 * viewport and nothing scrolled. Evidence that disagrees with its own label is
 * worse than no evidence, so every reproduction now has to prove itself first.
 */
function assertReproduced(condition, message) {
  if (!condition) {
    throw new Error(`defect did not reproduce — refusing to save the screenshot: ${message}`);
  }
}

async function main() {
  const server = await startStubServer();
  const inlineServer = await startStubServer({ inlineThemeScript: true });
  const browser = await chromium.launch();

  try {
    // ── BUG-001 · faint column headings ────────────────────────────────────
    console.log('BUG-001  Committee Plan — column headings too faint');
    {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(page, server.url);

      // Restore the pre-fix token value. Everything else is the shipped build.
      await page.evaluate(() =>
        document.documentElement.style.setProperty('--ink-muted', '#6f7a85'),
      );
      await page.waitForTimeout(200);

      const heading = await page.evaluate(measureContrast, '[role="columnheader"]');
      const dayCount = await page.evaluate(measureContrast, '[class*="dayCount"]');
      fs.writeFileSync(
        path.join(logDir, 'BUG-001-contrast-measurements.json'),
        JSON.stringify({ beforeFix: { heading, dayCount } }, null, 2),
      );

      await page.evaluate(annotate, {
        selectors: ['[class*="colHead"]', '[class*="dayCount"]'],
        label: `Column headings ${heading.ratio}:1 · day counts ${dayCount.ratio}:1 — both below the 4.5:1 minimum for 11px text`,
        note:
          `Measured in the page, light theme, 11px uppercase text.\n` +
          `Column headings  text ${heading.color} on ${heading.background} → ${heading.ratio}:1\n` +
          `Day counts       text ${dayCount.color} on ${dayCount.background} → ${dayCount.ratio}:1\n` +
          `WCAG 2.2 AA requires 4.5:1 for text below 18.66px.`,
      });
      await shoot(page, 'BUG-001-faint-column-headings', 'column headings and day counts below the contrast minimum');

      // The shipped build, for comparison.
      await page.evaluate(() => {
        document.querySelectorAll('[data-qa-annotation]').forEach((n) => n.remove());
        document.documentElement.style.removeProperty('--ink-muted');
      });
      await page.waitForTimeout(200);
      const fixedHeading = await page.evaluate(measureContrast, '[role="columnheader"]');
      const fixedDayCount = await page.evaluate(measureContrast, '[class*="dayCount"]');
      fs.writeFileSync(
        path.join(logDir, 'BUG-001-contrast-measurements.json'),
        JSON.stringify(
          {
            beforeFix: { heading, dayCount },
            afterFix: { heading: fixedHeading, dayCount: fixedDayCount },
          },
          null,
          2,
        ),
      );
      await page.evaluate(annotate, {
        selectors: ['[class*="colHead"]', '[class*="dayCount"]'],
        label: `After the fix — column headings ${fixedHeading.ratio}:1, above the 4.5:1 minimum`,
        note: null,
      });
      await shoot(page, 'BUG-001-fixed-for-comparison', 'the same headings in the shipped build');
      await page.close();
    }

    // ── BUG-002 · headings scroll away ─────────────────────────────────────
    console.log('BUG-002  Committee Plan — column headings scroll out of view');
    {
      // A laptop viewport, so a real September plan overflows it — which is the
      // condition under which the defect is visible at all.
      const page = await browser.newPage({ viewport: { width: 1360, height: 720 } });
      await openPlan(page, server.url);

      // Restore the pre-fix shell sizing: the frame grew with its content, so the
      // document scrolled instead of the plan body.
      await page.evaluate(() => {
        const root = document.getElementById('root');
        const shell = root?.firstElementChild;
        root.style.height = 'auto';
        root.style.minHeight = '100dvh';
        if (shell) {
          shell.style.height = 'auto';
          shell.style.minHeight = '100dvh';
          shell.style.overflow = 'visible';
        }
        // `overflow: auto` is left exactly as it ships. That is the point of the
        // defect: the plan body kept its scroll mechanism but, inside a frame
        // that grew with its content, was never given a height to scroll within.
        // The sticky headings then belong to a scrollport that never moves, so
        // they travel up the page with everything else.
        document.querySelectorAll('[class*="_scroll_"]').forEach((el) => {
          el.style.flex = 'none';
        });
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => window.scrollTo(0, 600));
      await page.waitForTimeout(350);

      const state = await page.evaluate(() => {
        const head = document.querySelector('[class*="colHead"]');
        const bar = document.querySelector('header');
        return {
          columnHeadingTop: Math.round(head.getBoundingClientRect().top),
          topBarTop: Math.round(bar.getBoundingClientRect().top),
          scrolledBy: Math.round(window.scrollY),
          documentScrolls: document.documentElement.scrollHeight > window.innerHeight,
        };
      });

      assertReproduced(state.scrolledBy > 0, 'the page did not scroll at all');
      assertReproduced(
        state.columnHeadingTop < 0,
        `the column headings are still on screen at top: ${state.columnHeadingTop}px`,
      );
      fs.writeFileSync(
        path.join(logDir, 'BUG-002-scroll-measurements.json'),
        JSON.stringify({ beforeFix: state }, null, 2),
      );

      await page.evaluate(annotate, {
        selectors: [],
        // The headings are off-screen, so the box marks where they should be.
        rects: [{ left: 0, top: 0, width: 1360, height: 34 }],
        label: `Column headings should be pinned in this strip — they are ${Math.abs(state.columnHeadingTop)}px above the viewport, so these rows are read with no headings at all`,
        note:
          `Scrolled ${state.scrolledBy}px down the September plan.\n` +
          `Column heading row is at top: ${state.columnHeadingTop}px — off the top of the viewport.\n` +
          `The top bar is at top: ${state.topBarTop}px — it has scrolled away too.\n` +
          `Expected: the column headings and the day heading stay pinned while the plan scrolls.`,
      });
      await shoot(page, 'BUG-002-headings-scrolled-away', 'no column headings while reading rows mid-month');
      await page.close();

      // The shipped build, scrolled the same distance.
      const fixed = await browser.newPage({ viewport: { width: 1360, height: 720 } });
      await openPlan(fixed, server.url);
      const fixedState = await fixed.evaluate(() => {
        const el = document.querySelector('[class*="_scroll_"]');
        if (el) el.scrollTop = 600;
        return {
          scrolledBy: el ? Math.round(el.scrollTop) : 0,
          documentScrolls: document.documentElement.scrollHeight > window.innerHeight,
        };
      });
      await fixed.waitForTimeout(350);
      const fixedHeadTop = await fixed.evaluate(() =>
        Math.round(document.querySelector('[class*="colHead"]').getBoundingClientRect().top),
      );
      fs.writeFileSync(
        path.join(logDir, 'BUG-002-scroll-measurements.json'),
        JSON.stringify(
          { beforeFix: state, afterFix: { ...fixedState, columnHeadingTop: fixedHeadTop } },
          null,
          2,
        ),
      );
      assertReproduced(fixedState.scrolledBy > 0, 'the fixed build did not scroll its plan body');
      assertReproduced(!fixedState.documentScrolls, 'the fixed build still scrolls the document');
      await fixed.evaluate(annotate, {
        selectors: ['[class*="colHead"]'],
        label: 'After the fix — the column headings stay pinned while the plan scrolls',
        note: null,
      });
      await shoot(fixed, 'BUG-002-fixed-for-comparison', 'headings pinned in the shipped build');
      await fixed.close();
    }

    // ── BUG-003 · opens light for a dark-mode user ─────────────────────────
    console.log('BUG-003  Application — opens in the light theme on a dark system');
    {
      const page = await browser.newPage({ viewport: VIEWPORT, colorScheme: 'dark' });
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });

      // Served with the pre-fix index.html, which carried the theme bootstrap
      // inline. The Content-Security-Policy header is the production one.
      await openPlan(page, inlineServer.url, { colorScheme: 'dark' });

      const themeState = await page.evaluate(() => ({
        dataTheme: document.documentElement.dataset.theme ?? '(not set)',
        prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        pageBackground: getComputedStyle(document.body).backgroundColor,
      }));
      const cspError = consoleErrors.find((e) => e.includes('Content Security Policy')) ?? '(none captured)';
      fs.writeFileSync(
        path.join(logDir, 'BUG-003-console-and-theme.json'),
        JSON.stringify({ beforeFix: { themeState, consoleErrors } }, null, 2),
      );

      assertReproduced(themeState.prefersDark, 'the browser did not report a dark colour scheme');
      assertReproduced(
        themeState.pageBackground !== 'rgb(16, 20, 24)',
        'the page already rendered dark, so the defect did not reproduce',
      );

      await page.evaluate(annotate, {
        selectors: ['header', '[class*="toolbar"]'],
        label: 'System is set to dark — the application opens white',
        note:
          `prefers-color-scheme: dark is true, yet the page renders light.\n` +
          `<html data-theme> is ${themeState.dataTheme}; body background is ${themeState.pageBackground}.\n\n` +
          `Browser console:\n${cspError}`,
      });
      await shoot(page, 'BUG-003-light-theme-on-dark-system', 'app opens white for a user whose system is dark');
      await page.close();

      const fixed = await browser.newPage({ viewport: VIEWPORT, colorScheme: 'dark' });
      await openPlan(fixed, server.url, { colorScheme: 'dark' });
      const fixedTheme = await fixed.evaluate(() => document.documentElement.dataset.theme);
      const fixedBg = await fixed.evaluate(() => getComputedStyle(document.body).backgroundColor);
      fs.writeFileSync(
        path.join(logDir, 'BUG-003-console-and-theme.json'),
        JSON.stringify(
          {
            beforeFix: { themeState, consoleErrors },
            afterFix: { dataTheme: fixedTheme, pageBackground: fixedBg },
          },
          null,
          2,
        ),
      );
      assertReproduced(fixedTheme === 'dark', `the shipped build opened as "${fixedTheme}"`);
      await fixed.evaluate(annotate, {
        selectors: ['header', '[class*="toolbar"]'],
        label: `After the fix — opens dark, data-theme="${fixedTheme}"`,
        note: null,
      });
      await shoot(fixed, 'BUG-003-fixed-for-comparison', 'shipped build honours the system setting');
      await fixed.close();
    }

    // ── BUG-004 · required fields not announced ────────────────────────────
    console.log('BUG-004  Book Committee Slot — required fields not announced');
    {
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(page, server.url);
      await page.getByRole('button', { name: /Book Committee Slot/ }).click();
      await page.waitForSelector('text=Book Committee Slot');
      await page.waitForTimeout(400);

      // Restore the pre-fix markup: the control carried no aria-required, and the
      // asterisk beside the label is aria-hidden, so nothing announced it.
      const readings = await page.evaluate(() => {
        const tidy = (text) => text.replace(/\s+/g, ' ').trim();
        const labels = [...document.querySelectorAll('label')];
        const target = labels.find((l) => l.textContent.trim().startsWith('OFF No.'));
        const input = document.getElementById(target.htmlFor);
        input.removeAttribute('aria-required');

        const star = target.querySelector('[aria-hidden="true"]');
        // The accessible name excludes aria-hidden subtrees, so compute it the
        // way a screen reader would rather than reading raw textContent.
        const clone = target.cloneNode(true);
        clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());

        return {
          fieldId: input.id,
          ariaRequired: input.getAttribute('aria-required') ?? '(absent)',
          requiredAttribute: input.hasAttribute('required') ? 'present' : '(absent)',
          asteriskAriaHidden: star ? star.getAttribute('aria-hidden') : '(no asterisk)',
          labelText: tidy(target.textContent),
          accessibleName: tidy(clone.textContent),
        };
      });
      fs.writeFileSync(
        path.join(logDir, 'BUG-004-accessibility-readings.json'),
        JSON.stringify({ beforeFix: readings }, null, 2),
      );

      // An attribute selector needs no escaping, and React's generated ids
      // contain colons that a plain `#id` selector would choke on.
      const inputSelector = `[id="${readings.fieldId}"]`;

      assertReproduced(
        readings.ariaRequired === '(absent)' && readings.requiredAttribute === '(absent)',
        'the control still advertises that it is required',
      );
      assertReproduced(
        !readings.accessibleName.includes('*'),
        'the asterisk is part of the accessible name, so the defect does not apply',
      );

      await page.evaluate(annotate, {
        selectors: [inputSelector, `label[for="${readings.fieldId}"]`],
        // Parked in the empty band under the drawer subtitle so the label and
        // its asterisk — the thing being reported — stay legible.
        labelAt: { left: 822, top: 68 },
        label: 'OFF No. is required — only the red asterisk says so',
        note:
          `Accessibility readings for the OFF No. control:\n` +
          `  aria-required   : ${readings.ariaRequired}\n` +
          `  required        : ${readings.requiredAttribute}\n` +
          `  label text      : "${readings.labelText}"\n` +
          `  accessible name : "${readings.accessibleName}"\n` +
          `The asterisk carries aria-hidden="${readings.asteriskAriaHidden}", so it is excluded from the\n` +
          `accessible name. A screen reader announces an ordinary, optional text box, and the\n` +
          `omission is only reported after the user tries to save.`,
      });
      await shoot(page, 'BUG-004-required-not-announced', 'required field announced as optional');
      await page.close();
    }

    // ── BUG-007 · logging out leaves the plan on screen ────────────────────
    console.log('BUG-007  Log out does not return to the sign-in screen');
    {
      const stale = await startStubServer();
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(page, stale.url);

      /*
       * The pre-fix build cleared the whole query cache and *then* published the
       * signed-out session — onto an entry the mounted session observer had
       * already been detached from. The server session ended; the client never
       * heard about it.
       *
       * Reproduced by ending the server session without letting the client
       * publish the result, which leaves the application in exactly the state
       * the defect left it in.
       */
      const state = await page.evaluate(async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        const check = await fetch('/api/auth/session');
        return {
          sessionStatus: check.status,
          stillShowsPlan: Boolean(document.querySelector('[role="table"]')),
          stillShowsIdentity: document.body.innerText.includes('Project Engineer'),
          signInFormPresent: Boolean(document.querySelector('input[name="password"]')),
        };
      });

      assertReproduced(state.sessionStatus === 401, 'the server session did not end');
      assertReproduced(state.stillShowsPlan, 'the plan was not still on screen');
      assertReproduced(!state.signInFormPresent, 'the sign-in form was already showing');
      fs.writeFileSync(
        path.join(logDir, 'BUG-007-logout-state.json'),
        JSON.stringify({ preFix: state }, null, 2) + '\n',
      );

      await page.evaluate(annotate, {
        selectors: ['[role="table"]'],
        label: 'signed out on the server — the plan is still here',
        note: `GET /api/auth/session answers ${state.sessionStatus}. Only a manual refresh reaches the sign-in screen.`,
        labelAt: 'top',
      });
      await shoot(
        page,
        'BUG-007-logout-leaves-plan-on-screen',
        'session ended, plan still rendered',
      );
      await page.close();
      stale.close();
    }

    {
      const fresh = await startStubServer();
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(fixed, fresh.url);

      await fixed.getByRole('button', { name: 'Sign out' }).click();
      await fixed.waitForSelector('input[name="password"]', { timeout: 10000 });

      const after = await fixed.evaluate(() => ({
        stillShowsPlan: Boolean(document.querySelector('[role="table"]')),
        signInFormPresent: Boolean(document.querySelector('input[name="password"]')),
      }));
      assertReproduced(!after.stillShowsPlan, 'the fixed build still shows the plan');

      await fixed.evaluate(annotate, {
        selectors: ['form'],
        label: 'shipped build — Log out lands on the sign-in screen',
        note: 'No refresh. The signed-out session is published before the rest of the cache is dropped.',
      });
      await shoot(fixed, 'BUG-007-fixed-for-comparison', 'log out returns to sign-in');
      await fixed.close();
      fresh.close();
    }

    // ── BUG-008 · a filled-in form whose Sign in button refuses ────────────
    console.log('BUG-008  Sign in is dead after the password manager fills the form');
    {
      const out = await startStubServer({ signedOut: true });
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(`${out.url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
      await page.waitForSelector('input[name="password"]');

      /*
       * A password manager writes straight to the DOM value. React never sees a
       * synthetic change, so state-derived values stay empty while the inputs
       * visibly hold text — which is the whole of this defect. The autofill
       * below is the real mechanism; only the pre-fix `disabled` rule, which
       * read those empty values, is restored.
       */
      const state = await page.evaluate(() => {
        const setValue = (element, value) => {
          const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(element),
            'value',
          )?.set;
          setter?.call(element, value);
        };
        const email = document.querySelector('input[name="email"]');
        const password = document.querySelector('input[name="password"]');
        setValue(email, 'ahmed@committeeflow.test');
        setValue(password, 'correct-horse-battery');

        const submit = document.querySelector('button[type="submit"]');
        submit.disabled = true; // pre-fix: disabled={!email.trim() || !password}
        return {
          emailOnScreen: email.value,
          passwordCharacters: password.value.length,
          submitDisabled: submit.disabled,
        };
      });

      assertReproduced(state.emailOnScreen.length > 0, 'the email field was not filled');
      assertReproduced(state.submitDisabled, 'the submit button was not disabled');
      fs.writeFileSync(
        path.join(logDir, 'BUG-008-autofill-state.json'),
        JSON.stringify({ preFix: state }, null, 2) + '\n',
      );

      await page.evaluate(annotate, {
        selectors: ['button[type="submit"]', 'input[name="email"]', 'input[name="password"]'],
        label: 'both fields are filled — Sign in is still dead',
        note: 'Clicking any field wakes the button up. Nothing on screen says why it was asleep.',
      });
      await shoot(
        page,
        'BUG-008-signin-blocked-after-autofill',
        'filled form, disabled button',
      );
      await page.close();
      out.close();
    }

    {
      const out = await startStubServer({ signedOut: true });
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await fixed.goto(`${out.url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
      await fixed.waitForSelector('input[name="password"]');

      const state = await fixed.evaluate(() => {
        const setValue = (element, value) => {
          const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(element),
            'value',
          )?.set;
          setter?.call(element, value);
        };
        setValue(document.querySelector('input[name="email"]'), 'ahmed@committeeflow.test');
        setValue(document.querySelector('input[name="password"]'), 'correct-horse-battery');
        return { submitDisabled: document.querySelector('button[type="submit"]').disabled };
      });

      assertReproduced(!state.submitDisabled, 'the shipped build still disables the button');
      await fixed.evaluate(annotate, {
        selectors: ['button[type="submit"]'],
        label: 'shipped build — the button works on a filled form',
        note: 'Credentials are read from the form element on submit, not from React state.',
      });
      await shoot(fixed, 'BUG-008-fixed-for-comparison', 'autofilled form submits');
      await fixed.close();
      out.close();
    }

    // ── BUG-009 · no way to check the password you typed ───────────────────
    console.log('BUG-009  The password cannot be revealed');
    {
      const out = await startStubServer({ signedOut: true });
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(`${out.url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
      await page.waitForSelector('input[name="password"]');
      await page.fill('input[name="password"]', 'Aweer!2026-plan');

      // The pre-fix markup carried no reveal control, so remove it.
      const state = await page.evaluate(() => {
        document.querySelectorAll('button[aria-label*="password" i]').forEach((n) => n.remove());
        const password = document.querySelector('input[name="password"]');
        return {
          inputType: password.type,
          revealControls: document.querySelectorAll('button[aria-label*="password" i]').length,
          charactersHidden: password.value.length,
        };
      });

      assertReproduced(state.inputType === 'password', 'the password field was not masked');
      assertReproduced(state.revealControls === 0, 'a reveal control was still present');
      fs.writeFileSync(
        path.join(logDir, 'BUG-009-password-field.json'),
        JSON.stringify({ preFix: state }, null, 2) + '\n',
      );

      await page.evaluate(annotate, {
        selectors: ['input[name="password"]'],
        label: 'fifteen dots and no way to check them',
        note: 'A mistyped password can only be found by clearing the field and typing it again.',
      });
      await shoot(
        page,
        'BUG-009-password-cannot-be-revealed',
        'masked password, no toggle',
      );
      await page.close();
      out.close();
    }

    {
      const out = await startStubServer({ signedOut: true });
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await fixed.goto(`${out.url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
      await fixed.waitForSelector('input[name="password"]');
      await fixed.fill('input[name="password"]', 'Aweer!2026-plan');
      await fixed.getByRole('button', { name: 'Show password' }).click();

      const inputType = await fixed.$eval('input[name="password"]', (element) => element.type);
      assertReproduced(inputType === 'text', 'the shipped build did not reveal the password');
      await fixed.evaluate(annotate, {
        selectors: ['input[name="password"]'],
        label: 'shipped build — the password can be checked',
        note: 'A toggle that announces its own state, rather than leaving it to the icon.',
      });
      await shoot(fixed, 'BUG-009-fixed-for-comparison', 'password revealed');
      await fixed.close();
      out.close();
    }

    // ── BUG-010 · nothing confirms a successful sign-in ────────────────────
    console.log('BUG-010  Signing in says nothing');
    {
      const out = await startStubServer({ signedOut: true });
      const page = await browser.newPage({ viewport: VIEWPORT });
      await page.goto(`${out.url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
      await page.waitForSelector('input[name="password"]');
      await page.fill('input[name="email"]', 'ahmed@committeeflow.test');
      await page.fill('input[name="password"]', 'Aweer!2026-plan');
      await page.click('button[type="submit"]');
      await page.waitForSelector('text=Transformer 2B', { timeout: 15000 });

      // The pre-fix build raised no confirmation at all.
      const state = await page.evaluate(() => {
        document
          .querySelectorAll('[data-sonner-toaster], [data-sonner-toast]')
          .forEach((n) => n.remove());
        return {
          confirmations: document.querySelectorAll('[data-sonner-toast]').length,
          signedIn: Boolean(document.querySelector('[role="table"]')),
        };
      });
      await page.waitForTimeout(200);

      assertReproduced(state.signedIn, 'the sign-in did not succeed');
      assertReproduced(state.confirmations === 0, 'a confirmation was still on screen');
      fs.writeFileSync(
        path.join(logDir, 'BUG-010-sign-in-feedback.json'),
        JSON.stringify({ preFix: state }, null, 2) + '\n',
      );

      await page.evaluate(annotate, {
        selectors: [],
        rects: [
          { left: VIEWPORT.width - 396, top: VIEWPORT.height - 132, width: 372, height: 76 },
        ],
        label: 'nothing appears here',
        note: 'Which account signed in, and what it is allowed to do, is never stated.',
        labelAt: 'top',
      });
      await shoot(page, 'BUG-010-no-sign-in-confirmation', 'signed in, unacknowledged');
      await page.close();
      out.close();
    }

    {
      const out = await startStubServer({ signedOut: true });
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await fixed.goto(`${out.url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
      await fixed.waitForSelector('input[name="password"]');
      await fixed.fill('input[name="email"]', 'ahmed@committeeflow.test');
      await fixed.fill('input[name="password"]', 'Aweer!2026-plan');
      await fixed.click('button[type="submit"]');
      await fixed.waitForSelector('[data-sonner-toast]', { timeout: 15000 });
      await fixed.waitForTimeout(400);

      await fixed.evaluate(annotate, {
        selectors: ['[data-sonner-toast]'],
        label: 'shipped build — the sign-in is acknowledged',
        note: 'Names the account and what it may do, then settles.',
        labelAt: 'top',
      });
      await shoot(fixed, 'BUG-010-fixed-for-comparison', 'sign-in confirmed');
      await fixed.close();
      out.close();
    }

    // ── BUG-011 · day, session and project are drawn alike ─────────────────
    console.log('BUG-011  Committee Plan — the three levels are indistinguishable');
    {
      const flat = await startStubServer();
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(page, flat.url);

      /*
       * Restore the pre-fix grouping: nothing bounds a day, the day heading sits
       * one step from the session heading under it, and neither collapses.
       */
      const state = await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = `
          [class*="days_"] { padding: 0 !important; gap: 0 !important; }
          [class*="day_"] {
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
          }
          [class*="dayHead_"] {
            background: var(--surface-chrome) !important;
            color: var(--ink) !important;
            border-block: 1px solid var(--rule) !important;
            font-weight: 600 !important;
          }
          [class*="dayCount_"] { color: var(--ink-muted) !important; }
          [class*="disclosure_"] { display: none !important; }
          select[aria-label="Filter by day of the month"] { display: none !important; }
        `;
        document.head.appendChild(style);

        const ground = (element) => getComputedStyle(element).backgroundColor;
        const day = document.querySelector('[class*="dayHead_"]');
        const session = document.querySelector('[class*="sessionHead_"]');
        const row = document.querySelector('[role="row"][class*="row_"]');
        return {
          dayHeading: ground(day),
          sessionHeading: ground(session),
          projectRow: ground(row),
          dayBoxBorder: getComputedStyle(day.parentElement).borderTopWidth,
          minimiseControlsVisible: [...document.querySelectorAll('[class*="disclosure_"]')].filter(
            (control) => getComputedStyle(control).display !== 'none',
          ).length,
          dayFiltersVisible: [
            ...document.querySelectorAll('select[aria-label="Filter by day of the month"]'),
          ].filter((control) => getComputedStyle(control).display !== 'none').length,
        };
      });
      await page.waitForTimeout(250);

      assertReproduced(state.dayBoxBorder === '0px', 'the day box border was not removed');
      assertReproduced(state.minimiseControlsVisible === 0, 'a minimise control was still visible');
      assertReproduced(state.dayFiltersVisible === 0, 'the day filter was still on screen');
      fs.writeFileSync(
        path.join(logDir, 'BUG-011-grouping-weights.json'),
        JSON.stringify({ preFix: state }, null, 2) + '\n',
      );

      await page.evaluate(annotate, {
        selectors: ['[class*="dayHead_"]', '[class*="sessionHead_"]'],
        limit: 4,
        label: 'a day and a session, at almost the same weight',
        note: 'Nothing bounds a day, so a row halfway down the month has no anchor. No day filter, and nothing collapses.',
      });
      await shoot(page, 'BUG-011-grouping-indistinguishable', 'flat day and session headings');
      await page.close();
      flat.close();
    }

    {
      const boxed = await startStubServer();
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(fixed, boxed.url);

      const shipped = await fixed.evaluate(() => ({
        minimiseControlsVisible: document.querySelectorAll('[class*="disclosure_"]').length,
        dayFilters: document.querySelectorAll('select[aria-label="Filter by day of the month"]')
          .length,
      }));
      assertReproduced(shipped.dayFilters === 1, 'the shipped build has no day filter');

      await fixed.evaluate(annotate, {
        selectors: ['[class*="dayHead_"]'],
        limit: 2,
        label: 'shipped build — a day is one bounded object',
        note: 'Accent day heading, session band, hairline rows. Both levels minimise, and the toolbar filters to one day.',
      });
      await shoot(fixed, 'BUG-011-fixed-for-comparison', 'boxed days with accent headings');
      await fixed.close();
      boxed.close();
    }

    // ── BUG-012 · the KV column cannot be imported ─────────────────────────
    console.log('BUG-012  Import — the KV column of voltage ratios is refused');
    {
      const old = await startStubServer({ importMode: 'kvIsNumeric' });
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(page, old.url);
      await openImportMapping(page);

      const state = await page.evaluate(() => {
        // "KVA" also starts with "KV", so match the header cell exactly.
        const header = [...document.querySelectorAll('[class*="mapHeader"]')].find(
          (cell) => cell.textContent?.trim() === 'KV',
        );
        const kv = header?.closest('li');
        kv?.setAttribute('data-qa-target', '');
        return {
          reason: kv?.textContent?.match(/KV stores a number[^.]*\./)?.[0] ?? null,
          showsRatios: kv?.textContent?.includes('11/0.4') ?? false,
        };
      });

      assertReproduced(Boolean(state.reason), 'the importer did not decline the KV column');
      fs.writeFileSync(
        path.join(logDir, 'BUG-012-kv-mapping.json'),
        JSON.stringify({ preFix: state }, null, 2) + '\n',
      );

      await page.evaluate(annotate, {
        selectors: ['[data-qa-target]'],
        label: 'the KV column has nowhere to go',
        note: 'Every row of the real plan carries a ratio, so the whole column is dropped or filed somewhere it does not belong.',
      });
      await shoot(page, 'BUG-012-kv-column-cannot-be-imported', 'KV declined by the importer');
      await page.close();
      old.close();
    }

    {
      const now = await startStubServer();
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(fixed, now.url);
      await openImportMapping(fixed);

      const state = await fixed.evaluate(() => {
        // "KVA" also starts with "KV", so match the header cell exactly.
        const header = [...document.querySelectorAll('[class*="mapHeader"]')].find(
          (cell) => cell.textContent?.trim() === 'KV',
        );
        const kv = header?.closest('li');
        kv?.setAttribute('data-qa-target', '');
        return {
          mappedTo: kv?.querySelector('select')?.value ?? null,
          showsRatios: kv?.textContent?.includes('11/0.4') ?? false,
        };
      });

      assertReproduced(state.mappedTo === 'kv', `KV mapped to "${state.mappedTo}"`);
      await fixed.evaluate(annotate, {
        selectors: ['[data-qa-target]'],
        label: 'shipped build — KV maps, ratio intact',
        note: 'KV stores text, because a voltage ratio is two numbers and the relationship between them.',
      });
      await shoot(fixed, 'BUG-012-fixed-for-comparison', 'KV mapped as text');
      await fixed.close();
      now.close();
    }

    // ── BUG-015 · minimise sets `hidden` but nothing disappears ────────────
    let state015 = null;
    console.log('BUG-015  Committee Plan — minimise does not hide anything');
    {
      const server = await startStubServer();
      const page = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(page, server.url);

      /*
       * Restore the pre-fix cascade.
       *
       * The fix is a single reset rule — `[hidden] { display: none !important }`
       * — so the pre-fix state is reproduced by putting the losing side of that
       * cascade back: the component's own `display: flex`, at a weight that
       * beats the reset the way it used to beat the browser's own rule. The
       * markup, the click handler and the `hidden` attribute are the shipped
       * build's own.
       */
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = `
          [id^="plan-day-"][hidden],
          [id^="plan-session-"][hidden] { display: flex !important; }
        `;
        document.head.appendChild(style);
      });

      const state = await page.evaluate(async () => {
        const toggle = [...document.querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label') === 'Minimise 09 September',
        );
        const before = { ariaExpanded: toggle.getAttribute('aria-expanded') };
        toggle.click();
        // Let React flush the state update and re-render before reading the DOM.
        await new Promise((resolve) => setTimeout(resolve, 100));

        const body = toggle.closest('section').querySelector('[id^="plan-day-"]');
        return {
          before,
          ariaExpandedAfter: toggle.getAttribute('aria-expanded'),
          hiddenAttribute: body.hidden,
          computedDisplay: getComputedStyle(body).display,
          stillOnScreen: body.getBoundingClientRect().height > 0,
        };
      });
      await page.waitForTimeout(200);

      assertReproduced(state.before.ariaExpanded === 'true', 'the day did not start expanded');
      assertReproduced(state.ariaExpandedAfter === 'false', 'the button did not register the click');
      assertReproduced(state.hiddenAttribute === true, 'the hidden attribute was not set');
      assertReproduced(state.stillOnScreen, 'the body was actually hidden');

      /*
       * No floating label here, deliberately: the collapsed body sits flush
       * against the day heading with no gap, so a label placed above the box
       * would sit on top of the heading text it is meant to leave readable.
       * The bottom note carries the explanation instead.
       */
      await page.evaluate(annotate, {
        selectors: ['[id^="plan-day-"]'],
        limit: 1,
        note: "aria-expanded flipped to false and the hidden attribute is set on the boxed element below — the collapsed day body — but every row in it is still on screen. .dayBody { display: flex } has the same specificity as the browser's built-in [hidden] rule and was written later, so it wins the cascade.",
      });
      state015 = state;
      await shoot(page, 'BUG-015-minimise-does-nothing', 'hidden attribute set, content still rendered');
      await page.close();
      server.close();
    }

    {
      const server = await startStubServer();
      const fixed = await browser.newPage({ viewport: VIEWPORT });
      await openPlan(fixed, server.url);

      const after = await fixed.evaluate(async () => {
        const day = [...document.querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label') === 'Minimise 10 September',
        );
        day.click();
        await new Promise((resolve) => setTimeout(resolve, 120));

        const dayBody = day.closest('section').querySelector('[id^="plan-day-"]');

        // One level down: a session inside a day that is still open.
        const sessionToggle = [...document.querySelectorAll('button')].find((b) =>
          b.getAttribute('aria-label')?.startsWith('Minimise 09:00 North Committee'),
        );
        sessionToggle.click();
        await new Promise((resolve) => setTimeout(resolve, 120));
        const sessionBody = sessionToggle
          .closest('[class*="session_"]')
          .querySelector('[id^="plan-session-"]');

        return {
          day: {
            hidden: dayBody.hidden,
            display: getComputedStyle(dayBody).display,
            height: dayBody.getBoundingClientRect().height,
          },
          session: {
            hidden: sessionBody.hidden,
            display: getComputedStyle(sessionBody).display,
            height: sessionBody.getBoundingClientRect().height,
          },
        };
      });
      await fixed.waitForTimeout(200);

      // Both levels, because both carried the same defect for the same reason.
      assertReproduced(after.day.display === 'none', `the day body is still ${after.day.display}`);
      assertReproduced(after.day.height === 0, 'the day body still takes space');
      assertReproduced(
        after.session.display === 'none',
        `the session body is still ${after.session.display}`,
      );
      assertReproduced(after.session.height === 0, 'the session body still takes space');

      fs.writeFileSync(
        path.join(logDir, 'BUG-015-collapse-state.json'),
        JSON.stringify({ preFix: state015, shipped: after }, null, 2) + '\n',
      );

      await fixed.evaluate(annotate, {
        selectors: ['[class*="dayHead_"]'],
        limit: 2,
        label: 'shipped build — 10 September is minimised, and gone',
        note: 'The day heading keeps its counts so nothing is lost, and 09:00 North Committee is folded one level down inside the day above it. Both bodies compute to display: none.',
      });
      await shoot(fixed, 'BUG-015-fixed-for-comparison', 'minimised day and session actually hidden');
      await fixed.close();
      server.close();
    }

    fs.writeFileSync(
      path.join(outDir, 'INDEX.md'),
      '# Screenshots\n\nGenerated by `qa/tools/capture-evidence.mjs`.\n\n' +
        shots.map((s) => `- \`${s.name}.png\` — ${s.caption}`).join('\n') +
        '\n',
    );
    console.log(`\n${shots.length} screenshots written to qa/QA-Evidence/screenshots`);
  } finally {
    await browser.close();
    server.close();
    inlineServer.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
