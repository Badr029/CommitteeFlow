import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Renders a generated PDF to PNG, so a person can look at it.
 *
 * `inspect-pdf-export.mjs` reads what a document *says*; this shows what it
 * *looks like*, which for Arabic is the only check that means anything. Letters
 * that join correctly, words that run right to left and digits that do not are
 * three different failures with identical byte-level symptoms.
 *
 * pdf.js does the rasterising, driven inside the same headless Chromium the
 * other harnesses use — so the picture comes from a real PDF renderer rather
 * than from our own idea of what we drew.
 *
 *   node render-pdf.mjs <file.pdf> [outputPrefix] [--scale=2] [--pages=1,2]
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.resolve(here, '..', 'QA-Evidence', 'screenshots');

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith('--'));
const prefix = args.filter((a) => !a.startsWith('--'))[1] ?? 'pdf-page';
const scale = Number(args.find((a) => a.startsWith('--scale='))?.split('=')[1] ?? 2);
const only = args
  .find((a) => a.startsWith('--pages='))
  ?.split('=')[1]
  ?.split(',')
  .map(Number);

if (!pdfPath) {
  console.error('usage: node render-pdf.mjs <file.pdf> [outputPrefix] [--scale=2] [--pages=1,2]');
  process.exit(2);
}

const pdfBytes = fs.readFileSync(pdfPath);
const pdfjsDir = path.join(repoRoot, 'node_modules', 'pdfjs-dist', 'build');

const PAGE = `<!doctype html>
<meta charset="utf-8">
<style>html,body{margin:0;background:#fff}canvas{display:block}</style>
<canvas id="c"></canvas>
<script type="module">
  import * as pdfjs from '/pdfjs/pdf.mjs';
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

  window.renderPage = async (pageNumber, scale) => {
    const doc = await pdfjs.getDocument({ url: '/doc.pdf' }).promise;
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const canvas = document.getElementById('c');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { pages: doc.numPages, width: canvas.width, height: canvas.height };
  };
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (url.pathname === '/doc.pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    return res.end(pdfBytes);
  }
  if (url.pathname.startsWith('/pdfjs/')) {
    const file = path.join(pdfjsDir, path.basename(url.pathname));
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end('no such pdf.js file');
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (error) => console.error('  [page error]', error.message));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof window.renderPage === 'function');

  const first = await page.evaluate(([n, s]) => window.renderPage(n, s), [1, scale]);
  const numbers = only ?? Array.from({ length: first.pages }, (_, i) => i + 1);

  for (const number of numbers) {
    const size = await page.evaluate(([n, s]) => window.renderPage(n, s), [number, scale]);
    const file = path.join(outDir, `${prefix}-${number}.png`);
    await page.locator('#c').screenshot({ path: file });
    console.log(`  rendered page ${number} (${size.width}x${size.height}) -> ${path.basename(file)}`);
  }
} finally {
  await browser.close();
  server.close();
}
