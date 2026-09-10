# PDF fonts

`Cairo-Regular.ttf` and `Cairo-Bold.ttf`, from the [Cairo](https://github.com/Gue3bara/Cairo)
project, under the SIL Open Font License 1.1 (`OFL.txt`). The OFL permits
bundling and redistribution inside an application, which is why the files live
here rather than being fetched at run time.

## Why the export stopped using Helvetica

PDF's fourteen standard fonts — Helvetica among them — are encoded in Latin-1.
They have no Arabic in them at all, so a committee named `وطنية` reached the
page as whatever the encoder made of five unrepresentable codepoints: printable
Latin bytes that read as corrupted data rather than as a missing glyph
(BUG-014). Nothing was wrong with the value; the font could not hold it.

Cairo covers Latin, Arabic and the digits and punctuation the plan uses in one
file, so a cell mixing `محول 1500 KVA` needs no font switching mid-line and the
whole document keeps one set of metrics.

## Why these files are committed

The export must produce the same document on a developer's machine, in CI and
in the production image. A font resolved from the operating system would differ
between all three, and on the `node:24-bookworm-slim` base there is no Arabic
font installed at all. `Dockerfile` copies this directory into the runtime
image alongside `server/dist`.

Two weights, because the printed form uses bold for its title band and column
headings and nothing else.
