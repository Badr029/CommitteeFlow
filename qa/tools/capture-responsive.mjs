import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStubServer } from './stub-server.mjs';

/**
 * Evidence for the two responsive defects.
 *
 * Same rules as `capture-evidence.mjs`: the page is the real built client, the
 * pre-fix state is restored at run time, every measurement is read from the
 * live page, and a screenshot is only saved once the defect has proved itself.
 *
 *   npm run capture:responsive     (from qa/tools)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '..', 'QA-Evidence', 'screenshots');
const logDir = path.resolve(here, '..', 'QA-Evidence', 'logs');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

/** Draws the annotation. Runs inside the page. */
function annotate({ selectors, rects, label, note, labelAt, noteAt }) {
  document.querySelectorAll('[data-qa-annotation]').forEach((n) => n.remove());
  const boxes = selectors.flatMap((s) => [...document.querySelectorAll(s)]).map((el) => el.getBoundingClientRect());
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
      left: r.left - 3 + 'px',
      top: r.top - 3 + 'px',
      width: r.width + 6 + 'px',
      height: r.height + 6 + 'px',
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
    const top = labelAt ? labelAt.top : first.top - 3 > 32 ? first.top - 32 : first.bottom + 8;
    const left = labelAt ? labelAt.left : Math.max(6, first.left - 3);
    Object.assign(chip.style, {
      position: 'fixed',
      left: left + 'px',
      top: top + 'px',
      maxWidth: 'calc(100vw - 12px)',
      padding: '5px 9px',
      background: '#e0102f',
      color: '#fff',
      font: '600 12.5px/1.4 ui-sans-serif, system-ui, sans-serif',
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
      left: '10px',
      ...(noteAt ? { top: noteAt.top + 'px' } : { bottom: '10px' }),
      right: '10px',
      padding: '9px 12px',
      background: 'rgba(17,20,24,0.95)',
      color: '#f2f5f7',
      font: '500 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace',
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

function assertReproduced(condition, message) {
  if (!condition) throw new Error(`defect did not reproduce — refusing to save: ${message}`);
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

const shots = [];
async function shoot(page, name, caption, route = '/plan?month=2026-09') {
  await page.evaluate(drawUrlBar, `${APP_ORIGIN}${route}`);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  shots.push({ name, caption, route });
  console.log(`  saved ${name}.png  —  ${caption}`);
}

async function openPlan(page, url) {
  await page.goto(`${url}/plan?month=2026-09`, { waitUntil: 'networkidle' });
  await page.waitForSelector('text=Transformer 2B', { timeout: 15000 });
  await page.waitForTimeout(400);
}

/** Measures the plan's own scroll container. */
const planMetrics = () => {
  const scroll = document.querySelector('[class*="_scroll_"]');
  const nav = document.querySelector('[class*="tabBar"]');
  return {
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    planScrollWidth: scroll ? scroll.scrollWidth : 0,
    planClientWidth: scroll ? scroll.clientWidth : 0,
    planVisibleHeight: scroll ? Math.round(scroll.clientHeight) : 0,
    bottomNavHeight: nav ? Math.round(nav.getBoundingClientRect().height) : 0,
  };
};

async function main() {
  const server = await startStubServer();
  const browser = await chromium.launch();

  try {
    // ── BUG-005 · table forced sideways on a narrow screen ─────────────────
    console.log('BUG-005  Committee Plan — horizontal scrolling below 1000px');
    {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      /*
       * Restores the pre-fix behaviour exactly: before this work the plan chose
       * the column table at every width. Forcing every `min-width` query to
       * match makes the shipped build pick the desktop table again, at 375px.
       */
      await context.addInitScript(() => {
        window.matchMedia = (query) => ({
          matches: /min-width/.test(query),
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        });
      });
      const page = await context.newPage();
      await openPlan(page, server.url);

      const before = await page.evaluate(planMetrics);
      assertReproduced(
        before.planScrollWidth > before.planClientWidth + 20,
        `the plan fits its viewport (${before.planScrollWidth} <= ${before.planClientWidth})`,
      );

      // Scroll right, to photograph what the reader actually has to do.
      await page.evaluate(() => {
        const scroll = document.querySelector('[class*="_scroll_"]');
        if (scroll) scroll.scrollLeft = 320;
      });
      await page.waitForTimeout(300);

      await page.evaluate(annotate, {
        selectors: [],
        rects: [{ left: 0, top: 78, width: 375, height: 30 }],
        labelAt: { left: 8, top: 116 },
        label: `Table is ${before.planScrollWidth}px wide inside a ${before.planClientWidth}px screen`,
        note:
          `Viewport 375 x 812.\n` +
          `Plan content width  ${before.planScrollWidth}px\n` +
          `Plan viewport width ${before.planClientWidth}px\n` +
          `Every row must be dragged sideways to be read, and the OFF number —\n` +
          `the column a booking is found by — scrolls off the left as you go.`,
      });
      await shoot(page, 'BUG-005-table-forced-sideways', 'the column table at 375px, scrolled right');
      await context.close();

      // The shipped build at the same size.
      const fixedCtx = await browser.newContext({ viewport: { width: 375, height: 812 } });
      const fixed = await fixedCtx.newPage();
      await openPlan(fixed, server.url);
      const after = await fixed.evaluate(planMetrics);
      assertReproduced(
        after.planScrollWidth <= after.planClientWidth + 2,
        `the fixed build still scrolls sideways (${after.planScrollWidth} > ${after.planClientWidth})`,
      );
      fs.writeFileSync(
        path.join(logDir, 'BUG-005-horizontal-scroll.json'),
        JSON.stringify({ beforeFix: before, afterFix: after }, null, 2),
      );
      await fixed.evaluate(annotate, {
        selectors: ['[class*="sessionHead"]'],
        label: 'After the fix — the session agenda, no sideways scrolling',
        note: null,
      });
      await shoot(fixed, 'BUG-005-fixed-for-comparison', 'the same month as a session agenda');
      await fixedCtx.close();
    }

    // ── BUG-006 · landscape leaves almost no plan ──────────────────────────
    console.log('BUG-006  Committee Plan — chrome fills a landscape phone');
    {
      const context = await browser.newContext({ viewport: { width: 667, height: 375 } });
      const page = await context.newPage();
      await openPlan(page, server.url);

      /*
       * Restores the pre-fix chrome: before the short-viewport rules, the
       * toolbar stacked into two 44px rows, the navigation kept its labels, and
       * the summary strip kept its full padding.
       */
      await page.addStyleTag({
        content: `
          [class*="_toolbar_"] { flex-direction: column !important; align-items: stretch !important;
            gap: 8px !important; padding: 8px 12px !important; }
          [class*="_monthRow_"], [class*="_searchRow_"] { flex: none !important; width: 100% !important; }
          [class*="_monthStep_"], [class*="_bookButton_"], [class*="_filterButton_"],
          [class*="_searchInput_"], [class*="_todayButton_"] { height: 44px !important; min-height: 44px !important; }
          [class*="_tab_"] { min-height: 56px !important; }
          [class*="_tabLabel_"] { display: block !important; }
          [class*="_barMobile_"] { height: 52px !important; }
          [class*="_summary_"] { padding-block: 6px !important; min-height: 30px !important; }
        `,
      });
      await page.waitForTimeout(400);

      const before = await page.evaluate(planMetrics);
      assertReproduced(
        before.planVisibleHeight < 130,
        `the plan already has room (${before.planVisibleHeight}px visible)`,
      );

      await page.evaluate(annotate, {
        selectors: ['[class*="_scroll_"]'],
        labelAt: { left: 8, top: 8 },
        // Parked over the toolbar — the chrome being complained about — so it
        // does not cover the sliver of plan that is the actual finding.
        noteAt: { top: 40 },
        label: `Only ${before.planVisibleHeight}px of plan on a ${before.viewportHeight}px-tall screen`,
        note:
          `Viewport 667 x 375 — a phone held sideways.   ` +
          `Plan visible height ${before.planVisibleHeight}px.   ` +
          `Chrome above and below ${before.viewportHeight - before.planVisibleHeight}px.\n` +
          `The boxed strip near the bottom is all the plan there is; everything else on this\n` +
          `screen is the top bar, two toolbar rows, the summary strip and the navigation.`,
      });
      await shoot(page, 'BUG-006-landscape-chrome', 'chrome consuming a landscape phone');
      await context.close();

      const fixedCtx = await browser.newContext({ viewport: { width: 667, height: 375 } });
      const fixed = await fixedCtx.newPage();
      await openPlan(fixed, server.url);
      const after = await fixed.evaluate(planMetrics);
      assertReproduced(
        after.planVisibleHeight > before.planVisibleHeight + 60,
        `the fixed build did not recover room (${after.planVisibleHeight}px)`,
      );
      fs.writeFileSync(
        path.join(logDir, 'BUG-006-landscape-space.json'),
        JSON.stringify({ beforeFix: before, afterFix: after }, null, 2),
      );
      await fixed.evaluate(annotate, {
        selectors: ['[class*="_scroll_"]'],
        labelAt: { left: 8, top: 8 },
        label: `After the fix — ${after.planVisibleHeight}px of plan on the same screen`,
        note: null,
      });
      await shoot(fixed, 'BUG-006-fixed-for-comparison', 'the same screen after the short-viewport rules');
      await fixedCtx.close();
    }

    console.log(`\n${shots.length} screenshots written to qa/QA-Evidence/screenshots`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
