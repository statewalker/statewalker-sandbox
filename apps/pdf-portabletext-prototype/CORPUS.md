# Test corpus results

Output of `pnpm corpus:fetch && pnpm corpus` (headless Chromium, language: auto-detect, fallback
English). Sources and licenses of every file are in
[`scripts/corpus-manifest.ts`](scripts/corpus-manifest.ts); the files are downloaded, not committed.

Columns: detected document language; number of image blocks; for each image the tesseract model
whose reading was kept, how it was chosen (`detected` from the OCR text, `document` from the text
layer or earlier pages, `default` = fallback English; `after a→b` lists every model tried), the
rotation corrected before OCR and the mean word confidence.

| File | What it exercises | Lang | Images | OCR (model, source, rotation, conf.) | Time | Checks |
| --- | --- | --- | --- | --- | --- | --- |
| [linn.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/linn.pdf) | two-column English scan with ground truth | en | 1 | eng (detected) 95% | 5.7s | ✓ language en; images 1; image integrity; recall 99.0% (min 90%) |
| [jbig2.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/jbig2.pdf) | JBIG2-encoded scan (pdf.js wasm decoder) | en | 1 | eng (detected) 95% | 5.1s | ✓ language en; images 1; image integrity; recall 98.9% (min 90%) |
| [ccitt.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/ccitt.pdf) | CCITT G4 fax-encoded scan | en | 1 | eng (detected) 95% | 5.0s | ✓ language en; images 1; image integrity; recall 99.0% (min 90%) |
| [cardinal.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/cardinal.pdf) | the same scan on pages displayed at 0°, 90°, 180° and 270° | en | 4 | eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95%<br>eng (detected) 95% | 5.7s | ✓ language en; images 4; image integrity; placement 0/90/180/270; recall p1 99.0% (min 85%); recall p2 99.0% (min 85%); recall p3 99.0% (min 85%); recall p4 99.0% (min 85%) |
| [linn-rotated-pixels.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/linn.png) | scan whose pixels are stored sideways/upside down: OCR orientation detection | en | 3 | eng (detected) 90° 95%<br>eng (detected) 180° 95%<br>eng (detected) 270° 95% | 26.0s | ✓ language en; images 3; image integrity; rotations 90/180/270; recall p1 99.0% (min 85%); recall p2 99.0% (min 85%); recall p3 99.0% (min 85%) |
| [skew.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/skew.pdf) | slightly skewed scan | en | 1 | eng (detected) 95% | 5.2s | ✓ language en; images 1; image integrity; recall 99.0% (min 80%) |
| [c03-29.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/c03-29.pdf) | old book scan with an illustration and decorative initial | en | 1 | eng (detected) 95% | 2.2s | ✓ language en; images 1; image integrity; contains "Miss Watson"; contains "MISS WATSON’S LECTURE" |
| [francais.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/francais.pdf) | French scan with diacritics: language detection switches the OCR model | fr | 1 | fra (detected after eng→fra) 91% | 2.1s | ✓ language fr; images 1; image integrity; rotations 0; contains "vieux whisky"; contains "capharnaüm"; contains "qualité" |
| [masks.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/masks.pdf) | German printout scanned with explicit masks | de | 2 | eng (default) 0%<br>deu (detected after eng→deu) 94% | 10.2s | ✓ language de; images 2; image integrity; rotations 0/0; contains "Betriebssystem" |
| [epson.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/epson.pdf) | English printout scanned by an office printer | en | 1 | eng (detected) 93% | 4.0s | ✓ language en; images 1; image integrity; contains "optical character recognition" |
| [2400dpi.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/2400dpi.pdf) | Dutch typewriter text in a 2400 dpi image | nl | 1 | nld (detected after eng→nld) 91% | 4.7s | ✓ language nl; images 1; image integrity; rotations 0; contains "Linzensoep"; contains "kruidnagel"; contains "de linzen" |
| [palette.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/palette.pdf) | palette (indexed colour) image of a map with Basque/French labels | en | 1 | eng (default after eng→eus) 84% | 2.5s | ✓ images 1; image integrity; rotations 0; contains "Komunikabideak"; contains "Milafranga"; contains "Hiriburu" |
| [graph.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/graph.pdf) | line graph with slanted labels | en | 1 | eng (default) 84% | 1.0s | ✓ images 1; image integrity |
| [lichtenstein.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/lichtenstein.pdf) | JPEG 2000 photo (pdf.js OpenJPEG wasm decoder), no text | - | 1 | eng (default) 0% | 1.2s | ✓ images 1; image integrity |
| [multipage.pdf](https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources/multipage.pdf) | six pages mixing scans, a blank page and a partial text layer | en | 6 | eng (detected) 95%<br>eng (document) 79%<br>eng (document) 84%<br>eng (document) 75%<br>eng (detected) 95%<br>eng (detected) 96% | 15.3s | ✓ language en; images 6; image integrity |
| [google-doc-document.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/011-google-doc-document/google-doc-document.pdf) | text layer plus an embedded image | en | 1 | eng (detected) 0% | 0.9s | ✓ language en; images 1; image integrity; contains "Beautiful is better than ugly" |
| [GeoTopo.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/009-pdflatex-geotopo/GeoTopo.pdf) | German LaTeX lecture notes: language detected from the text layer | de | 0 | - | 1.0s | ✓ language de; contains "Topologie" |
| [crazyones-pdfa.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/021-pdfa/crazyones-pdfa.pdf) | PDF/A with an English text layer | en | 0 | - | 0.6s | ✓ language en; contains "crazy ones" |
| [cmyk-image.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/023-cmyk-image/cmyk-image.pdf) | CMYK image colour conversion | - | 1 | eng (default) 0% | 1.0s | ✓ images 1; image integrity |
| [grayscale-image.pdf](https://raw.githubusercontent.com/py-pdf/sample-files/main/019-grayscale-image/grayscale-image.pdf) | grayscale image | - | 1 | eng (default) 0% | 0.8s | ✓ images 1; image integrity |
