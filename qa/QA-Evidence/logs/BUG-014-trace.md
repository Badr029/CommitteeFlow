# BUG-014 — where `وطنية` stopped being `وطنية`

Traced before anything was changed, because "the Arabic is corrupted" and "the
Arabic cannot be printed" call for opposite fixes, and only one of them was
true. The value used throughout is the committee name on OFF 202601066 in the
September plan.

| Stage | What was read | Result |
|---|---|---|
| 1 · PostgreSQL | `SELECT committee, length(committee), octet_length(committee), encode(convert_to(committee,'UTF8'),'hex')` | `وطنية` · 5 characters · 10 bytes · `d988d8b7d986d98ad8a9` |
| 2 · Backend / API | `GET /api/bookings?month=2026-09`, codepoints of the `committee` field | `U+0648 U+0637 U+0646 U+064A U+0629` — identical |
| 3 · Export service input | the `Booking` handed to `buildPdf` | identical |
| 4 · Generated PDF | text-showing operators in the page's content stream | `d†7dfJb•` — bytes `64 86 37 64 66 4A 62 90` |

Stage 1 is correct UTF-8, in logical order: و ط ن ي ة. Stages 2 and 3 are
byte-identical to it. The value is intact right up to the moment it is drawn.

## Classification

**A PDF font and text-rendering defect. Not corrupted application data.**

Nothing was wrong with what was stored, returned, or passed to the export, so
nothing stored was repaired. Had this been treated as bad data, the "fix" would
have rewritten correct records and left the export just as broken.

## Cause

The export drew with Helvetica, one of PDF's fourteen standard fonts. Those are
Latin-1: they contain no Arabic glyph at all. Asked to set five codepoints it
has no glyphs for, the encoder emitted bytes anyway — and because they landed in
the printable Latin range, the output did not look like a rendering failure. It
looked like corrupted data, which is what made this worth ranking High rather
than Medium.

Measured directly, the same defect states itself in one line:

```
Helvetica         widthOfString('وطنية')  →  0
embedded font     widthOfString('وطنية')  →  17.178
```

## Two further faults behind the first

Embedding a font exposed two more, both of ordering rather than encoding:

1. **fontkit reverses an entire run** when it sees a right-to-left script.
   Correct for `وطنية`; wrong for `وطنية 202601066`, where the OFF number came
   out as `660106202`. Ordering mixed text is the Unicode Bidirectional
   Algorithm, which fontkit does not implement.

2. **PDFKit re-orders words.** Its `layout()` splits a string on spaces, shapes
   each word separately — it caches layouts per word — then concatenates the
   runs in the order the words were written. Invisible in Latin. In Arabic it
   silently undoes the reordering: each word came out correctly shaped, the
   words themselves stayed in logical order, and one space moved to the front of
   the line. Measured on `شركة جنوب القاهرة`:

   ```
   fontkit        584 300 796 295 639 275 269 | 220 | 790 578 294 555 | 220 | 578 625 1110
   PDFKit         220 | 578 625 1110 | 220 | 790 578 294 555 | 584 300 796 295 639 275 269
   ```

   The same glyphs, regrouped by word and re-concatenated in source order.

Both are addressed in `server/src/modules/export/pdf-text.ts`.

## Reproducing

```bash
node qa/tools/inspect-pdf-export.mjs <exported.pdf>
```

reports any run that reached the page mis-encoded. On a build carrying this
defect the September export yields three — one per Arabic committee name in the
month.
