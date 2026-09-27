# P7: EmbedPDF inside Theia, offline

**Question.** Can [EmbedPDF](https://www.embedpdf.com/) (`@embedpdf/snippet`, PDFium
compiled to WebAssembly) be bundled by Theia's esbuild and render a PDF read from
the `FilesApi`, with no request leaving the app?

**Answer: yes, with four settings.** The viewer lives where the app uses it, in
[`packages/theia-pdf-viewer`](../../packages/theia-pdf-viewer). This folder is
its test harness: a `MemFilesApi` holding a PDF produced by `createTextPdf`, so
no binary fixture is checked in.

| Problem | Fix |
|---|---|
| **PDFium's wasm.** By default it is fetched from jsDelivr. Its local fallback, `new URL("pdfium.wasm", import.meta.url)`, breaks in Theia's bundle, because esbuild's non-ESM output has no `import.meta.url`. | `import pdfiumWasm from "@embedpdf/snippet/dist/pdfium.wasm"`. **Theia's generated esbuild config already loads `.wasm` as a `dataurl`**, so the 4.6 MB wasm ships inside `bundle.js` and is passed as `wasmUrl`. There is no copy step, and it works under any deploy path. |
| **The worker.** | Nothing to do. The snippet inlines its worker as a `blob:` URL. |
| **Fonts.** The UI font comes from Google Fonts, and the fallback fonts for non-Latin scripts come from jsDelivr. | `fonts: { ui: null, signature: null }` and `fontFallback: null`. PDFium's built-in base-14 fonts still render standard PDFs. |
| **Stamps.** The stamp plugin's *default config* lists a manifest on jsDelivr. `defaultLibrary: false` did **not** stop the request (red run 3). | `stamp: { manifests: [] }`. |

The bytes come from Theia's `FileService`, so they are read from the
`FilesApi`, and reach the viewer as a `blob:` URL.

## Costs

- `bundle.js` grows from 24 MB to 37.5 MB in development mode: the snippet
  (about 2 MB of JS) plus the wasm encoded as base64.
- Another option is to emit the wasm as a file, by changing the loader in the
  app's editable `esbuild.mjs`. That keeps the bundle smaller but ties the
  extension to that app's build.

## Red / green

- Red 1: an empty module. `.pdf-viewer-widget` was not found.
- Red 2: the page rendered, but `https://cdn.jsdelivr.net/npm/@embedpdf/default-stamps/en/manifest.json`
  was requested.
- Red 3: the same request with `stamp: { defaultLibrary: false }`. The URL
  comes from the plugin's default `manifests`.
- Green: `✓ a PDF from the FilesApi renders in EmbedPDF, offline (5.6s)`. The
  test asserts a rendered page (`img[src^="blob:"]`), no page errors, and no
  request other than to the app's own origin, `blob:` or `data:`.
