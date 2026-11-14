# pdf-portabletext-prototype

> **Prototype.** Private, unpublished, APIs and output format may change.

Demo UI and test harness for [`@statewalker/pdf-portabletext`](../../packages/pdf-portabletext),
which converts a PDF into [PortableText](https://www.portabletext.org/) entirely in the browser
(text layer with formatting, lists and tables, column-aware reading order, images with OCR word
boxes, language detection, invisible OCR layers, streaming). See the package README for the API,
the output format and how it decides.

## Run

```sh
pnpm install
pnpm --filter @statewalker/pdf-portabletext-prototype dev   # http://localhost:5181
```

Drop a PDF and press **Convert**. Pages appear in the **Preview** tab as they are converted
(rendered with `@portabletext/to-html`; hovering a recognised word highlights its box in the
image), the log shows progress and memory. The options map to the library's: language
(auto-detect by default, English fallback), OCR engine (tesseract, or experimental PaddleOCR),
invisible text layer, image format (original JPEGs kept by default), page limit and more.
**Download ZIP** gives `document.json` plus `assets/*`. Open the app with
`?models=https://your.host/tessdata/` to self-host the tesseract models.

## Tests

```sh
pnpm fixture        # generates fixtures/sample-de.pdf (German text layer + 2 text images + vector-only page)
pnpm e2e            # converts the fixture in headless Chromium and checks the output
pnpm corpus:fetch   # downloads the openly licensed test corpus into fixtures/corpus/
pnpm corpus [names] # converts every corpus PDF (or those matching comma-separated names) and checks it
pnpm corpus --engine=paddle     # the same with PaddleOCR, into e2e-output/corpus-paddle/
pnpm corpus:md      # writes CORPUS.md from the reports (with the engine comparison)
```

The corpus ([`scripts/corpus-manifest.ts`](scripts/corpus-manifest.ts), with the source and license
of every file) has openly licensed PDFs from the OCRmyPDF test resources and py-pdf/sample-files,
plus fixtures built by the scripts here (CC0, `scripts/make-*.ts`): a two-column page drawn
line-interleaved, a formatting page (bold/italic, lists, a table), an image page (JPEG, PNG with
alpha, stencil mask), sideways scans and a 24-page scan. It covers English, French, German and
Dutch scans, JBIG2/CCITT/JPEG 2000/CMYK/palette images, rotated pages, masks, charts, maps,
invisible OCR layers, LaTeX documents and long documents.

For each file it checks what applies: detected language; OCR text (expected phrases, word recall
against a transcript, and word-pair recall for reading order); duplicated text; formatting
(marks, list items and levels, table shapes); image integrity (asset present, sizes consistent,
placed on the page, decodable, not blank), stored type, transparency and stencil flag; OCR
rotation and placement; page count and JS heap. The latest results are in [CORPUS.md](CORPUS.md).

Browser runs live in `e2e-browser/` (`e2e.ts`, `corpus.ts`), tools in `scripts/` (fixture
builders, corpus manifest and download, report writer); the library's unit tests are in
`packages/pdf-portabletext/test/` (`pnpm --filter @statewalker/pdf-portabletext test`).

The browser scripts use Playwright's Chromium; set `CHROMIUM_PATH` to use another binary. They
download tessdata models, so they need network access.

