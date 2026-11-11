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

## How to run it

```sh
pnpm install                                            # at the repository root
pnpm --filter @statewalker/tesseract-do fixtures        # test images and models into fixtures/
pnpm --filter @statewalker/tesseract-do test            # unit + wrangler + cellb
pnpm --filter @statewalker/tesseract-do test:celld      # celld 0.6.0 in Docker (or CELLD_BIN)
```

`scripts/run-env.mjs <wrangler|cellb|celld>` starts the runtime on a free port with fresh state,
serves the models and `tesseract-core.wasm` from a local server that counts downloads, runs
`e2e/scenario.test.mjs`, **restarts the runtime on the same state** and runs
`e2e/durability.test.mjs`. Metrics of each run land in `e2e-output/<runtime>.json`.

Interactively: `pnpm dev:wrangler` (port 8787) or `pnpm dev:cellb` (8788), then

```sh
curl --data-binary @fixtures/linn.png 'localhost:8787/api/ocr?lang=eng'
curl --data-binary @fixtures/typewriter.png 'localhost:8787/api/ocr?lang=nld&engine=isolate'
curl localhost:8787/api/runtime
```

| Route | Does |
| --- | --- |
| `POST /api/ocr?lang=eng[&cell=…][&band=rows][&engine=cell\|isolate]` | OCR of the body (PNG or JPEG, ≤ 20 MB) → `{text, words[{text, confidence, bbox}], meanConfidence, bands, wasmMemoryMiB, decodedMiB, model, cell, engine}` |
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

## Platform limits, against what OCR needs

| Limit (Cloudflare docs, Nov 2026) | Value | This prototype |
| --- | --- | --- |
| Memory per isolate, JS heap + wasm | 128 MB | wasm ≤ 68 MiB per engine with bands, plus a few MB of image in JS and one band of RGBA (≈ 15 MB at 3 MP) |
| CPU per request (Durable Object invocation) | 30 s default, up to 300 000 ms (`limits.cpu_ms`, Paid) | 1.4–8 s per page here; `wrangler.production.jsonc` sets 120 000 ms |
| Worker size | 3 MB Free / 10 MB Paid (after compression) | 2.1 MB, 807 KB gzip (the 1.8 MB wasm included) |
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
- **Formats**: PNG and JPEG only (no WebP, TIFF or PDF); PDF pages would need pdf.js without canvas
  or a rasteriser.
- **celld 0.6**: refuses the `limits` and `env` config keys (hence `wrangler.production.jsonc`),
  and `WebAssembly.compile(bytes)` never settles there (`/api/runtime` reports `"hangs"`); OCR is
  unaffected because its wasm is a module.
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
| `src/wasm-shim.ts` | `WebAssembly.instantiate(bytes)` answered from a compiled module |
| `src/decode.ts` | PNG / JPEG decoding to compact sources with RGBA rows on demand |
| `src/models.ts` | model download and SQLite chunk cache |
| `src/isolate/program.ts`, `src/isolate-client.ts` | OCR in a Worker Loader isolate (`pnpm build:isolate` generates `program.gen.js`) |
| `scripts/run-env.mjs`, `scripts/serve-cellb.mjs` | runtimes under test |
| `scripts/fetch-fixtures.mjs` | test images (OCRmyPDF test resources, licenses in `fixtures/LICENSES.txt`) and models |
| `e2e/`, `test/` | scenario and durability suites per runtime; unit tests (decoding, banding) |

Sources for the limits: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Workers web standards (wasm restrictions)](https://developers.cloudflare.com/workers/runtime-apis/web-standards/),
[Wrangler bundling (`.wasm` imports)](https://developers.cloudflare.com/workers/wrangler/bundling/),
[Dynamic Workers limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/).
