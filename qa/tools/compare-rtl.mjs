import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * The PDF's Arabic, next to a browser's Arabic, in the same font.
 *
 * "Does this look right?" is not a question anyone should answer from memory in
 * a script they cannot read. So the same strings are set twice — once by the
 * export, once by Chromium's own text engine — from the same font file, and put
 * side by side. Chromium shapes Arabic with HarfBuzz and orders it with ICU,
 * which is as close to an authority as this repository can get.
 *
 * A difference is a bug in the export. Agreement is the strongest evidence
 * available without a reader of the language.
 *
 *   node compare-rtl.mjs <cases.pdf> [outputName]
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.resolve(here, '..', 'QA-Evidence', 'screenshots');

/** Kept in step with `server/scripts/rtl-fixture.ts`, which draws the PDF. */
const CASES = [
  'وطنية',
  'شركة جنوب القاهرة',
  'مشروع ABC',
  'وطنية 202601066',
  'محول 1500 KVA',
  'وطنية (2026)',
  '22/0.4 وطنية',
  'شركة جنوب القاهرة لتوزيع الكهرباء',
  'وطنية - OFF 202601066',
  'DD-001600-022000-S289',
  'Aweer Feeder Pillar',
];

const pdfPath = process.argv[2];
const outName = process.argv[3] ?? 'BUG-014-rtl-vs-browser';
if (!pdfPath) {
  console.error('usage: node compare-rtl.mjs <cases.pdf> [outputName]');
  process.exit(2);
}

const fontPath = path.join(repoRoot, 'server', 'assets', 'fonts', 'Cairo-Regular.ttf');
const fontData = fs.readFileSync(fontPath);
const pdfBytes = fs.readFileSync(pdfPath);
const pdfjsDir = path.join(repoRoot, 'node_modules', 'pdfjs-dist', 'build');

const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>
  @font-face { font-family: 'PlanArabic'; src: url('/font.ttf') format('truetype'); }
  body { margin: 0; background: #fff; font-family: 'PlanArabic', sans-serif; }
  .wrap { width: 1280px; }
  h2 { font: 600 13px/1 ui-monospace, monospace; margin: 0; padding: 10px 16px 6px;
       color: #444; background: #f1f3f5; border-bottom: 1px solid #ccc; }
  .row { display: grid; grid-template-columns: 1fr; }
  .line { font-size: 16px; padding: 11px 40px; border-bottom: 1px solid #eee;
          text-align: right; direction: rtl; }
  canvas { display: block; }
</style>
<div class="wrap">
  <h2>Chromium — HarfBuzz shaping, ICU bidi, same font file (the reference)</h2>
  <div id="browser" class="row"></div>
  <h2>CommitteeFlow PDF export — grey: before the fix &nbsp;·&nbsp; black: after</h2>
  <canvas id="c"></canvas>
</div>
<script type="module">
  import * as pdfjs from '/pdfjs/pdf.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

  const cases = ${JSON.stringify(CASES)};
  const host = document.getElementById('browser');
  for (const text of cases) {
    const div = document.createElement('div');
    div.className = 'line';
    div.textContent = text;
    host.appendChild(div);
  }

  const doc = await pdfjs.getDocument({ url: '/doc.pdf' }).promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.getElementById('c');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = '1280px';
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  await document.fonts.ready;
  window.__ready = true;
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/doc.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    return res.end(pdfBytes);
  }
  if (url.pathname === '/font.ttf') {
    res.setHeader('Content-Type', 'font/ttf');
    return res.end(fontData);
  }
  if (url.pathname.startsWith('/pdfjs/')) {
    const file = path.join(pdfjsDir, path.basename(url.pathname));
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end('missing');
    }
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    return res.end(fs.readFileSync(file));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(PAGE);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  page.on('pageerror', (error) => console.error('  [page error]', error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.waitForTimeout(300);

  const file = path.join(outDir, `${outName}.png`);
  await page.locator('.wrap').screenshot({ path: file });
  console.log(`  saved ${path.basename(file)}`);
} finally {
  await browser.close();
  server.close();
}
