# pdf-portabletext-prototype

> **Prototype.** Private, unpublished, APIs and output format may change.

Converts a PDF into [PortableText](https://www.portabletext.org/) entirely in the browser. No
server is involved: the file never leaves the page.

- **pdf.js** reads the text layer and turns it into paragraphs and headings (`h1`–`h3`, chosen by
  font size relative to the body text).
- **pdf.js** also finds the raster images painted on each page, with their placement on the page.
- **[tesseract-wasm](https://github.com/robertknight/tesseract-wasm)** recognises text in each image
  in a **dedicated Web Worker** (`src/ocr.worker.ts`), so the UI stays responsive.
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

Drop a PDF, pick the OCR language (German by default), press **Convert**. The **Preview** tab
renders the result with `@portabletext/to-html`; hovering a recognised word highlights its box in
the image. **Download ZIP** gives `document.json` plus `assets/*.png`.

OCR models (`<lang>.traineddata` from
[tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), 1–4 MB each) are downloaded on
first use and kept in Cache Storage. To self-host them, open the app with
`?models=https://your.host/tessdata/`.

## Output format

```jsonc
{
  "_type": "pdfDocument",
  "version": 1,
  "title": "sample-de",
  "pages": [{ "number": 1, "width": 595, "height": 842 }],
  "blocks": [
    // text from the PDF text layer; bbox in PDF points, top-left origin
    { "_type": "block", "_key": "p1-b0", "style": "h1", "markDefs": [],
      "children": [{ "_type": "span", "_key": "p1-s0", "text": "Beispieldokument", "marks": [] }],
      "source": { "type": "pdfText", "page": 1, "bbox": { "x": 50, "y": 38, "width": 206.71, "height": 30, "unit": "pt" } } },

    // an image: pixel size, placement on the page, reference to the binary asset
    { "_type": "image", "_key": "p1-img0",
      "asset": { "_type": "reference", "_ref": "image-0ad2…7132-900x272-png" },
      "width": 900, "height": 272, "mimeType": "image/png",
      "source": { "type": "pdfImage", "page": 1, "bbox": { "x": 80, "y": 152, "width": 420, "height": 126.93, "unit": "pt" } },
      "ocr": { "engine": "tesseract-wasm", "language": "deu", "blocks": ["p1-b3"], "wordCount": 19, "confidence": 0.966, "durationMs": 1283 } },

    // text recognised in that image: one span per word, each marked with its bbox in image pixels
    { "_type": "block", "_key": "p1-b3", "style": "normal",
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
- Reading order within a page is top-to-bottom, then left-to-right: multi-column layouts are not
  detected.

## Layout

| File | Role |
| --- | --- |
| `src/pdf-extract.ts` | pdf.js: text runs, images with placement (CTM walk over the operator list), page rendering |
| `src/text-layout.ts` | Text runs → lines → paragraphs, heading detection |
| `src/ocr.worker.ts` | tesseract-wasm engine in a dedicated worker; model download and caching |
| `src/ocr-client.ts` | Promise API over the worker |
| `src/ocr-layout.ts` | OCR words → lines → paragraphs → PortableText blocks with `ocrBox` marks |
| `src/assets.ts` | Image encoding, SHA-1 asset ids, OCR upscaling |
| `src/convert.ts` | Orchestration: page by page, builds the document |
| `src/preview.ts` | `@portabletext/to-html` rendering with bbox overlays |
| `src/bundle.ts` | ZIP export (fflate) |

## Tests

```sh
pnpm test        # unit tests for the layout code (vitest, Node)
pnpm fixture     # generates fixtures/sample-de.pdf (German text layer + 2 text images + vector-only page)
pnpm e2e         # converts the fixture in headless Chromium and checks the output
```

`fixture` and `e2e` use Playwright's Chromium; set `CHROMIUM_PATH` to use another binary. `e2e`
downloads the `deu` model, so it needs network access.

## Limitations and next steps

- Images are decoded by pdf.js and re-encoded: the original JPEG/JPX bytes are not kept.
- Image masks (`paintImageMaskXObject`, e.g. stencil-masked scans) are skipped.
- OCR text is placed right after its image; no attempt is made to merge it into surrounding text.
- tesseract-wasm loads one model at a time, so mixed-language documents use a single language.
- The OCR engine sits behind a small message protocol (`src/ocr-protocol.ts`): swapping in a
  PaddleOCR-based engine such as [`@gutenye/ocr-browser`](https://github.com/gutenye/ocr) only
  needs a new worker that returns words with rects.
