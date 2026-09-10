import { inflateSync } from 'node:zlib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Reading a generated PDF back, the way a reader would.
 *
 * Once the export embeds a font — which it must, to hold Arabic — the text in
 * the content stream is glyph ids in a subset, not characters. Recovering the
 * words means going through the document's own ToUnicode map, which is exactly
 * what a PDF reader does when someone selects and copies. So the tests use a
 * real one rather than a hand-rolled parser: it is the difference between
 * asserting on what we meant to draw and asserting on what the file says.
 */

export interface PdfTextItem {
  text: string;
  /** Left edge, in points from the page's left margin. */
  x: number;
  /** Baseline, in points from the bottom of the page. */
  y: number;
  page: number;
}

export interface PdfContents {
  /** Every drawn run, in the order the reader reports them. */
  items: PdfTextItem[];
  /** All of it joined, for a plain "does the page mention…" check. */
  text: string;
  /** The same, with whitespace removed, for values that wrap inside a cell. */
  packed: string;
  pages: number;
  /** Distinct fill colours used, as uppercase hex. */
  fills: string[];
}

export async function readPdf(body: Buffer): Promise<PdfContents> {
  const document = await getDocument({
    data: new Uint8Array(body),
    // Nothing may come from the machine running the tests: the font under test
    // is the one embedded in the file.
    useSystemFonts: false,
  }).promise;

  const items: PdfTextItem[] = [];
  for (let page = 1; page <= document.numPages; page += 1) {
    const content = await (await document.getPage(page)).getTextContent();
    for (const item of content.items) {
      if (!('str' in item) || item.str.trim() === '') continue;
      items.push({
        text: item.str,
        x: Math.round(item.transform[4] as number),
        y: Math.round(item.transform[5] as number),
        page,
      });
    }
  }

  return {
    items,
    text: items.map((item) => item.text).join(' '),
    /*
     * The same text with every space removed.
     *
     * A long value wraps inside its cell, and the two halves reach a reader as
     * separate runs — so a serial number like `DD-001600-022000-S289` is on the
     * page, correctly, but not as one contiguous string. This is for asserting
     * that a value survived, where where it broke is not the point.
     */
    packed: items.map((item) => item.text).join('').replace(/\s+/g, ''),
    pages: document.numPages,
    fills: fillColours(body),
  };
}

/**
 * The fill colours the page paints with.
 *
 * Colour never goes through a font, so this stays a direct read of the content
 * stream — and the form's identity is partly its colours.
 */
function fillColours(body: Buffer): string[] {
  const raw = body.toString('latin1');
  let content = '';

  const marker = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) continue;
    try {
      content += inflateSync(body.subarray(start, end)).toString('latin1');
    } catch {
      // A font or image stream, which paints nothing by itself.
    }
  }

  // Fills are written against an explicit colour space, so `scn`, not `rg`.
  return [
    ...new Set(
      [...content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) scn\b/g)].map(
        (colour) =>
          '#' +
          colour
            .slice(1, 4)
            .map((channel) =>
              Math.round(Number(channel) * 255)
                .toString(16)
                .padStart(2, '0'),
            )
            .join('')
            .toUpperCase(),
      ),
    ),
  ];
}

/**
 * The run that drew a given value, if the page drew one.
 *
 * Matching is on the characters rather than on equality, because a reader
 * returns text in the order it sits on the page: an Arabic run comes back
 * reordered, and a shaped ligature can report its two letters either way round.
 * Those are properties of extraction, not of the document — the ordering itself
 * is asserted directly in the unit tests, where it can be pinned exactly.
 */
export function findRun(contents: PdfContents, value: string): PdfTextItem | undefined {
  const wanted = [...value].filter((character) => !/\s/.test(character)).sort().join('');
  return contents.items.find(
    (item) => [...item.text].filter((c) => !/\s/.test(c)).sort().join('') === wanted,
  );
}
