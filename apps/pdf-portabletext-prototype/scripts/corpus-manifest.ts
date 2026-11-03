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
  file: string;
  url: string;
  license: string;
  attribution: string;
  /** What the file exercises. */
  purpose: string;
  maxPages?: number;
  /**
   * Built locally instead of downloaded: one page per rotation, each holding
   * the image at `url` with its pixels turned clockwise by that angle.
   */
  derive?: { rotations: number[] };
  expect: {
    /** Expected `document.language` (BCP 47). */
    language?: string;
    /** Minimum number of image blocks. */
    minImages?: number;
    /** Words/phrases that must appear in the text (case-insensitive). */
    contains?: string[];
    /** Plain-text ground truth: fraction of its words found in the OCR text, per page. */
    groundTruth?: { url: string; minRecall: number; perPage?: boolean };
    /** Expected OCR rotation of each image, in document order. */
    rotations?: number[];
    /** Expected rotation of each image's placement on its page, in document order. */
    placementRotations?: number[];
  };
};

const linnTruth = `${OCRMYPDF}/linn.txt`;

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
      groundTruth: { url: linnTruth, minRecall: 0.9 },
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
      groundTruth: { url: linnTruth, minRecall: 0.9 },
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
      groundTruth: { url: linnTruth, minRecall: 0.9 },
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
      groundTruth: { url: linnTruth, minRecall: 0.85, perPage: true },
      placementRotations: [0, 90, 180, 270],
    },
  },
  {
    file: "linn-rotated-pixels.pdf",
    url: `${OCRMYPDF}/linn.png`,
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics; pixels rotated by scripts/fetch-corpus.ts",
    purpose: "scan whose pixels are stored sideways/upside down: OCR orientation detection",
    derive: { rotations: [90, 180, 270] },
    expect: {
      language: "en",
      minImages: 3,
      groundTruth: { url: linnTruth, minRecall: 0.85, perPage: true },
      rotations: [90, 180, 270],
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
      groundTruth: { url: linnTruth, minRecall: 0.8 },
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
    purpose: "six pages mixing scans, a blank page and a partial text layer",
    expect: { language: "en", minImages: 4 },
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
    expect: { language: "de", contains: ["Topologie"] },
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
    purpose: "CMYK image colour conversion",
    expect: { minImages: 1 },
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
