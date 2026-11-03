# pdf-portabletext-prototype

> **Prototype.** Private, unpublished, APIs and output format may change.

Converts a PDF into [PortableText](https://www.portabletext.org/) entirely in the browser. No
server is involved: the file never leaves the page.

- **pdf.js** reads the text layer and turns it into paragraphs and headings (`h1`–`h3`, chosen by
  font size relative to the body text).
- **pdf.js** also finds the raster images painted on each page, with their placement on the page.
- **[tesseract-wasm](https://github.com/robertknight/tesseract-wasm)** recognises text in each image
  in Web Workers, **one worker per language** (`src/ocr-client.ts`, `src/ocr.worker.ts`): each
  worker loads its model once, workers for different languages run in parallel, and the UI stays
  responsive.
- **[franc](https://github.com/wooorm/franc)** (`franc-all`, trigram statistics, runs in the
  browser) **detects the language** of the text layer and of the OCR output; see
  [Language detection](#language-detection).
- Scans stored sideways or upside down are turned upright before OCR when that reads clearly
  better; word boxes are mapped back to the stored image.
- OCR text becomes PortableText blocks. Every recognised word is a span with an `ocrBox` mark that
  points at the source image and at the word's **bounding box in that image's pixels**.
- Images become `image` blocks with their pixel size, their bbox on the page and a reference to a
  binary asset (PNG, JPEG or WebP).
- Pages with neither text nor images (e.g. a scan drawn as vectors) can be rendered and OCR'd as a
  whole page.

## Run

```sh
pnpm install
pnpm --filter @statewalker/pdf-portabletext-prototype dev   # http://localhost:5181
```

Drop a PDF and press **Convert**. The language is auto-detected by default, with English as the
fallback; a fixed language can be picked instead. The **Preview** tab
renders the result with `@portabletext/to-html`; hovering a recognised word highlights its box in
the image. **Download ZIP** gives `document.json` plus `assets/*.png`.

OCR models (`<lang>.traineddata` from
[tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), 1–4 MB each) are downloaded on
first use and kept in Cache Storage. To self-host them, open the app with
`?models=https://your.host/tessdata/`.

## Language detection

All of it happens in the browser (`src/languages.ts`, `src/convert.ts`):

1. The whole text layer is classified with franc, restricted to the ~40 languages that have a
   tessdata model. It needs at least 200 letters, so a few stray characters (e.g. an invisible OCR
   layer of a chart) cannot decide the language of a scan.
2. Each image is first recognised with that document language, or with the fallback (English) when
   the document has no usable text layer and no image has been classified yet.
3. The OCR output, together with the page's text layer, is classified. If it is another language
   (and has at least 100 letters, so chart or map labels do not count), the image is recognised
   again by that language's worker; the second reading is kept unless it is clearly less
   confident. Every attempt is recorded in `image.ocr.attempts`.
4. Each text-layer block gets its own `language` when it is long enough to classify, otherwise the
   page's or the document's. `document.language` is the language covering the most text.

Very short texts and closely related languages (e.g. Russian vs. Bulgarian on a pangram) can be
misclassified; picking a fixed language in the UI skips detection.

## Output format

```jsonc
{
  "_type": "pdfDocument",
  "version": 1,
  "title": "sample-de",
  "language": "de",
  "pages": [{ "number": 1, "width": 595, "height": 842 }],
  "blocks": [
    // text from the PDF text layer; bbox in PDF points, top-left origin
    { "_type": "block", "_key": "p1-b0", "style": "h1", "markDefs": [],
      "language": "de",
      "children": [{ "_type": "span", "_key": "p1-s0", "text": "Beispieldokument", "marks": [] }],
      "source": { "type": "pdfText", "page": 1, "bbox": { "x": 50, "y": 38, "width": 206.71, "height": 30, "unit": "pt" } } },

    // an image: pixel size, placement on the page, reference to the binary asset
    { "_type": "image", "_key": "p1-img0",
      "asset": { "_type": "reference", "_ref": "image-0ad2…7132-900x272-png" },
      "width": 900, "height": 272, "mimeType": "image/png",
      "source": { "type": "pdfImage", "page": 1, "bbox": { "x": 80, "y": 152, "width": 420, "height": 126.93, "unit": "pt" } },
      "ocr": { "engine": "tesseract-wasm", "language": "de", "model": "deu", "languageSource": "detected",
               "attempts": [{ "model": "eng", "confidence": 0.938, "words": 19 }, { "model": "deu", "confidence": 0.966, "words": 19 }],
               "rotation": 0, "blocks": ["p1-b3"], "wordCount": 19, "confidence": 0.966, "durationMs": 1283 } },

    // text recognised in that image: one span per word, each marked with its bbox in image pixels
    { "_type": "block", "_key": "p1-b3", "style": "normal", "language": "de",
      "markDefs": [
        { "_type": "ocrBox", "_key": "p1-w0", "image": "p1-img0",
          "asset": { "_type": "reference", "_ref": "image-0ad2…7132-900x272-png" },
          "bbox": { "x": 37, "y": 46, "width": 144, "height": 33, "unit": "px" }, "confidence": 0.965 }
      ],
      "children": [{ "_type": "span", "_key": "p1-s3", "text": "Rechnung ", "marks": ["p1-w0"] }],
      "source": { "type": "ocr", "page": 1, "image": "p1-img0", "asset": { "…": "…" },
                  "bbox": { "x": 37, "y": 46, "width": 591, "height": 183, "unit": "px" }, "confidence": 0.966 } }
  ],
  "assets": {
    "image-0ad2…7132-900x272-png": {
      "_id": "image-0ad2…7132-900x272-png", "_type": "sanity.imageAsset",
      "mimeType": "image/png", "extension": "png", "size": 33822, "sha1hash": "0ad2…7132",
      "path": "assets/image-0ad2…7132-900x272-png.png",
      "metadata": { "dimensions": { "width": 900, "height": 272, "aspectRatio": 3.3088 } }
    }
  }
}
```

The full types are in [`src/schema.ts`](src/schema.ts). Notes:

- `blocks` is valid PortableText: standard renderers show the text and ignore `source`, `ocr` and
  the `ocrBox` marks unless given components for them.
- Asset ids follow the Sanity convention `image-<sha1>-<w>x<h>-<ext>`, so an image drawn several
  times is stored and OCR'd once.
- Keys are deterministic per page (`p<page>-<kind><n>`).
- `image.source.bbox` is the image's axis-aligned bounds on the page and may extend past the page
  edges (bleed, skewed scans). Images not drawn upright also carry `source.transform`, the matrix
  that maps the image's unit square onto the page.
- `image.ocr.rotation` is the clockwise rotation of the text inside the stored image (0, 90, 180,
  270). Word boxes are always in the stored image's pixels, whatever the rotation.
- Reading order within a page is top-to-bottom, then left-to-right: multi-column layouts are not
  detected.

## Layout

| File | Role |
| --- | --- |
| `src/pdf-extract.ts` | pdf.js: text runs, images with placement (CTM walk over the operator list), page rendering |
| `src/text-layout.ts` | Text runs → lines → paragraphs, heading detection |
| `src/ocr.worker.ts` | tesseract-wasm engine for one language (the worker's name); model caching, orientation |
| `src/ocr-client.ts` | Worker pool: one worker per language, created on demand, at most 4 kept |
| `src/languages.ts` | Supported languages (tesseract / franc / BCP 47 codes) and franc-based detection |
| `src/ocr-layout.ts` | OCR words → lines → paragraphs → PortableText blocks with `ocrBox` marks |
| `src/assets.ts` | Image encoding, SHA-1 asset ids, OCR up/downscaling |
| `src/convert.ts` | Orchestration: page by page, builds the document |
| `src/preview.ts` | `@portabletext/to-html` rendering with bbox overlays |
| `src/bundle.ts` | ZIP export (fflate) |

## Tests

```sh
pnpm test           # unit tests: layout, language detection, rotation mapping (vitest, Node)
pnpm fixture        # generates fixtures/sample-de.pdf (German text layer + 2 text images + vector-only page)
pnpm e2e            # converts the fixture in headless Chromium and checks the output
pnpm corpus:fetch   # downloads the openly licensed test corpus into fixtures/corpus/
pnpm corpus [name]  # converts every corpus PDF and checks it; writes e2e-output/corpus/report.md
```

The corpus (20 PDFs from the OCRmyPDF test resources and py-pdf/sample-files, each with its
license in [`scripts/corpus-manifest.ts`](scripts/corpus-manifest.ts)) covers English, French,
German and Dutch scans, JBIG2/CCITT/JPEG 2000/CMYK/palette images, rotated pages, sideways scans,
masks, charts, maps and text-layer documents. For each file it checks the detected language, the
OCR text (expected phrases, or word recall against a transcript), OCR rotation and placement, and
the integrity of every image (asset present, sizes consistent, placed on the page, decodable, not
blank). The latest results are in [CORPUS.md](CORPUS.md).

The browser scripts use Playwright's Chromium; set `CHROMIUM_PATH` to use another binary. They
download tessdata models, so they need network access.

## Limitations and next steps

- Images are decoded by pdf.js and re-encoded: the original JPEG/JPX bytes are not kept.
- Image masks (`paintImageMaskXObject`, e.g. stencil-masked scans) are skipped.
- OCR text is placed right after its image; no attempt is made to merge it into surrounding text.
- One language per image: an image mixing languages is read with its dominant language's model.
- Text set at an angle (e.g. 45° chart labels) is not recognised; only 90° steps are corrected.
- Each language worker holds its own wasm heap and model; the pool keeps at most four.
- The OCR engine sits behind a small message protocol (`src/ocr-protocol.ts`): swapping in a
  PaddleOCR-based engine such as [`@gutenye/ocr-browser`](https://github.com/gutenye/ocr) only
  needs a new worker that returns words with rects.
