import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bidiFactory from 'bidi-js';
import type { Bidi } from 'bidi-js';

/**
 * Drawing text into a PDF, in any script the plan is written in.
 *
 * The Committee Plan is bilingual: committee names, order names and customer
 * names arrive in Arabic as often as in English, and a single cell may hold
 * both — `محول 1500 KVA`. Getting that onto a page correctly is three separate
 * problems, and this module exists so the export service has to know about
 * none of them.
 *
 *   1. Encoding.  The fourteen standard PDF fonts are Latin-1. Arabic has no
 *      representation in them, so it used to reach the page as mis-encoded
 *      bytes that looked like corrupt data (BUG-014). Fixed by embedding a
 *      font that actually covers the script.
 *
 *   2. Shaping.  Arabic letters change form depending on their neighbours.
 *      fontkit — which PDFKit already uses for embedded fonts — does this
 *      correctly on its own, so nothing here shapes anything by hand.
 *
 *   3. Ordering.  This is the part nothing in the stack does for us. fontkit
 *      reverses a whole run when it sees an RTL script, which is right for
 *      `وطنية` and wrong for `وطنية 202601066`: it reverses the digits too, and
 *      the OFF number comes out backwards. Ordering mixed text is the
 *      Unicode Bidirectional Algorithm (UAX #9), and it is implemented here by
 *      `bidi-js` rather than by anything hand-rolled.
 *
 * The rule that makes 2 and 3 coexist: the algorithm reorders *runs*, and
 * never the characters inside one. Each run is handed to PDFKit in the order
 * it was written, so the shaper still sees Arabic as Arabic and picks the
 * right contextual forms; only the runs are placed right-to-left. Reversing
 * the characters first — the obvious-looking fix — would break joining,
 * digits, and every bracket on the page.
 */

/*
 * bidi-js ships a UMD bundle whose `module.exports` *is* the factory, while its
 * type declaration describes an ES default export. Under NodeNext those are two
 * different values, so the call goes through the runtime shape.
 */
const bidi: Bidi = (bidiFactory as unknown as () => Bidi)();

/*
 * `server/src/modules/export` in development and `server/dist/modules/export`
 * in the built image are both three levels below the package root, so one
 * relative path serves tsx, vitest and `node dist/server.js` alike. Nothing
 * here reads a font from the operating system: the document must come out the
 * same on a laptop, in CI and in the container.
 */
const FONT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'assets',
  'fonts',
);

/** Falls back to this only when a caller does not state a size. */
const DEFAULT_FONT_SIZE = 7;

export const PDF_FONT = 'plan';
export const PDF_FONT_BOLD = 'plan-bold';

/**
 * Makes the embedded fonts available on a document.
 *
 * Called once per document; PDFKit subsets and embeds only the glyphs that are
 * actually drawn, so registering both weights costs nothing on a page that
 * uses one.
 */
export function registerPdfFonts(doc: PDFKit.PDFDocument): void {
  doc.registerFont(PDF_FONT, path.join(FONT_DIR, 'Cairo-Regular.ttf'));
  doc.registerFont(PDF_FONT_BOLD, path.join(FONT_DIR, 'Cairo-Bold.ttf'));
}

/**
 * Characters that read right to left.
 *
 * Written as escapes rather than as the letters themselves: a range typed
 * literally puts right-to-left text inside a left-to-right source file, where
 * an editor shows the two ends of each range in the opposite order from the one
 * they are stored in. The blocks are Hebrew, Arabic and its supplements,
 * Syriac, Thaana, N'Ko, Samaritan, Mandaic, and the two presentation-form
 * blocks - everything the plan could plausibly carry.
 */
const STRONG_RTL = /[\u0590-\u05FF\u0600-\u07BF\u07C0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;

/** True when the text contains a character that reads right to left. */
export function containsRtl(text: string): boolean {
  return STRONG_RTL.test(text);
}

/**
 * The direction the text as a whole reads in (UAX #9 rules P2 and P3).
 *
 * Decided by the first strong character, not by counting: `Transformer محول`
 * is an English phrase with an Arabic word in it and stays left-aligned, while
 * `محول Transformer` is an Arabic phrase and does not.
 */
export function baseDirection(text: string): 'ltr' | 'rtl' {
  if (!containsRtl(text)) return 'ltr';
  const { paragraphs } = bidi.getEmbeddingLevels(text);
  return paragraphs[0]?.level === 1 ? 'rtl' : 'ltr';
}

interface VisualRun {
  text: string;
  rtl: boolean;
}

/**
 * One line of logical-order text, split into runs in the order they appear on
 * the page — left to right — with each run still in the order it was written.
 *
 * `getReorderedIndices` answers "which character sits at each visual
 * position"; walking that answer and grouping neighbours that came from
 * neighbouring places in the source recovers the runs without ever reversing
 * anything inside one.
 */
function visualRuns(text: string): VisualRun[] {
  if (text === '') return [];
  if (!containsRtl(text)) return [{ text, rtl: false }];

  const levels = bidi.getEmbeddingLevels(text);
  const order = bidi.getReorderedIndices(text, levels);
  const mirrored = bidi.getMirroredCharactersMap(text, levels.levels);

  const groups: Array<{ start: number; end: number; rtl: boolean }> = [];
  let current: { start: number; end: number; rtl: boolean } | null = null;

  for (const index of order) {
    const rtl = (levels.levels[index] ?? 0) % 2 === 1;
    const continues =
      current !== null &&
      current.rtl === rtl &&
      (rtl ? index === current.start - 1 : index === current.end + 1);

    if (continues && current) {
      if (rtl) current.start = index;
      else current.end = index;
    } else {
      current = { start: index, end: index, rtl };
      groups.push(current);
    }
  }

  return groups.map((group) => {
    let run = '';
    for (let index = group.start; index <= group.end; index += 1) {
      /*
       * A bracket in right-to-left text points the other way: the `(` typed in
       * `وطنية (2026)` is drawn as `)` once the run lands on the left of the
       * number. The algorithm decides which characters those are; substituting
       * the glyph is the last thing left to do.
       */
      run += mirrored.get(index) ?? text[index];
    }
    return { text: run, rtl: group.rtl };
  });
}

/**
 * The ordering step on its own, for the tests.
 *
 * Exported because it is the one piece whose answer can be stated exactly —
 * everything downstream of it is shaping and pixels, which a test file cannot
 * judge.
 */
export { visualRuns as __visualRunsForTest };

export interface PdfTextOptions {
  x: number;
  y: number;
  /** The box the text has to stay inside. */
  width: number;
  /** Point size; defaults to whatever the document already has. */
  size?: number;
  bold?: boolean;
  color?: string;
  /**
   * `auto` follows the text: right for an Arabic phrase, left for an English
   * one. An explicit value wins, which is what keeps the numeric columns
   * right-aligned whatever they hold.
   */
  align?: 'left' | 'center' | 'right' | 'auto';
  /** Maximum lines before the text is cut short with an ellipsis. */
  maxLines?: number;
  lineGap?: number;
}

/*
 * Handed to every PDFKit text call, and the reason is not the features.
 *
 * PDFKit's own `layout()` splits a string on spaces, shapes each word on its
 * own — it caches layouts per word — and then concatenates the glyph runs in
 * the order the words were written. For Latin that is invisible. For Arabic it
 * quietly undoes the reordering: each word comes out correctly shaped and
 * reversed, but the words themselves stay in logical order, so a three-word
 * committee name reads back to front and one of its spaces moves to the front
 * of the line.
 *
 * Passing a features array takes PDFKit's other branch, which lays the whole
 * string out in one pass and leaves the shaper's ordering intact. The list is
 * empty on purpose: no feature is being requested, and the widths are identical
 * either way — this is about which code path runs, not about typography.
 */
const WHOLE_RUN: { features: [] } = { features: [] };

/** Point width of one logical run, as the embedded font will actually set it. */
function widthOf(doc: PDFKit.PDFDocument, text: string): number {
  return text === '' ? 0 : doc.widthOfString(text, WHOLE_RUN);
}

/**
 * Greedy word wrap on the *logical* string.
 *
 * Line breaking happens before reordering, which is the order UAX #9 itself
 * prescribes: the algorithm resolves the paragraph, then each line is reordered
 * for display. Widths are direction-independent — reversing a run of glyphs
 * does not change how much room it needs — so measuring the logical form is
 * exact.
 */
function wrap(doc: PDFKit.PDFDocument, text: string, width: number, maxLines: number): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/(\s+)/).filter((part) => part !== '');
    let line = '';

    for (const word of words) {
      const candidate = line + word;
      if (line !== '' && widthOf(doc, candidate.trimEnd()) > width) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }

      // A single word longer than the cell is broken rather than allowed to
      // run into the next column.
      while (widthOf(doc, line) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && widthOf(doc, line.slice(0, cut)) > width) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }

    lines.push(line.trimEnd());
  }

  if (lines.length <= maxLines) return lines;

  // Too long: keep what fits and mark the cut on the last line kept.
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  let truncated = last;
  while (truncated.length > 0 && widthOf(doc, `${truncated}…`) > width) {
    truncated = truncated.slice(0, -1);
  }
  kept[maxLines - 1] = `${truncated.trimEnd()}…`;
  return kept;
}

export interface PdfTextResult {
  /** Height the text occupied, so a row can be sized around it. */
  height: number;
  lines: number;
}

/**
 * Draws text at a position, in logical order in and correct order out.
 *
 * Callers hand over the value exactly as it came from the database. Nothing
 * upstream of here reverses, reshapes or otherwise prepares a string — doing so
 * would make this function's job impossible, because the algorithm needs the
 * original order to work from.
 */
export function renderPdfText(
  doc: PDFKit.PDFDocument,
  text: string,
  options: PdfTextOptions,
): PdfTextResult {
  const size = options.size ?? DEFAULT_FONT_SIZE;
  const lineGap = options.lineGap ?? 0;

  doc.font(options.bold ? PDF_FONT_BOLD : PDF_FONT).fontSize(size);
  if (options.color) doc.fillColor(options.color);

  const lineHeight = doc.currentLineHeight() + lineGap;
  if (text === '') return { height: 0, lines: 0 };

  const lines = wrap(doc, text, options.width, options.maxLines ?? 1);
  const direction = options.align === 'auto' || !options.align ? baseDirection(text) : 'ltr';

  lines.forEach((line, index) => {
    const runs = visualRuns(line);
    const lineWidth = runs.reduce((total, run) => total + widthOf(doc, run.text), 0);

    const align =
      options.align && options.align !== 'auto'
        ? options.align
        : direction === 'rtl'
          ? 'right'
          : 'left';

    let x = options.x;
    if (align === 'right') x = options.x + options.width - lineWidth;
    else if (align === 'center') x = options.x + (options.width - lineWidth) / 2;

    const y = options.y + index * lineHeight;

    /*
     * Each run is placed by hand rather than handed to PDFKit as one string.
     * PDFKit has no notion of a line made of pieces that read in different
     * directions, so the alternative would be letting fontkit reverse the
     * whole line — which is the bug this module exists to fix.
     */
    for (const run of runs) {
      doc.text(run.text, x, y, { lineBreak: false, width: doc.page.width, ...WHOLE_RUN });
      x += widthOf(doc, run.text);
    }
  });

  return { height: lines.length * lineHeight, lines: lines.length };
}

/**
 * What `renderPdfText` would occupy, without drawing it.
 *
 * Used to size a row before its cells are filled, so a wrapped order name and
 * the merged date cell beside it agree on how tall the row is.
 */
export function measurePdfText(
  doc: PDFKit.PDFDocument,
  text: string,
  options: Pick<PdfTextOptions, 'width' | 'size' | 'bold' | 'maxLines' | 'lineGap'>,
): PdfTextResult {
  if (text === '') return { height: 0, lines: 0 };

  const size = options.size ?? DEFAULT_FONT_SIZE;
  doc.font(options.bold ? PDF_FONT_BOLD : PDF_FONT).fontSize(size);

  const lineHeight = doc.currentLineHeight() + (options.lineGap ?? 0);
  const lines = wrap(doc, text, options.width, options.maxLines ?? 1);
  return { height: lines.length * lineHeight, lines: lines.length };
}
