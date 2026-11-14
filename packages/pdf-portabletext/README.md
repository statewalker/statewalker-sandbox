# @statewalker/pdf-portabletext

> **Prototype.** Private, unpublished, APIs and output format may change.

Converts a PDF into [PortableText](https://www.portabletext.org/) entirely in the browser: the
file never leaves the page. The demo UI and test harness live in
[apps/pdf-portabletext-prototype](../../apps/pdf-portabletext-prototype).

What it does:

- **Text layer** (pdf.js): paragraphs and headings (`h1`–`h3` by font size), **bold / italic**
  spans (`strong` / `em`, from font flags and names, TeX fonts included), **lists** (bullet and
  numbered, nesting from indentation) and simple **tables** (`table` blocks in the
  `@sanity/table` shape, header rows from bold text).
- **Reading order**: recursive XY-cut over each page's blocks, so multi-column pages read column by
  column, whatever order the PDF draws its lines in.
- **Images** (pdf.js): every raster image with its pixel size and placement on the page, including
  1-bit **stencil masks**; transparency is kept. With `imageFormat: "original"` plain JPEGs are
  stored **byte for byte** (found with pdf-lib), everything else as PNG.
- **OCR** in Web Workers: [tesseract-wasm](https://github.com/robertknight/tesseract-wasm) with
  **one worker per language**, or (experimental) PaddleOCR through
  [gutenye/ocr](https://github.com/gutenye/ocr). Every recognised word is a span whose `ocrBox`
  mark gives its **bounding box in the image's pixels**. Sideways scans are turned upright.
- **Language detection** with [franc](https://github.com/wooorm/franc) (`franc-all`), in the
  browser: the text layer sets where OCR starts, the OCR output can switch the model.
- **Invisible OCR layers** (text in rendering mode 3, left by OCRmyPDF, scanners, Acrobat) are
  detected: replaced by our own OCR so text is not output twice, or reused as the OCR result.
- **Streaming**: `convertPdfStream` yields one page at a time and releases it, so long documents
  convert in bounded memory.

## Use

```ts
// vite.config.ts
import { pdfPortableText } from "@statewalker/pdf-portabletext/vite";
export default defineConfig({ plugins: [pdfPortableText()] });
```

The plugin serves (and copies into the build) the files loaded at runtime: pdf.js decoders,
CMaps, fonts and ICC profiles under `<base>pdfjs/`, onnxruntime's wasm under `<base>ort/`, and
makes the tesseract and PaddleOCR binaries importable.

```ts
import { convertPdf, convertPdfStream, createOcrPool } from "@statewalker/pdf-portabletext";

const ocr = createOcrPool(); // { engine: "paddle" } for PaddleOCR
const options = {
  language: "auto", // or a tesseract code: "eng", "deu", …
  fallbackLanguage: "eng",
  imageFormat: "original", // "png" | "jpeg" | "webp"
  ocrImages: true,
  ocrEmptyPages: true,
  minImageSize: 48,
  minConfidence: 0.3,
};

// Whole document:
const { document, blobs } = await convertPdf(file, ocr, options);

// Or page by page:
for await (const event of convertPdfStream(file, ocr, options)) {
  if (event.type === "page") render(event.blocks, event.assets);
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `language` | – | `auto` (detect) or a tesseract model code |
| `fallbackLanguage` | `eng` | Model used in `auto` mode until a language is known |
| `imageFormat` | – | `original` keeps plain JPEGs, else PNG; or always `png` / `jpeg` / `webp` |
| `ocrImages` | – | OCR embedded images |
| `ocrEmptyPages` | – | Render and OCR pages with neither text nor images |
| `detectOrientation` | `true` | Turn sideways / upside-down scans upright |
| `invisibleText` | `replace` | Invisible text layer: `replace` (own OCR), `reuse` (as OCR, no tesseract), `keep` |
| `minImageSize` | – | Smaller images (px) are ignored |
| `minConfidence` | – | OCR words below it are dropped |
| `maxPages` | all | Convert only the first pages |
| `onLog`, `onProgress`, `signal` | – | Progress messages, OCR progress, cancellation |

OCR models (`<lang>.traineddata` from
[tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), 1–4 MB each) are downloaded on
first use and cached; `createOcrPool({ modelBaseUrl })` self-hosts them. PaddleOCR's models (16 MB)
ship with the package and are served by the app.

## Output

```jsonc
{
  "_type": "pdfDocument",
  "version": 1,
  "title": "sample-de",
  "language": "de",
  "pages": [{ "number": 1, "width": 595, "height": 842 }],
  "blocks": [
    // text layer: bbox in PDF points, top-left origin; decorators on spans
    { "_type": "block", "_key": "p1-b1", "style": "normal", "language": "en", "markDefs": [],
      "children": [
        { "_type": "span", "_key": "p1-s1", "text": "This sentence has ", "marks": [] },
        { "_type": "span", "_key": "p1-s2", "text": "bold words", "marks": ["strong"] }],
      "source": { "type": "pdfText", "page": 1, "bbox": { "x": 50, "y": 91, "width": 297.78, "height": 13.75, "unit": "pt" } } },

    // list item (standard PortableText fields)
    { "_type": "block", "_key": "p1-b2", "style": "normal", "listItem": "bullet", "level": 2, "…": "…" },

    // table (@sanity/table shape)
    { "_type": "table", "_key": "p1-t0", "headerRows": 1,
      "rows": [{ "_type": "tableRow", "_key": "p1-r0", "cells": ["Country", "Capital"] }],
      "source": { "type": "pdfText", "page": 1, "bbox": { "…": "…" } } },

    // image: pixel size, placement, asset reference, OCR summary
    { "_type": "image", "_key": "p1-img0",
      "asset": { "_type": "reference", "_ref": "image-fedd…147c-900x300-jpg" },
      "width": 900, "height": 300, "mimeType": "image/jpeg",
      "source": { "type": "pdfImage", "page": 1, "bbox": { "x": 50, "y": 92, "width": 450, "height": 150, "unit": "pt" } },
      "ocr": { "engine": "tesseract-wasm", "language": "en", "model": "eng", "languageSource": "default",
               "attempts": [{ "model": "eng", "confidence": 0.963, "words": 3 }],
               "rotation": 0, "blocks": ["p1-b3"], "wordCount": 3, "confidence": 0.963, "durationMs": 957 } },

    // text recognised in that image: one span per word, each with its bbox in image pixels
    { "_type": "block", "_key": "p1-b3", "style": "normal", "language": "en",
      "markDefs": [{ "_type": "ocrBox", "_key": "p1-w0", "image": "p1-img0",
                     "asset": { "_type": "reference", "_ref": "image-fedd…147c-900x300-jpg" },
                     "bbox": { "x": 62, "y": 131, "width": 184, "height": 51, "unit": "px" }, "confidence": 0.961 }],
      "children": [{ "_type": "span", "_key": "p1-s3", "text": "Original ", "marks": ["p1-w0"] }],
      "source": { "type": "ocr", "page": 1, "image": "p1-img0", "…": "…" } }
  ],
  "assets": {
    "image-fedd…147c-900x300-jpg": {
      "_id": "image-fedd…147c-900x300-jpg", "_type": "sanity.imageAsset",
      "mimeType": "image/jpeg", "extension": "jpg", "size": 13069, "sha1hash": "fedd…147c",
      "path": "assets/image-fedd…147c-900x300-jpg.jpg",
      "metadata": { "dimensions": { "width": 900, "height": 300, "aspectRatio": 3 } }
    }
  }
}
```

The types are in [`src/schema.ts`](src/schema.ts). Notes:

- `blocks` is valid PortableText: standard renderers show text, lists and decorators and ignore
  `source`, `ocr` and the `ocrBox` marks unless given components for them (`table` needs one, as
  with `@sanity/table`).
- Asset ids follow the Sanity convention `image-<sha1>-<w>x<h>-<ext>`: an image drawn several times
  is stored and OCR'd once.
- `image.source.bbox` may extend past the page (bleed, skewed scans); images not drawn upright also
  carry `source.transform`, the matrix mapping the image's unit square onto the page. Stencil masks
  have `source.stencil: true`.
- `image.ocr.rotation` is the clockwise rotation of the text inside the stored image; word boxes
  are always in the stored image's pixels.

## How it decides

**Language.** A text-only sample of the first 20 pages (≥ 200 letters, so a stray OCR layer does
not count) gives the document language; images are first read in it, or in the fallback. If the
OCR output plus the page's text (≥ 100 letters, so chart labels do not count) is another language,
that language's worker reads the image again; the second reading is kept unless clearly less
confident. Every attempt is in `image.ocr.attempts`.

**Orientation.** Tesseract's estimate can be confidently wrong on upright maps and charts, so a
turned reading is only tried when the upright one is poor (< 45%) or mostly vertical words, and
only kept when it reads well (≥ 60%) and better.

**Reading order.** A region splits into columns where a gutter runs through all of it, otherwise
into row bands; neighbouring bands that share a gutter are merged again, so aligned paragraph
breaks and short column tails do not interleave columns. Lines are not joined across gaps wider
than 1.5 em, and paragraphs are grouped by geometry, not stream order.

**Tables.** Rows (lines on one baseline) of two or more short cells (≤ 40 characters, so two
columns of prose are not a table) over consecutive lines, with columns taken from the rows with
the most cells; cells are filled piece by piece so closely set columns stay apart.

**Original JPEGs.** A stream is kept when DCTDecode is its only filter, it is 8-bit gray or RGB
with no /Decode, /SMask or /Mask, it matches an extracted image's page and size, and the browser's
decoding of it matches pdf.js's pixels. CMYK JPEGs are converted.

## Files

| File | Role |
| --- | --- |
| `src/convert.ts` | Orchestration, streamed page by page |
| `src/pdf-extract.ts` | pdf.js: text runs with styles and visibility, images and stencil masks with placement, page rendering |
| `src/text-layout.ts` | Runs → lines → paragraphs, lists, tables, headings, styled spans |
| `src/reading-order.ts` | XY-cut reading order |
| `src/original-images.ts` | Original JPEG streams (pdf-lib) |
| `src/text-layer-ocr.ts` | Invisible text layer → OCR words in image pixels |
| `src/ocr-client.ts` | Worker pool: one worker per language (tesseract) or one PaddleOCR worker |
| `src/ocr.worker.ts` / `src/paddle.worker.ts` | OCR engines |
| `src/ocr-layout.ts` | OCR words → paragraphs → blocks with `ocrBox` marks; rotation mapping |
| `src/languages.ts` | Supported languages and franc detection |
| `src/assets.ts`, `src/bundle.ts`, `src/preview.ts` | Assets, ZIP export, HTML preview |
| `vite.ts` | Vite plugin |

`pnpm test` runs the unit tests (layout, lists, tables, reading order, language detection,
invisible text, rotation mapping).

## Limitations

- OCR text is placed after its image; it is not merged into surrounding text.
- One language per image; text at angles other than 90° steps is not recognised.
- Tables need visibly aligned short cells; ruled tables with wrapped cell text are read as text.
- PaddleOCR (experimental) has no word boxes (lines are split in proportion), no diacritics, its
  own line detection can merge lines across a column gutter, and it is much slower than tesseract
  in single-threaded wasm; see the app's CORPUS.md for numbers.
