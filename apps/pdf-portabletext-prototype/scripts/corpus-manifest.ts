/**
 * Openly licensed test PDFs. Files are downloaded by `fetch-corpus.ts` into
 * `fixtures/corpus/` (not committed) and converted by `corpus.ts`.
 *
 * Sources:
 * - OCRmyPDF test resources, licenses per file in
 *   https://github.com/ocrmypdf/OCRmyPDF/blob/main/REUSE.toml
 * - py-pdf sample files, all CC-BY-SA-4.0:
 *   https://github.com/py-pdf/sample-files
 */

const OCRMYPDF = "https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources";
const PYPDF = "https://raw.githubusercontent.com/py-pdf/sample-files/main";

export type CorpusEntry = {
  /** Name of the run (and its output files); defaults to the file name. */
  id?: string;
  file: string;
  url: string;
  license: string;
  attribution: string;
  /** What the file exercises. */
  purpose: string;
  maxPages?: number;
  /** UI options for this run (select id → value). */
  options?: Record<string, string>;
  /**
   * Built locally instead of downloaded: one page per rotation, each holding
   * the image at `url` with its pixels turned clockwise by that angle.
   */
  derive?:
    | { kind: "rotate"; rotations: number[] }
    | { kind: "columns" }
    | { kind: "formatting" }
    | { kind: "images" };
  expect: {
    /** Expected `document.language` (BCP 47). */
    language?: string;
    /** Minimum number of image blocks. */
    minImages?: number;
    /** Words/phrases that must appear in the text (case-insensitive). */
    contains?: string[];
    /** Plain-text ground truth: fraction of its words found in the OCR text, per page. */
    /**
     * Plain-text transcript in reading order, `file` in the corpus directory:
     * downloaded from `url`, written by a `derive` builder, or (`fromStream`)
     * taken from the PDF's own text in content-stream order. Checks the
     * fraction of its words found (recall, per page with `perPage`) and of its
     * adjacent word pairs found (`minOrder`: catches wrong reading order).
     */
    groundTruth?: {
      file: string;
      url?: string;
      fromStream?: boolean;
      minRecall: number;
      minOrder?: number;
      perPage?: boolean;
    };
    /** Expected OCR rotation of each image, in document order. */
    rotations?: number[];
    /** Expected rotation of each image's placement on its page, in document order. */
    placementRotations?: number[];
    /** Phrases that must appear at most this many times (catches duplicated text). */
    maxOccurrences?: Record<string, number>;
    /** Engine that must have produced the text of every image with words. */
    ocrEngine?: string;
    /** Per image, in document order: stored type, transparency, stencil mask. */
    imageChecks?: { mimeType?: string; alpha?: boolean; stencil?: boolean }[];
    /** Text formatting: phrases that must carry a decorator, list items, tables. */
    formatting?: {
      strong?: string[];
      em?: string[];
      /** Minimum number of spans marked strong anywhere. */
      minStrong?: number;
      listItems?: { bullet?: number; number?: number };
      maxLevel?: number;
      tables?: { rows: number; cols: number; headerRows?: number }[];
    };
  };
};

const linnTruth = { file: "linn.txt", url: `${OCRMYPDF}/linn.txt` };

export const CORPUS: CorpusEntry[] = [
  {
    file: "linn.pdf",
    url: `${OCRMYPDF}/linn.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics, via Wikimedia Commons (LinnSequencer)",
    purpose: "two-column English scan with ground truth",
    expect: {
      language: "en",
      minImages: 1,
      groundTruth: { ...linnTruth, minRecall: 0.9, minOrder: 0.85 },
    },
  },
  {
    file: "jbig2.pdf",
    url: `${OCRMYPDF}/jbig2.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics (derived from linn.png)",
    purpose: "JBIG2-encoded scan (pdf.js wasm decoder)",
    expect: {
      language: "en",
      minImages: 1,
      groundTruth: { ...linnTruth, minRecall: 0.9 },
    },
  },
  {
    file: "ccitt.pdf",
    url: `${OCRMYPDF}/ccitt.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics (derived from linn.png)",
    purpose: "CCITT G4 fax-encoded scan",
    expect: {
      language: "en",
      minImages: 1,
      groundTruth: { ...linnTruth, minRecall: 0.9 },
    },
  },
  {
    file: "cardinal.pdf",
    url: `${OCRMYPDF}/cardinal.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics (derived from linn.png)",
    purpose: "the same scan on pages displayed at 0°, 90°, 180° and 270°",
    expect: {
      language: "en",
      minImages: 4,
      groundTruth: { ...linnTruth, minRecall: 0.85, perPage: true },
      placementRotations: [0, 90, 180, 270],
    },
  },
  {
    file: "linn-rotated-pixels.pdf",
    url: `${OCRMYPDF}/linn.png`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics; pixels rotated by scripts/fetch-corpus.ts",
    purpose: "scan whose pixels are stored sideways/upside down: OCR orientation detection",
    derive: { kind: "rotate", rotations: [90, 180, 270] },
    expect: {
      language: "en",
      minImages: 3,
      groundTruth: { ...linnTruth, minRecall: 0.85, perPage: true },
      rotations: [90, 180, 270],
    },
  },
  {
    file: "columns-en.pdf",
    url: "scripts/make-columns.ts",
    license: "CC0-1.0",
    attribution: "Written for this test suite",
    purpose: "two columns drawn line-interleaved, aligned paragraph breaks, longer left column",
    derive: { kind: "columns" },
    expect: {
      language: "en",
      groundTruth: { file: "columns-en.txt", minRecall: 0.98, minOrder: 0.95 },
    },
  },
  {
    file: "formatting-en.pdf",
    url: "scripts/make-formatting.ts",
    license: "CC0-1.0",
    attribution: "Written for this test suite",
    purpose: "inline bold/italic, bullet + nested + numbered lists, a table with header",
    derive: { kind: "formatting" },
    expect: {
      language: "en",
      contains: ["The end of the formatting test."],
      formatting: {
        strong: ["bold words", "Formatting Test"],
        em: ["italic words"],
        listItems: { bullet: 4, number: 3 },
        maxLevel: 2,
        tables: [{ rows: 4, cols: 3, headerRows: 1 }],
      },
    },
  },
  {
    file: "images-en.pdf",
    url: "scripts/make-images.ts",
    license: "CC0-1.0",
    attribution: "Made for this test suite",
    purpose: "JPEG kept byte for byte, PNG with alpha (soft mask), 1-bit stencil mask",
    derive: { kind: "images" },
    expect: {
      minImages: 3,
      contains: ["Original JPEG photo", "Transparent label text", "Stencil mask scan"],
      imageChecks: [
        { mimeType: "image/jpeg", alpha: false },
        { mimeType: "image/png", alpha: true },
        { mimeType: "image/png", alpha: true, stencil: true },
      ],
    },
  },
  {
    file: "multicolumn.pdf",
    url: `${PYPDF}/026-latex-multicolumn/multicolumn.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "py-pdf/sample-files contributors",
    purpose: "LaTeX two-column article (lorem ipsum) and a table",
    expect: {
      formatting: { tables: [{ rows: 6, cols: 5, headerRows: 1 }] },
      groundTruth: { file: "multicolumn.txt", fromStream: true, minRecall: 0.98, minOrder: 0.95 },
    },
  },
  {
    file: "skew.pdf",
    url: `${OCRMYPDF}/skew.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics (derived from linn.png)",
    purpose: "slightly skewed scan",
    expect: {
      language: "en",
      minImages: 1,
      groundTruth: { ...linnTruth, minRecall: 0.8 },
    },
  },
  {
    file: "c03-29.pdf",
    url: `${OCRMYPDF}/c03-29.pdf`,
    license: "public domain",
    attribution: "Project Gutenberg, Adventures of Huckleberry Finn, page 29",
    purpose: "old book scan with an illustration and decorative initial",
    expect: { language: "en", minImages: 1, contains: ["Miss Watson", "MISS WATSON’S LECTURE"] },
  },
  {
    file: "francais.pdf",
    url: `${OCRMYPDF}/francais.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "(C) James R. Barlow (OCRmyPDF)",
    purpose: "French scan with diacritics: language detection switches the OCR model",
    expect: {
      language: "fr",
      minImages: 1,
      rotations: [0],
      contains: ["vieux whisky", "capharnaüm", "qualité"],
    },
  },
  {
    file: "masks.pdf",
    url: `${OCRMYPDF}/masks.pdf`,
    license: "CC-BY-SA-3.0",
    attribution: 'Contributors to the German Wikipedia article "Linux"',
    purpose: "German printout scanned with explicit masks",
    expect: { language: "de", minImages: 2, rotations: [0, 0], contains: ["Betriebssystem"] },
  },
  {
    file: "epson.pdf",
    url: `${OCRMYPDF}/epson.pdf`,
    license: "CC-BY-SA-3.0",
    attribution: 'Contributors to the Wikipedia article "Optical character recognition"',
    purpose: "English printout scanned by an office printer",
    expect: { language: "en", minImages: 1, contains: ["optical character recognition"] },
  },
  {
    file: "2400dpi.pdf",
    url: `${OCRMYPDF}/2400dpi.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-1.0/2.0/2.5/3.0",
    attribution: "(C) 2005 Ellywa, via Wikimedia Commons (Triumph typewriter text Linzensoep)",
    purpose: "Dutch typewriter text in a 2400 dpi image",
    expect: {
      language: "nl",
      minImages: 1,
      rotations: [0],
      contains: ["Linzensoep", "kruidnagel", "de linzen"],
    },
  },
  {
    file: "palette.pdf",
    url: `${OCRMYPDF}/palette.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "(C) 2014 Euskaldunaa, via Wikimedia Commons (Baionako udalerri mugakideak)",
    purpose: "palette (indexed colour) image of a map with Basque/French labels",
    expect: {
      minImages: 1,
      rotations: [0],
      contains: ["Komunikabideak", "Milafranga", "Hiriburu"],
    },
  },
  {
    file: "graph.pdf",
    url: `${OCRMYPDF}/graph.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 2012 SmokeyJoe, via Wikimedia Commons",
    purpose: "line graph with slanted labels",
    expect: { minImages: 1 },
  },
  {
    file: "graph_ocred.pdf",
    url: `${OCRMYPDF}/graph_ocred.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 2012 SmokeyJoe, via Wikimedia Commons (OCRed by OCRmyPDF)",
    purpose: "chart with an invisible OCR text layer: replaced by own OCR, no duplicates",
    expect: {
      minImages: 1,
      contains: ["Percentage"],
      maxOccurrences: { Percentage: 1, Oppose: 1 },
      ocrEngine: "tesseract-wasm",
    },
  },
  {
    id: "graph_ocred-reuse",
    file: "graph_ocred.pdf",
    url: `${OCRMYPDF}/graph_ocred.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 2012 SmokeyJoe, via Wikimedia Commons (OCRed by OCRmyPDF)",
    purpose: "the same, reusing the invisible layer as OCR (no tesseract)",
    options: { invisible: "reuse" },
    expect: {
      minImages: 1,
      contains: ["Percentage"],
      maxOccurrences: { Percentage: 1, Oppose: 1 },
      ocrEngine: "pdf-text-layer",
    },
  },
  {
    file: "lichtenstein.pdf",
    url: `${OCRMYPDF}/lichtenstein.pdf`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 2001 Andreas Tille, (C) 2007 Alessio Damato, via Wikimedia Commons",
    purpose: "JPEG 2000 photo (pdf.js OpenJPEG wasm decoder), no text",
    expect: { minImages: 1 },
  },
  {
    file: "multipage.pdf",
    url: `${OCRMYPDF}/multipage.pdf`,
    license: "public domain",
    attribution: "OCRmyPDF test resources (assembled from public-domain scans)",
    purpose: "six pages mixing scans, a blank page and an invisible OCR layer",
    expect: { language: "en", minImages: 4, maxOccurrences: { Percentage: 2 } },
  },
  {
    file: "google-doc-document.pdf",
    url: `${PYPDF}/011-google-doc-document/google-doc-document.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "py-pdf/sample-files contributors",
    purpose: "text layer plus an embedded image",
    expect: { language: "en", minImages: 1, contains: ["Beautiful is better than ugly"] },
  },
  {
    file: "GeoTopo.pdf",
    url: `${PYPDF}/009-pdflatex-geotopo/GeoTopo.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "Martin Thoma, py-pdf/sample-files",
    purpose: "German LaTeX lecture notes: language detected from the text layer",
    maxPages: 6,
    expect: { language: "de", contains: ["Topologie"], formatting: { minStrong: 3 } },
  },
  {
    file: "crazyones-pdfa.pdf",
    url: `${PYPDF}/021-pdfa/crazyones-pdfa.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "py-pdf/sample-files contributors",
    purpose: "PDF/A with an English text layer",
    expect: { language: "en", contains: ["crazy ones"] },
  },
  {
    file: "cmyk-image.pdf",
    url: `${PYPDF}/023-cmyk-image/cmyk-image.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "py-pdf/sample-files contributors",
    purpose: "CMYK JPEG: converted (not kept, browsers render CMYK JPEGs differently)",
    expect: { minImages: 1, imageChecks: [{ mimeType: "image/png" }] },
  },
  {
    file: "grayscale-image.pdf",
    url: `${PYPDF}/019-grayscale-image/grayscale-image.pdf`,
    license: "CC-BY-SA-4.0",
    attribution: "py-pdf/sample-files contributors",
    purpose: "grayscale image",
    expect: { minImages: 1 },
  },
];
