# @theia-shell/theia-pdf-viewer

A Theia extension that opens `.pdf` files in [EmbedPDF](https://www.embedpdf.com/)
(`@embedpdf/snippet`): PDFium compiled to WebAssembly, running in a Web Worker,
with EmbedPDF's toolbar (pages, zoom, pan, search, thumbnails, print). It is
independent of the other packages; add it to a Theia app's dependencies.

**It is fully offline.** Prototype [P7](../../protos/p7-embedpdf) established how:

- PDFium's wasm is embedded in the bundle. `import … from "@embedpdf/snippet/dist/pdfium.wasm"`
  works because Theia's esbuild loads `.wasm` as a data URL. The result is
  passed as `wasmUrl`.
- The fallback fonts from jsDelivr, Google Fonts and the stamp manifest are
  switched off: `fontFallback: null`, `fonts: { ui: null, signature: null }`,
  `stamp: { manifests: [] }`.
- The PDF's bytes come from Theia's `FileService`, as a `blob:` URL.

Other behaviour:

- Priority 500 for `.pdf` (the text editor has 100).
- It reloads when the file changes (a new EmbedPDF instance; page and zoom
  reset). If the file can no longer be read, it says so.
- It is `Navigatable`, like a text editor. *Open Editors* lists it, the
  explorer reveals its file when it becomes active, a rename or move re-opens
  it at the new name, and deleting the file from the explorer closes it.
- The viewer's theme follows Theia's light/dark theme.
- Annotation and redaction are off, because this is a viewer. Writing edits back
  to the file is a later step: EmbedPDF can export the modified document, which
  would be saved through the `FileService`.

It also exports `createTextPdf(lines)`, which writes a minimal valid one-page PDF.
The app's sample file and the tests use it, so no binary fixture is needed.

Cost: about 2 MB of JS plus the 4.6 MB wasm (base64 in the bundle).

Styling is Tailwind utility classes coloured by the shadcn/ui tokens. The app
compiles them, as [`app/style`](../../app/style) does. In an app without that
build, the classes have no CSS and the layout falls apart.

Tests: `pnpm test` runs 5 unit tests. The e2e tests are in P7 and in
[`app/tests/viewers.spec.ts`](../../app/tests/viewers.spec.ts).
