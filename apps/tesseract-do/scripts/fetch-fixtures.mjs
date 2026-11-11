// Downloads the test images (openly licensed, OCRmyPDF test resources) and the tesseract
// models into fixtures/ (not committed). Runtimes under test get the models from a local server,
// so no runtime needs outbound network access.
//   node scripts/fetch-fixtures.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../fixtures", import.meta.url));
mkdirSync(join(dir, "models"), { recursive: true });

const OCRMYPDF = "https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/main/tests/resources";
const TESSDATA = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0";

// Licenses: https://github.com/ocrmypdf/OCRmyPDF/blob/main/REUSE.toml
export const IMAGES = [
  {
    file: "linn.png",
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "(C) 1985 Forat Electronics, via Wikimedia Commons (LinnSequencer)",
  },
  {
    file: "linn.txt",
    license: "GFDL-1.2-or-later OR CC-BY-SA-3.0",
    attribution: "transcript of linn.png",
  },
  {
    file: "typewriter.png",
    license: "GFDL-1.2-or-later OR CC-BY-SA-1.0/2.0/2.5/3.0",
    attribution: "(C) 2005 Ellywa, via Wikimedia Commons (Triumph typewriter text Linzensoep)",
  },
  ...["baiona.png", "baiona_gray.png", "baiona_colormapped.png", "baiona_alpha.png"].map(
    (file) => ({
      file,
      license: "CC-BY-SA-4.0",
      attribution: "(C) 2014 Euskaldunaa, via Wikimedia Commons (Baionako udalerri mugakideak)",
    }),
  ),
  {
    file: "c03-29.pdf",
    license: "public domain",
    attribution: "Project Gutenberg, Adventures of Huckleberry Finn, page 29",
  },
];
const MODELS = ["eng", "nld", "fra"];

async function download(url, path) {
  if (existsSync(path)) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(path, new Uint8Array(await res.arrayBuffer()));
  console.log(`fetched ${url}`);
}

for (const { file } of IMAGES) await download(`${OCRMYPDF}/${file}`, join(dir, file));
for (const lang of MODELS) {
  await download(`${TESSDATA}/${lang}.traineddata`, join(dir, "models", `${lang}.traineddata`));
}

// c03-29.pdf holds its scan as a plain JPEG stream: cut it out (SOI … EOI) as the JPEG fixture.
const jpegPath = join(dir, "c03-29.jpg");
if (!existsSync(jpegPath)) {
  const pdf = readFileSync(join(dir, "c03-29.pdf"));
  const start = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const end = pdf.indexOf(Buffer.from("endstream"), start);
  const eoi = pdf.lastIndexOf(Buffer.from([0xff, 0xd9]), end);
  if (start < 0 || eoi < 0) throw new Error("no JPEG stream in c03-29.pdf");
  writeFileSync(jpegPath, pdf.subarray(start, eoi + 2));
  console.log("wrote c03-29.jpg");
}

writeFileSync(
  join(dir, "LICENSES.txt"),
  IMAGES.map(
    (i) =>
      `${i.file}\n  source: ${OCRMYPDF}/${i.file}\n  license: ${i.license}\n  attribution: ${i.attribution}\n`,
  ).join("\n") +
    "\nc03-29.jpg\n  the JPEG stream of c03-29.pdf (public domain)\n" +
    `\nmodels/*.traineddata\n  source: ${TESSDATA}\n  license: Apache-2.0 (tesseract-ocr/tessdata_fast)\n`,
);
console.log(`fixtures ready in ${dir}`);
