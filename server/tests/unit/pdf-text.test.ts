import { describe, expect, it } from 'vitest';
import PDFDocument from 'pdfkit';
import {
  PDF_FONT,
  __visualRunsForTest as visualRuns,
  baseDirection,
  containsRtl,
  measurePdfText,
  registerPdfFonts,
  renderPdfText,
} from '../../src/modules/export/pdf-text.js';

/**
 * Ordering bilingual text for the printed plan (BUG-014).
 *
 * These pin the algorithm rather than the picture: the sequence of runs is
 * exactly what the Unicode Bidirectional Algorithm decides, and a wrong answer
 * here is a wrong answer on the page. What a rendered document looks like is
 * checked separately, against a browser, because no assertion in a test file
 * can tell whether Arabic letters joined correctly.
 *
 * Runs read left to right, and each one is still in the order it was written —
 * which is the property that lets the shaper do its job afterwards.
 */
describe('PDF text direction', () => {
  const runs = (text: string) => visualRuns(text).map((run) => `${run.rtl ? 'RTL' : 'LTR'}:${run.text}`);

  describe('detecting direction', () => {
    it('recognises Arabic as right-to-left', () => {
      expect(containsRtl('وطنية')).toBe(true);
      expect(baseDirection('وطنية')).toBe('rtl');
    });

    it('leaves Latin alone', () => {
      expect(containsRtl('Aweer Feeder Pillar')).toBe(false);
      expect(baseDirection('Aweer Feeder Pillar')).toBe('ltr');
    });

    /*
     * The first strong character decides, not a majority vote (UAX #9, P2/P3).
     * An English order name with one Arabic word in it is still an English
     * phrase and stays left-aligned.
     */
    it('takes the direction from the first strong character, not the count', () => {
      expect(baseDirection('Transformer محول')).toBe('ltr');
      expect(baseDirection('محول Transformer')).toBe('rtl');
    });

    it('treats digits and punctuation as taking their direction from around them', () => {
      expect(containsRtl('202601066')).toBe(false);
      expect(baseDirection('22/0.4')).toBe('ltr');
    });
  });

  describe('ordering', () => {
    it('1 · pure Arabic is a single right-to-left run', () => {
      expect(runs('وطنية')).toEqual(['RTL:وطنية']);
    });

    it('2 · multi-word Arabic stays one run, so the words keep their order', () => {
      expect(runs('شركة جنوب القاهرة')).toEqual(['RTL:شركة جنوب القاهرة']);
    });

    it('3 · Arabic followed by Latin puts the Latin on the left', () => {
      expect(runs('مشروع ABC')).toEqual(['LTR:ABC', 'RTL:مشروع ']);
    });

    /*
     * The case that motivated all of this. fontkit reverses an Arabic run
     * wholesale, digits included, so the OFF number used to come out as
     * 660106202. The number is its own left-to-right run.
     */
    it('4 · an OFF number inside Arabic keeps its digits in order', () => {
      expect(runs('وطنية 202601066')).toEqual(['LTR:202601066', 'RTL:وطنية ']);
    });

    it('5 · a rating inside Arabic stays readable left to right', () => {
      expect(runs('محول 1500 KVA')).toEqual(['LTR:KVA', 'RTL: ', 'LTR:1500', 'RTL:محول ']);
    });

    it('6 · brackets are mirrored, so they still enclose what they enclosed', () => {
      const ordered = runs('وطنية (2026)');
      expect(ordered).toEqual(['RTL:(', 'LTR:2026', 'RTL:وطنية )']);

      // Drawn left to right, the pair reads as an opening then a closing
      // bracket — the glyphs are swapped, the characters were not.
      const drawn = visualRuns('وطنية (2026)')
        .map((run) => run.text)
        .join('');
      expect(drawn.startsWith('(')).toBe(true);
      expect(drawn.endsWith(')')).toBe(true);
    });

    it('7 · a voltage ratio before Arabic keeps both parts intact', () => {
      expect(runs('22/0.4 وطنية')).toEqual(['RTL: وطنية', 'LTR:22/0.4']);
    });

    it('8 · a long company name is still one run', () => {
      expect(runs('شركة جنوب القاهرة لتوزيع الكهرباء')).toEqual([
        'RTL:شركة جنوب القاهرة لتوزيع الكهرباء',
      ]);
    });

    it('9 · Arabic, a dash and a Latin reference order correctly', () => {
      expect(runs('وطنية - OFF 202601066')).toEqual(['LTR:OFF 202601066', 'RTL:وطنية - ']);
    });

    it('10 · Latin-only text is untouched, and never split', () => {
      expect(runs('Aweer Feeder Pillar')).toEqual(['LTR:Aweer Feeder Pillar']);
      expect(runs('OFF 202601066')).toEqual(['LTR:OFF 202601066']);
    });

    it('never reverses the characters inside a run', () => {
      // The whole basis of the approach: reordering happens between runs, so
      // the shaper still sees Arabic written the way Arabic is written.
      for (const value of ['وطنية 202601066', 'محول 1500 KVA', 'شركة جنوب القاهرة']) {
        for (const run of visualRuns(value)) {
          expect(value).toContain(run.text.replace(/[()]/g, (bracket) => bracket));
        }
      }
    });

    it('accounts for every character exactly once', () => {
      for (const value of [
        'وطنية',
        'مشروع ABC',
        'وطنية 202601066',
        'محول 1500 KVA',
        'وطنية - OFF 202601066',
        'شركة جنوب القاهرة لتوزيع الكهرباء',
      ]) {
        const drawn = visualRuns(value)
          .map((run) => run.text)
          .join('');
        expect(drawn.length).toBe(value.length);
        expect([...drawn].sort().join('')).toBe([...value].sort().join(''));
      }
    });
  });

  describe('drawing into a document', () => {
    const withDocument = <T>(use: (doc: PDFKit.PDFDocument) => T): T => {
      const doc = new PDFDocument({ autoFirstPage: false });
      registerPdfFonts(doc);
      doc.addPage();
      return use(doc);
    };

    it('embeds a font that can hold Arabic at all', () => {
      withDocument((doc) => {
        /*
         * The original defect, stated as a measurement. Helvetica — one of the
         * fourteen standard fonts the export used to draw with — measures the
         * committee name as nothing at all, because it has no glyph for a
         * single character of it. The embedded font measures it as text.
         */
        doc.font('Helvetica').fontSize(8);
        expect(doc.widthOfString('وطنية')).toBe(0);

        doc.font(PDF_FONT).fontSize(8);
        expect(doc.widthOfString('وطنية')).toBeGreaterThan(0);
        expect(doc.widthOfString('شركة جنوب القاهرة')).toBeGreaterThan(
          doc.widthOfString('وطنية'),
        );
      });
    });

    it('right-aligns an Arabic phrase and left-aligns an English one', () => {
      withDocument((doc) => {
        const drawn: Array<{ text: string; x: number }> = [];
        const original = doc.text.bind(doc);
        (doc as unknown as { text: unknown }).text = (
          text: string,
          x: number,
          y: number,
          options: unknown,
        ) => {
          drawn.push({ text, x });
          return original(text, x, y, options as never);
        };

        renderPdfText(doc, 'وطنية', { x: 0, y: 0, width: 200, size: 8, align: 'auto' });
        const arabicX = drawn.at(-1)!.x;

        drawn.length = 0;
        renderPdfText(doc, 'Aweer', { x: 0, y: 20, width: 200, size: 8, align: 'auto' });
        const latinX = drawn.at(-1)!.x;

        expect(latinX).toBe(0);
        expect(arabicX).toBeGreaterThan(100);
      });
    });

    it('keeps text inside the width it was given', () => {
      withDocument((doc) => {
        const measured = measurePdfText(doc, 'شركة جنوب القاهرة لتوزيع الكهرباء', {
          width: 60,
          size: 7,
          maxLines: 2,
        });
        // Too long for one line at that width, so it wraps rather than spilling.
        expect(measured.lines).toBe(2);
        expect(measured.height).toBeGreaterThan(0);
      });
    });

    it('reports nothing for an empty value', () => {
      withDocument((doc) => {
        expect(measurePdfText(doc, '', { width: 60 })).toEqual({ height: 0, lines: 0 });
        expect(renderPdfText(doc, '', { x: 0, y: 0, width: 60 })).toEqual({ height: 0, lines: 0 });
      });
    });
  });
});
