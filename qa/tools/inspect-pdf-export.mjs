import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * What the PDF export actually put on the page.
 *
 * The other harnesses photograph a browser; a PDF has none, and a screenshot of
 * a viewer only shows what that viewer chose to draw. This reads the document
 * instead — through a real PDF reader, so the answer is what a person would get
 * by selecting the text and copying it.
 *
 * It exists for BUG-014, where committee names outside Latin-1 reached the page
 * as printable Latin nonsense: output that did not look broken, it looked like
 * corrupted data.
 *
 *   node inspect-pdf-export.mjs <exported.pdf>
 *
 * Produce the input by exporting a month from the running application:
 *
 *   curl -b cookies.txt "http://localhost:4000/api/export/pdf?month=2026-09" -o plan.pdf
 *
 * A note on what this can and cannot tell you. It proves the characters
 * survived. It cannot tell you whether Arabic letters joined correctly or
 * whether the words run the right way — those are visual properties, and
 * `compare-rtl.mjs` checks them against a browser.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.resolve(here, '..', 'QA-Evidence', 'logs');

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('usage: node inspect-pdf-export.mjs <exported.pdf>');
  process.exit(2);
}

const body = fs.readFileSync(pdfPath);
const document = await getDocument({
  data: new Uint8Array(body),
  // The font under test is the one in the file, never one off this machine.
  useSystemFonts: false,
}).promise;

const runs = [];
for (let page = 1; page <= document.numPages; page += 1) {
  const content = await (await document.getPage(page)).getTextContent();
  for (const item of content.items) {
    if (!('str' in item) || item.str.trim() === '') continue;
    runs.push({ page, text: item.str });
  }
}

/*
 * U+FFFD is what a reader shows for a glyph the document cannot map back to a
 * codepoint — the modern shape of the original defect. The other signature is a
 * run of control characters, which is what an unmapped subset looks like when
 * it is read as text.
 */
const unreadable = runs.filter(
  (run) =>
    run.text.includes('�') ||
    [...run.text].some((character) => character.charCodeAt(0) < 32 && character !== '\t'),
);

const fonts = [...new Set(body.toString('latin1').match(/\/BaseFont\s*\/([A-Za-z0-9+\-_]+)/g) ?? [])];

const report = {
  pdf: path.basename(pdfPath),
  sizeBytes: body.length,
  pages: document.numPages,
  textRuns: runs.length,
  fonts,
  embedsFontProgram: /FontFile2|FontFile3/.test(body.toString('latin1')),
  unreadableRuns: unreadable.map((run) => ({
    page: run.page,
    onThePage: run.text,
    codepoints: [...run.text]
      .map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
      .join(' '),
  })),
  verdict:
    unreadable.length === 0
      ? 'every text run reads back as the characters it was drawn from'
      : `${unreadable.length} run(s) reached the page unreadable`,
};

fs.mkdirSync(logDir, { recursive: true });
const out = path.join(logDir, 'BUG-014-pdf-text-runs.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({ ...report, unreadableRuns: report.unreadableRuns.slice(0, 5) }, null, 2));
console.log(`\nwritten to ${path.relative(process.cwd(), out)}`);
if (unreadable.length > 0) process.exitCode = 1;
