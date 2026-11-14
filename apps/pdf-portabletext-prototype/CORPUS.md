# Test corpus results

Output of `pnpm corpus:fetch && pnpm corpus` (headless Chromium, language auto-detected with
English as the fallback, tesseract OCR, original JPEGs kept). **28/28 runs pass.**
Sources and licenses of every file are in
[`scripts/corpus-manifest.ts`](scripts/corpus-manifest.ts); downloaded files are not committed,
built fixtures come from `scripts/make-*.ts`.

Columns: detected document language; number of image blocks; for each image the model whose
reading was kept and how it was chosen (`detected` from the OCR text, `document` from the text
layer or earlier pages, `default` = fallback English; `after a→b` lists the models tried), the
rotation corrected before OCR and the mean word confidence; checks (recall = share of transcript
words found, order = share of transcript word pairs found).

| File | What it exercises | Lang | Images | OCR (model, source, rotation, conf.) | Time | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| [linn.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/linn.pdf) | two-column English scan with ground truth | en | 1 | eng (detected) 95% | 7.8s | ✓ language en; images 1; image integrity; recall 99.0% (min 90%); order 98.3% (min 85%) |
| [jbig2.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/jbig2.pdf) | JBIG2-encoded scan (pdf.js wasm decoder) | en | 1 | eng (detected) 95% | 6.7s | ✓ language en; images 1; image integrity; recall 98.9% (min 90%) |
| [ccitt.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/ccitt.pdf) | CCITT G4 fax-encoded scan | en | 1 | eng (detected) 95% | 7.5s | ✓ language en; images 1; image integrity; recall 99.0% (min 90%) |
| [cardinal.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/cardinal.pdf) | the same scan on pages displayed at 0°, 90°, 180° and 270° | en | 4 | eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95% | 8.1s | ✓ language en; images 4; image integrity; placement 0/90/180/270; recall p1 99.0% (min 85%); recall p2 99.0% (min 85%); recall p3 99.0% (min 85%); recall p4 99.0% (min 85%) |
| [linn-rotated-pixels.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/linn.png) | scan whose pixels are stored sideways/upside down: OCR orientation detection | en | 3 | eng (detected) 90° 95%<br>eng (detected) 180° 95%<br>eng (detected) 270° 95% | 35.5s | ✓ language en; images 3; image integrity; rotations 90/180/270; recall p1 99.0% (min 85%); recall p2 99.0% (min 85%); recall p3 99.0% (min 85%) |
| [columns-en.pdf](scripts/make-columns.ts) | two columns drawn line-interleaved, aligned paragraph breaks, longer left column | en | 0 | - | 0.9s | ✓ language en; recall 100.0% (min 98%); order 100.0% (min 95%) |
| [formatting-en.pdf](scripts/make-formatting.ts) | inline bold/italic, bullet + nested + numbered lists, a table with header | en | 0 | - | 0.8s | ✓ language en; strong "bold words"; strong "Formatting Test"; em "italic words"; bullet items 4; number items 3; list levels 2; tables 4×3/h1; contains "The end of the formatting test." |
| [images-en.pdf](scripts/make-images.ts) | JPEG kept byte for byte, PNG with alpha (soft mask), 1-bit stencil mask | en | 3 | eng (default) 96%<br>eng (default) 97%<br>eng (default) 97% | 1.1s | ✓ images 3; image integrity; image types jpeg, png+alpha, png+alpha+stencil; contains "Original JPEG photo"; contains "Transparent label text"; contains "Stencil mask scan" |
| [multicolumn.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/026-latex-multicolumn/multicolumn.pdf) | LaTeX two-column article (lorem ipsum) and a table | ca | 0 | - | 0.8s | ✓ tables 6×5/h1; recall 99.9% (min 98%); order 99.8% (min 95%) |
| [skew.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/skew.pdf) | slightly skewed scan | en | 1 | eng (detected) 95% | 7.1s | ✓ language en; images 1; image integrity; recall 99.0% (min 80%) |
| [c03-29.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/c03-29.pdf) | old book scan with an illustration and decorative initial | en | 1 | eng (detected) 95% | 2.8s | ✓ language en; images 1; image integrity; contains "Miss Watson"; contains "MISS WATSON’S LECTURE" |
| [francais.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/francais.pdf) | French scan with diacritics: language detection switches the OCR model | fr | 1 | fra (detected after eng→fra) 91% | 2.6s | ✓ language fr; images 1; image integrity; rotations 0; contains "vieux whisky"; contains "capharnaüm"; contains "qualité" |
| [masks.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/masks.pdf) | German printout scanned with explicit masks | de | 2 | eng (default) 0%<br>deu (detected after eng→deu) 94% | 10.5s | ✓ language de; images 2; image integrity; rotations 0/0; contains "Betriebssystem" |
| [epson.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/epson.pdf) | English printout scanned by an office printer | en | 1 | eng (detected) 93% | 5.0s | ✓ language en; images 1; image integrity; contains "optical character recognition" |
| [2400dpi.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/2400dpi.pdf) | Dutch typewriter text in a 2400 dpi image | nl | 1 | nld (detected after eng→nld) 91% | 5.7s | ✓ language nl; images 1; image integrity; rotations 0; contains "Linzensoep"; contains "kruidnagel"; contains "de linzen" |
| [palette.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/palette.pdf) | palette (indexed colour) image of a map with Basque/French labels | en | 1 | eng (default after eng→eus) 84% | 3.5s | ✓ images 1; image integrity; rotations 0; contains "Komunikabideak"; contains "Milafranga"; contains "Hiriburu" |
| [graph.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/graph.pdf) | line graph with slanted labels | en | 1 | eng (default) 84% | 1.3s | ✓ images 1; image integrity |
| [graph_ocred.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/graph_ocred.pdf) | chart with an invisible OCR text layer: replaced by own OCR, no duplicates | en | 1 | eng (default) 75% | 1.3s | ✓ images 1; image integrity; "Percentage" ≤ 1× 1×; "Oppose" ≤ 1× 1×; engine tesseract-wasm; contains "Percentage" |
| [graph_ocred-reuse](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/graph_ocred.pdf) | the same, reusing the invisible layer as OCR (no tesseract) | en | 1 |  (document) 100% | 0.8s | ✓ images 1; image integrity; "Percentage" ≤ 1× 1×; "Oppose" ≤ 1× 1×; engine pdf-text-layer; contains "Percentage" |
| [lichtenstein.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/lichtenstein.pdf) | JPEG 2000 photo (pdf.js OpenJPEG wasm decoder), no text | - | 1 | eng (default) 0% | 1.5s | ✓ images 1; image integrity |
| [multipage.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/multipage.pdf) | six pages mixing scans, a blank page and an invisible OCR layer | en | 6 | eng (detected) 95%<br>eng (document) 79%<br>eng (document) 84%<br>eng (document) 75%<br>eng (detected) 95%<br>eng (detected) 96% | 12.7s | ✓ language en; images 6; image integrity; "Percentage" ≤ 2× 2× |
| [google-doc-document.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/011-google-doc-document/google-doc-document.pdf) | text layer plus an embedded image | en | 1 | eng (detected) 0% | 1.1s | ✓ language en; images 1; image integrity; contains "Beautiful is better than ugly" |
| [GeoTopo.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/009-pdflatex-geotopo/GeoTopo.pdf) | German LaTeX lecture notes: language detected from the text layer | de | 0 | - | 1.6s | ✓ language de; strong spans 13; contains "Topologie" |
| [GeoTopo-full](https://raw.githubusercontent.com/py-pdf/sample-files/main/009-pdflatex-geotopo/GeoTopo.pdf) | all 117 pages, streamed page by page | de | 10 | deu (detected) 0%<br>deu (detected) 0%<br>deu (detected) 0%<br>deu (detected) 0%<br>deu (detected) 0%<br>deu (detected) 0%<br>deu (detected) 38%<br>deu (detected) 0%<br>deu (detected) 0%<br>deu (detected) 0% | 9.2s | ✓ language de; image integrity; pages 117; heap 37 MB; strong spans 739 |
| [linn-24-pages.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/linn.png) | 24-page scan (a distinct image per page): streaming keeps memory flat | en | 24 | eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95% | 149.2s | ✓ language en; images 24; image integrity; pages 24; heap 37 MB; recall p1 99.0% (min 90%); recall p2 99.0% (min 90%); recall p3 99.0% (min 90%); recall p4 99.0% (min 90%); recall p5 99.0% (min 90%); recall p6 99.0% (min 90%); recall p7 99.0% (min 90%); recall p8 99.0% (min 90%); recall p9 99.0% (min 90%); recall p10 99.0% (min 90%); recall p11 99.0% (min 90%); recall p12 99.0% (min 90%); recall p13 99.0% (min 90%); recall p14 99.0% (min 90%); recall p15 99.0% (min 90%); recall p16 99.0% (min 90%); recall p17 99.0% (min 90%); recall p18 99.0% (min 90%); recall p19 99.0% (min 90%); recall p20 99.0% (min 90%); recall p21 99.0% (min 90%); recall p22 99.0% (min 90%); recall p23 99.0% (min 90%); recall p24 99.0% (min 90%) |
| [crazyones-pdfa.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/021-pdfa/crazyones-pdfa.pdf) | PDF/A with an English text layer | en | 0 | - | 5.1s | ✓ language en; contains "crazy ones" |
| [cmyk-image.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/023-cmyk-image/cmyk-image.pdf) | CMYK JPEG: converted (not kept, browsers render CMYK JPEGs differently) | - | 1 | eng (default) 0% | 1.5s | ✓ images 1; image integrity; image types png |
| [grayscale-image.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/019-grayscale-image/grayscale-image.pdf) | grayscale image | - | 1 | eng (default) 0% | 1.2s | ✓ images 1; image integrity |

## Tesseract vs. PaddleOCR (experimental)

`pnpm corpus --engine=paddle` on the OCR-heavy files: PaddleOCR (PP-OCRv4, Chinese + English)
through gutenye/ocr and onnxruntime-web, single-threaded wasm in a worker. It recognises lines,
not words (word boxes are split in proportion), has no diacritics and no orientation detection.

| File | Tesseract | Time | PaddleOCR | Time |
| --- | --- | --- | --- | --- |
| linn.pdf | ✓ · recall 99.0%, order 98.3% | 7.8s | ✓ · recall 98.6%, order 91.2% | 74.4s |
| linn-rotated-pixels.pdf | ✓ | 35.5s | ✗ rotations 0/0/0; recall p2 0.0%; recall p3 0.1% | 153.7s |
| images-en.pdf | ✓ | 1.1s | ✓ | 8.9s |
| c03-29.pdf | ✓ | 2.8s | ✗ contains "MISS WATSON’S LECTURE" | 19.9s |
| francais.pdf | ✓ | 2.6s | ✗ contains "capharnaüm"; contains "qualité" | 12.6s |
| masks.pdf | ✓ | 10.5s | ✓ | 51.8s |
| epson.pdf | ✓ | 5.0s | ✓ | 47.9s |
| 2400dpi.pdf | ✓ | 5.7s | ✓ | 36.3s |
| palette.pdf | ✓ | 3.5s | ✓ | 10.5s |
| graph.pdf | ✓ | 1.3s | ✓ | 9.3s |
