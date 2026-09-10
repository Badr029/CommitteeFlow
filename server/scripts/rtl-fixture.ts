import { writeFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { PDF_FONT, registerPdfFonts, renderPdfText } from '../src/modules/export/pdf-text.js';

/**
 * A page of bilingual text, for looking at.
 *
 * BUG-014 cannot be closed by a passing test. Whether Arabic letters joined
 * correctly, whether the words run the right way and whether the digits inside
 * them do not — those are three different failures that a byte-level assertion
 * cannot tell apart, and none of them can be judged from a terminal.
 *
 * So this writes a fixture that a person can look at, and that
 * `qa/tools/compare-rtl.mjs` sets beside the same strings rendered by a
 * browser. Each case appears twice: once drawn straight through PDFKit, which
 * is what the export used to do, and once through the export's own text layer.
 * The difference between the two rows is the fix.
 *
 *   npm run fixture:rtl --workspace server -- out.pdf
 */

const CASES: Array<[string, string]> = [
  ['pure Arabic', 'وطنية'],
  ['multi-word Arabic', 'شركة جنوب القاهرة'],
  ['Arabic + Latin', 'مشروع ABC'],
  ['Arabic + OFF number', 'وطنية 202601066'],
  ['Arabic + rating', 'محول 1500 KVA'],
  ['Arabic + parentheses', 'وطنية (2026)'],
  ['Arabic + voltage ratio', '22/0.4 وطنية'],
  ['long Arabic company', 'شركة جنوب القاهرة لتوزيع الكهرباء'],
  ['Arabic, dash, Latin', 'وطنية - OFF 202601066'],
  ['serial reference', 'DD-001600-022000-S289'],
  ['English only', 'Aweer Feeder Pillar'],
];

const ROW = 46;
const WIDTH = 660;

const doc = new PDFDocument({ size: [WIDTH, ROW * CASES.length + 54], margin: 20 });
registerPdfFonts(doc);

doc.font(PDF_FONT).fontSize(9).fillColor('#555555');
doc.text('grey — drawn straight through PDFKit (what the export used to do)', 20, 16, {
  lineBreak: false,
  width: WIDTH - 40,
});
doc.text("black — through the export's text layer", 20, 28, {
  lineBreak: false,
  width: WIDTH - 40,
});

let y = 54;
for (const [, text] of CASES) {
  doc.font(PDF_FONT).fontSize(15).fillColor('#a0a0a0');
  doc.text(text, 20, y, { lineBreak: false, width: WIDTH - 40 });

  renderPdfText(doc, text, {
    x: 20,
    y: y + 20,
    width: WIDTH - 40,
    size: 15,
    color: '#000000',
    align: 'auto',
  });

  doc
    .save()
    .strokeColor('#e0e0e0')
    .lineWidth(0.5)
    .moveTo(20, y + ROW - 4)
    .lineTo(WIDTH - 20, y + ROW - 4)
    .stroke()
    .restore();
  y += ROW;
}

const chunks: Buffer[] = [];
doc.on('data', (chunk: Buffer) => chunks.push(chunk));
doc.on('end', () => {
  const target = process.argv[2] ?? 'rtl-fixture.pdf';
  writeFileSync(target, Buffer.concat(chunks));
  console.log(`wrote ${target} — ${CASES.length} cases`);
});
doc.end();
