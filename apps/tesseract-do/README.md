# tesseract-do

> **Prototype.** Private, unpublished, APIs may change.

## What it is

**Tesseract OCR inside Durable Objects.** One ordinary Worker project (`wrangler.jsonc`,
`src/worker.ts`) whose `OcrCell` Durable Object runs [tesseract-wasm](https://github.com/robertknight/tesseract-wasm)
on an uploaded PNG or JPEG and answers with the words, their boxes and confidences. The same
project runs unchanged on **wrangler** (workerd), **cellb** (Node) and **celld** (Deno's
runtime, in Docker), and one scenario suite checks every runtime.

The question was whether this is possible at all, and under which limits. **It is**: OCR runs
in a Durable Object on all three runtimes with the same results as in a browser (99.3% word
recall on a 300 dpi two-column scan), within the platform's memory, CPU and size limits, once
three obstacles are dealt with (below).

It also converts whole **PDFs to PortableText** on the same runtimes (`POST /api/pdf`): pdf.js
runs in the Worker without a Web Worker or canvas, the text layer is laid out by the converter
library's canvas-free core (`@statewalker/pdf-portabletext/core`: headings, lists, tables,
bold/italic, invisible OCR layers, column-aware reading order), and every raster image is OCR'd
by the OCR cell of the document's language. JBIG2 and JPEG 2000 images decode through pdf.js's
own wasm decoders, precompiled. Long documents go to a **`PdfJob` Durable Object** of their own
(`POST /api/pdf/jobs`), which keeps the PDF and the results in its SQLite and converts one page
per alarm. See [PDF → PortableText](#pdf--portabletext) and [PDF jobs](#pdf-jobs-one-durable-object-per-document).

## How to run it

```sh
pnpm install                                            # at the repository root
pnpm --filter @statewalker/tesseract-do fixtures        # test images and models into fixtures/
pnpm --filter @statewalker/tesseract-do test            # unit + wrangler + cellb
pnpm --filter @statewalker/tesseract-do test:celld      # celld 0.6.0 in Docker (or CELLD_BIN)
```

`scripts/run-env.mjs <wrangler|cellb|celld>` starts the runtime on a free port with fresh state,
serves the models and `tesseract-core.wasm` from a local server that counts downloads, runs
`e2e/scenario.test.mjs` (OCR), `e2e/pdf.test.mjs` (PDF) and `e2e/jobs.test.mjs` (PDF jobs, the
last one left half-way), **restarts the runtime on the same state** and runs
`e2e/durability.test.mjs` (models from SQLite, the half-way job resumes and finishes). Metrics of each run land in `e2e-output/<runtime>.json`.

Interactively: `pnpm dev:wrangler` (port 8787) or `pnpm dev:cellb` (8788), then

```sh
curl --data-binary @fixtures/linn.png 'localhost:8787/api/ocr?lang=eng'
curl --data-binary @fixtures/typewriter.png 'localhost:8787/api/ocr?lang=nld&engine=isolate'
curl --data-binary @fixtures/multicolumn.pdf 'localhost:8787/api/pdf?lang=auto'
curl --data-binary @fixtures/linn.pdf 'localhost:8787/api/pdf?lang=eng&stream=1'
curl --data-binary @fixtures/GeoTopo.pdf 'localhost:8787/api/pdf/jobs?name=GeoTopo.pdf'   # → {id, status}
curl localhost:8787/api/pdf/jobs/<id>                 # progress: pagesDone / pageCount
curl localhost:8787/api/pdf/jobs/<id>/document
curl localhost:8787/api/runtime
```

| Route | Does |
| --- | --- |
| `POST /api/ocr?lang=eng[&cell=…][&band=rows][&engine=cell\|isolate]` | OCR of the body (PNG or JPEG, ≤ 20 MB) → `{text, words[{text, confidence, bbox}], meanConfidence, bands, wasmMemoryMiB, decodedMiB, model, cell, engine}` |
| `POST /api/pdf?lang=auto\|eng[&engine=cell\|isolate][&maxPages=n][&stream=1][&assets=inline]` | PDF (≤ 20 MB) → `{document}` (PortableText, the library's schema), with `assets=inline` also `{assets: {id: base64 PNG}}`; `stream=1`: NDJSON, one `page` event per page then `end` |
| `POST /api/pdf/jobs?lang=…[&engine=…][&maxPages=n][&pageConcurrency=n][&ocrCells=n][&throttleMs=ms][&name=…]` | PDF (≤ 64 MB, streamed in) → 202 `{id, status, …}`: a new `PdfJob` converts it in the background |
| `GET /api/pdf/jobs/:id` | `{status: queued\|running\|done\|failed\|cancelled, pageCount, pagesDone, language, failedPages, alarms, reads, …}` |
| `GET /api/pdf/jobs/:id/document[?assets=inline]` | the pages done so far as one document, `complete: true` once done |
| `GET /api/pdf/jobs/:id/pages/:n`, `GET /api/pdf/jobs/:id/assets/:assetId` | one page's blocks; one PNG asset |
| `POST /api/pdf/jobs/:id/cancel`, `DELETE /api/pdf/jobs/:id` | stop (keeping what is done); stop and remove everything |
| `GET /api/cells/:name` | the cell's loaded engines and the models in its SQLite |
| `GET /api/runtime` | what the runtime allows: wasm compilation from bytes, Worker Loader, image APIs |

Without `cell`, an image goes to its language's cell, `ocr-<lang>`: one model per cell, and
different languages in parallel cells, as in the browser prototype's one worker per language.
Deploy with `pnpm deploy` (`wrangler deploy -c wrangler.production.jsonc`, which adds the CPU
limit; set `MODEL_BASE_URL` and `WASM_URL` to where the files are served).

## The obstacles and how they are handled

1. **No wasm compilation from bytes.** workerd refuses `WebAssembly.compile` and
   `instantiate(buffer)`; wasm must be a module of the Worker. `tesseract-core.wasm` is a `.wasm`
   import (a compiled `WebAssembly.Module` on all three runtimes), and while the engine is created
   a scoped shim (`src/wasm-shim.ts`) answers Emscripten's `WebAssembly.instantiate(bytes, imports)`
   from that module, so tesseract-wasm runs unmodified. Its glue also resolves a URL against
   `import.meta.url` at load, which a bundled Worker lacks: `define` gives it a placeholder.
2. **No canvas.** Workers have no `OffscreenCanvas`, `ImageData` or `createImageBitmap`. PNG (every
   colour type and bit depth) and JPEG are decoded in JavaScript (`fast-png`, `jpeg-js`,
   `src/decode.ts`), and tesseract-wasm takes a plain `{ data, width, height }`.
3. **128 MB per isolate, wasm included**, and wasm memory never shrinks. Read in one pass, a
   300 dpi letter page took 87 MiB of wasm plus 34 MB of RGBA in JS; a 4000×2864 page 122 MiB
   of wasm alone. So:
   - the decoded image stays compact (a 1-bit scan is about 1 MB) and RGBA is produced **one band
     of rows at a time**;
   - large pages are read in **overlapping bands** (about 3 megapixels each, 120 rows of overlap);
     a word is kept from the band whose core holds its centre, so lines across an edge are read
     whole and once;
   - optionally the engine runs in a **Worker Loader isolate** (`engine=isolate`), apart from the
     Durable Object's isolate, which Durable Objects of one class may share.

Models (`<lang>.traineddata`, 1–6 MB) are fetched once and kept in the cell's own SQLite in 1 MiB
chunks (a row holds at most 2 MB), checked by SHA-256; a restarted or evicted cell reads them back
without downloading.

## Measurements

Same numbers on wrangler (workerd), cellb and celld: recognition is deterministic. Times are
wall-clock on this machine (the whole request), for wrangler / cellb / celld.

| Image | Bands | Words | Mean conf. | wasm peak | Decoded in JS | Time |
| --- | --- | --- | --- | --- | --- | --- |
| baiona map 640×682: RGB / gray / palette / alpha PNG | 1 | 19–20 | 0.51–0.59 | 27.8 MiB | 0.4–1.7 MiB | 0.2–0.9 s |
| c03-29.jpg 770×995 (JPEG) | 1 | 292 | 0.935 | 27.8 MiB | 2.2 MiB | 1.6 / 1.4 / 2.3 s |
| linn.png 2550×3300, 1-bit, two columns | 3 | 729 | 0.944 | **58.1 MiB** | 1.0 MiB | 6.6 / 7.0 / 8.0 s |
| same, one pass (`band=0`) | 1 | 729 | 0.945 | 87.4 MiB | 1.0 MiB | 6.8 s |
| typewriter.png 4000×2864, 1-bit, Dutch | 4 | 100 | 0.905 | **68.4 MiB** | 1.4 MiB | 3.6 / 4.0 / 5.5 s |
| same, one pass (`band=0`) | 1 | 101 | 0.908 | 121.6 MiB | 1.4 MiB | 2.7 s |

linn.png against its transcript: 99.3% of the words, 98.6% of the word pairs (reading order), the
same banded or not (800-row bands: 43 MiB, 99.3% / 98.2%). In a Worker Loader isolate the results
are identical. A warm engine skips about 0.4 s of model loading; after a restart the model comes
from SQLite (no download).

## PDF → PortableText

`src/pdf/` converts a PDF in the Worker's request, page by page, releasing each page before the
next (and, with `stream=1`, sending it at once):

- **pdf.js in-thread**: its worker module is loaded into the same isolate (`globalThis.pdfjsWorker`),
  with `isOffscreenCanvasSupported: false` and `isImageDecoderSupported: false`, so images come as
  raw pixels from pdf.js's own decoders, and no FontFace.
- **pdf.js's wasm decoders** (JBIG2, OpenJPEG, qcms) are normally fetched and compiled at runtime,
  with JS fallbacks imported from a URL; neither works in a Worker. They are imported as compiled
  modules, pdf.js's `BinaryDataFactory` hands it marker bytes instead of each file, and a
  marker-keyed `WebAssembly.instantiate` shim answers with the matching module.
- **Text**: the library core (`scanTextVisibility`, `extractTextRuns`, `layoutText`, `readingOrder`, …),
  the same code as in the browser: headings, lists, tables, bold/italic, invisible OCR text dropped.
- **Images**: raw pixels → PNG asset (fast-png) and, over RPC, OCR in the cell `ocr-<lang>`; the
  words come back with boxes in image pixels and become `ocrBox` marks (`ocrWordsToBlocks`).
- **Language**: `lang=auto` detects it from a text-only sample of the first pages (franc), else
  English; every image of the document is read with that model.

| PDF | Result | Time (wrangler / cellb / celld) |
| --- | --- | --- |
| multicolumn.pdf (LaTeX, 3 pages, a table) | 14 blocks, the 6×5 table with its header row | 0.3 / 0.3 / 0.2 s |
| GeoTopo.pdf, 6 pages (German LaTeX) | language `de` detected, 64 blocks, bold kept | 0.3 / 0.4 / 0.4 s |
| linn.pdf (one JBIG2 scan, 2550×3300) | 722 words, 99% recall against the transcript | 6.3 / 6.1 / 5.9 s |
| lichtenstein.pdf (JPEG 2000 photo) | 512×512 image extracted | 0.2 s |
| graph_ocred.pdf (chart + invisible OCR layer) | the layer dropped, the chart OCR'd once | 0.2 s |
| francais.pdf (`lang=fra`) | "capharnaüm", "qualité" read with diacritics | 0.4 s |

The same with `engine=isolate` (OCR in Worker Loader isolates). The bundle grows to 7.1 MB,
2.0 MB gzipped (pdf.js and its worker, the four wasm modules, franc): within 3 MB Free and 10 MB
Paid.

Differences from the browser converter: no page rendering (no canvas), so pages drawn only as
vectors are not OCR'd; images are stored as PNG (no original-JPEG passthrough); one language per
document (no per-image re-run); raw images over 24 MB are not sent to OCR (RPC message size).
Decoders matter more than expected: pdf.js's JPEG decoder and jpeg-js differ by 0.6 grey levels
on average on the book page `c03-29`, and that is enough for Tesseract to segment its decorated
first line differently (280 words from the PDF, 292 from the JPEG file).

## PDF jobs: one Durable Object per document

`POST /api/pdf` converts in the request, so a document must fit in one request's CPU budget (30 s
by default) and the client must stay connected. `POST /api/pdf/jobs` hands the PDF to a **`PdfJob`
Durable Object** (`src/pdf/pdf-job.ts`, a unique id per job) and returns at once:

- **Upload in parts**: the Worker re-cuts the request body into 1 MiB parts and appends each to the
  job's SQLite (`src/blob-store.ts`; rows hold ≤ 2 MB). Neither side holds the whole upload; a job
  takes PDFs up to 64 MB. An upload that is never started is removed after an hour.
- **Range reading**: pdf.js reads the PDF by byte ranges from SQLite (`openPdfRanges`, no
  auto-fetch), so only what the pages need is read: 1.2% of the 34 MB test file (a 3-page document
  with 32 MB of unused data). pdf.js still allocates one zero-filled buffer of the file's size for
  what it has read (its `ChunkedStream`), which is why the cap is 64 MB, not more.
- **A batch of pages per alarm** (`pageConcurrency`, default 4): an alarm is an invocation with its
  own CPU budget, so the number of pages is not bounded by any limit. The page's images are OCR'd
  in the language's cells over RPC, spread round-robin over a pool (`ocrCells`, default 2:
  `ocr-eng`, `ocr-eng-1`, …), outside the job's budget.
- Each page and its new PNG assets commit in **one transaction**, so a crash loses nothing and
  repeats nothing; a page finishing after a cancel or delete is not stored. A page that throws is
  retried after 2 s and 4 s, then recorded in `failedPages`; an unreadable PDF fails the job.
- Alarms are durable: after a **restart** the job reopens the PDF from SQLite and carries on with
  the pages not done (checked on all three runtimes by the durability suite).

| Job | wrangler / cellb / celld |
| --- | --- |
| GeoTopo.pdf, all 117 pages, 4 per alarm | 30 alarms; done in 8.5 / 5.2 / 6.3 s, 2880 blocks |
| big-34mb.pdf (3 pages + 32 MB unused) | streamed in; pdf.js read 393 KB of 33.9 MB in 5 range requests |
| scan-4.pdf (4 scanned pages at once, 3 OCR cells) | 99% recall per page, all 3 cells used; 17 s cellb / 24 s celld |
| linn.pdf (JBIG2 scan) | 99% recall, the PNG asset served by the job |
| 40 pages, 1 per alarm, runtime restarted after page 2 | resumed (PDF reopened), finished pages 1–40, none failed |
| cancel after page 1, then delete | no page after the cancel; the job is gone (404) |

Locally the concurrent batch is no faster than one page after another (4 × ≈ 4–6 s): cellb runs
every object on one event loop, and the local runtimes do not run objects in parallel. On
Cloudflare, cells are separate objects that can run on separate machines; that is not measured here.

## Platform limits, against what OCR needs

| Limit (Cloudflare docs, Nov 2026) | Value | This prototype |
| --- | --- | --- |
| Memory per isolate, JS heap + wasm | 128 MB | wasm ≤ 68 MiB per engine with bands, plus a few MB of image in JS and one band of RGBA (≈ 15 MB at 3 MP) |
| CPU per request (Durable Object invocation) | 30 s default, up to 300 000 ms (`limits.cpu_ms`, Paid) | 1.4–8 s per page here; `wrangler.production.jsonc` sets 120 000 ms |
| Worker size | 3 MB Free / 10 MB Paid (after compression) | OCR only: 2.1 MB, 807 KB gzip; with the PDF route: 7.1 MB, 2.0 MB gzip |
| Request body | 100 MB (Free/Pro) | capped at 20 MB |
| SQLite row / value (Durable Object) | 2 MB | models stored in 1 MiB chunks |
| SQLite storage per Durable Object | 10 GB (Paid) | a model is 1–6 MB |
| Runtime wasm compilation | not allowed | the wasm is a module (static import, or a Worker Loader `{ wasm }` module) |
| Threads / shared memory | no workers | tesseract-wasm is single-threaded; the SIMD build runs on all three runtimes |
| Dynamic Workers in flight per Durable Object | 10 | one isolate per language and cell |

## Constraints and caveats

- **Memory is the limit to watch, and it is not enforced locally.** wrangler, cellb and celld do
  not cap an isolate at 128 MB, so a page that fits here could still be killed in production. The
  wasm figures are measured (the instance's linear memory); the JS side is estimated. Keep
  `bandPixels` at about 3 MP (or lower) and the input under the 40 MP refusal threshold.
- **Durable Objects of one class can share an isolate**, and its 128 MB. Locally the `ocr-eng` and
  `ocr-nld` cells reported the same boot id. Two engines in one isolate are two wasm memories. The
  Worker Loader variant puts each language's engine in an isolate of its own; the Durable Object
  then holds only the encoded image and, while sending it once, the model.
- **wasm memory never shrinks**: an engine keeps its peak until its isolate goes. A retired OCR
  isolate cannot be terminated from the cell (the Worker Loader has no terminate); it runs until
  the runtime ends it.
- **Banding and reading order**: each band is laid out on its own. On the two-column scan the order
  was unaffected (98.6%), but a layout whose columns are much taller than a band can interleave.
- **Formats**: `/api/ocr` takes PNG and JPEG (no WebP or TIFF); `/api/pdf` takes PDFs, whose images
  pdf.js decodes (including JBIG2 and JPEG 2000).
- **celld 0.6**: refuses the `limits` and `env` config keys (hence `wrangler.production.jsonc`),
  and `WebAssembly.compile(bytes)` never settles there (`/api/runtime` reports `"hangs"`); OCR is
  unaffected because its wasm is a module.
- **cellb on Node**: every Durable Object runs on the one process's event loop, so a cell's OCR
  (seconds of synchronous wasm) also holds up other objects and HTTP requests meanwhile; a job's
  status poll waits for the page's OCR to end. (`serve-cellb.mjs` keeps idle sockets 120 s, past
  Node's default 5 s, which otherwise reset a poll arriving right after such a pause.)
- **cellb on Node**: a Worker Loader isolate is a worker thread that can see the host; fine here
  (no untrusted code runs), but not a sandbox.
- **Not deployed**: everything above ran on local runtimes; there was no Cloudflare account to
  measure production CPU time and memory enforcement.

## Files

| File | Role |
| --- | --- |
| `src/worker.ts` | HTTP routes |
| `src/ocr-cell.ts` | the `OcrCell` Durable Object: engines per language, model cache, both engines |
| `src/ocr.ts` | engine creation and banded recognition |
| `src/wasm-shim.ts` | `WebAssembly.instantiate(bytes)` answered from compiled modules (scoped for tesseract, marker-keyed for pdf.js) |
| `src/decode.ts` | PNG / JPEG decoding to compact sources with RGBA rows on demand |
| `src/models.ts` | model download and SQLite chunk cache |
| `src/isolate/program.ts`, `src/isolate-client.ts` | OCR in a Worker Loader isolate (`pnpm build:isolate` generates `program.gen.js`) |
| `src/pdf/pdfjs.ts`, `src/pdf/convert.ts` | pdf.js in-thread with precompiled decoders; PDF → PortableText page by page, OCR in the cells |
| `src/pdf/pdf-job.ts`, `src/blob-store.ts` | the `PdfJob` Durable Object (one page per alarm); byte strings of any size in SQLite |
| `scripts/run-env.mjs`, `scripts/serve-cellb.mjs` | runtimes under test |
| `scripts/fetch-fixtures.mjs` | test images (OCRmyPDF test resources, licenses in `fixtures/LICENSES.txt`) and models |
| `e2e/`, `test/` | scenario and durability suites per runtime; unit tests (decoding, banding) |

Sources for the limits: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Workers web standards (wasm restrictions)](https://developers.cloudflare.com/workers/runtime-apis/web-standards/),
[Wrangler bundling (`.wasm` imports)](https://developers.cloudflare.com/workers/wrangler/bundling/),
[Dynamic Workers limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/).
