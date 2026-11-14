/**
 * Downloads the test corpus into `fixtures/corpus/` (skips files already
 * there) and builds the derived files described by `derive` entries.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";
import { CORPUS } from "./corpus-manifest.ts";
import { buildColumnsPdf } from "./make-columns.ts";
import { buildFormattingPdf } from "./make-formatting.ts";
import { buildImagesPdf } from "./make-images.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "corpus");
mkdirSync(dir, { recursive: true });

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Rotates PNG/JPEG pixels clockwise in Chromium and returns PNGs. */
async function rotatePixels(image: Uint8Array, rotations: number[]): Promise<Uint8Array[]> {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage();
    const b64 = Buffer.from(image).toString("base64");
    // Source text, not a function: tsx would inject helpers the page lacks.
    const out = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0));
      const img = await createImageBitmap(new Blob([bytes]));
      const result = [];
      for (const deg of ${JSON.stringify(rotations)}) {
        const swap = deg === 90 || deg === 270;
        const canvas = new OffscreenCanvas(swap ? img.height : img.width, swap ? img.width : img.height);
        const ctx = canvas.getContext("2d");
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((deg * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        result.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
      }
      return result;
    })()`)) as number[][];
    return out.map((a) => Uint8Array.from(a));
  } finally {
    await browser.close();
  }
}

async function rotatedPages(url: string, rotations: number[]) {
  const pngs = await rotatePixels(await download(url), rotations);
  const pdf = await PDFDocument.create();
  for (const png of pngs) {
    const image = await pdf.embedPng(png);
    // 150 dpi page, image drawn upright: only the pixels are turned.
    const width = (image.width / 150) * 72;
    const height = (image.height / 150) * 72;
    pdf.addPage([width, height]).drawImage(image, { x: 0, y: 0, width, height });
  }
  return pdf.save();
}

/** One page per copy of the image, each with its page number stamped into the pixels. */
async function numberedPages(url: string, pages: number): Promise<Uint8Array> {
  const image = await download(url);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const pdf = await PDFDocument.create();
  try {
    const page = await browser.newPage();
    const b64 = Buffer.from(image).toString("base64");
    await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0));
      window.source = await createImageBitmap(new Blob([bytes]));
    })()`);
    for (let n = 1; n <= pages; n++) {
      // One page at a time, as base64: large arrays of numbers would exhaust Node's heap.
      const png = (await page.evaluate(`(async () => {
        const img = window.source;
        const canvas = new OffscreenCanvas(img.width, img.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        ctx.fillStyle = "#000";
        ctx.font = "28px serif";
        ctx.fillText("- ${n} -", img.width / 2 - 30, img.height - 30);
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(bin);
      })()`)) as string;
      const embedded = await pdf.embedPng(Buffer.from(png, "base64"));
      const width = (embedded.width / 150) * 72;
      const height = (embedded.height / 150) * 72;
      pdf.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
    }
  } finally {
    await browser.close();
  }
  return pdf.save();
}

/** The PDF's text in content-stream order, words hyphenated across lines rejoined. */
async function streamText(path: string): Promise<string> {
  const require = createRequire(import.meta.url);
  const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const out: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    for (const item of content.items) if ("str" in item) out.push(item.str);
  }
  return out.join(" ").replace(/(\p{L})- +(\p{Ll})/gu, "$1$2");
}

const downloads = new Map<string, string>();
for (const entry of CORPUS) {
  if (!entry.derive) downloads.set(entry.file, entry.url);
  const truth = entry.expect.groundTruth;
  if (truth?.url) downloads.set(truth.file, truth.url);
}
for (const [file, url] of downloads) {
  const path = join(dir, file);
  if (existsSync(path)) continue;
  writeFileSync(path, await download(url));
  console.log(`fetched ${file}`);
}
for (const entry of CORPUS) {
  const path = join(dir, entry.file);
  if (!entry.derive || existsSync(path)) continue;
  if (entry.derive.kind === "rotate") {
    writeFileSync(path, await rotatedPages(entry.url, entry.derive.rotations));
  } else if (entry.derive.kind === "longscan") {
    writeFileSync(path, await numberedPages(entry.url, entry.derive.pages));
  } else if (entry.derive.kind === "images") {
    writeFileSync(path, await buildImagesPdf());
  } else if (entry.derive.kind === "formatting") {
    writeFileSync(path, await buildFormattingPdf());
  } else {
    const { pdf, truth } = await buildColumnsPdf();
    writeFileSync(path, pdf);
    writeFileSync(join(dir, entry.file.replace(/\.pdf$/, ".txt")), truth);
  }
  console.log(`built ${entry.file}`);
}
for (const entry of CORPUS) {
  const truth = entry.expect.groundTruth;
  if (!truth?.fromStream || existsSync(join(dir, truth.file))) continue;
  writeFileSync(join(dir, truth.file), await streamText(join(dir, entry.file)));
  console.log(`wrote ${truth.file} from the content stream`);
}

const notice = CORPUS.map(
  (e) =>
    `${e.file}\n  source: ${e.url}\n  license: ${e.license}\n  attribution: ${e.attribution}\n`,
).join("\n");
writeFileSync(join(dir, "LICENSES.txt"), notice);
console.log(`corpus ready in ${dir}`);
