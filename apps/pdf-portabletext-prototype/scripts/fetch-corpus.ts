/**
 * Downloads the test corpus into `fixtures/corpus/` (skips files already
 * there) and builds the derived files described by `derive` entries.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";
import { CORPUS, type CorpusEntry } from "./corpus-manifest.ts";

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

async function derive(entry: CorpusEntry & { derive: { rotations: number[] } }) {
  const pngs = await rotatePixels(await download(entry.url), entry.derive.rotations);
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

const downloads = new Map<string, string>();
for (const entry of CORPUS) {
  if (!entry.derive) downloads.set(entry.file, entry.url);
  const truth = entry.expect.groundTruth?.url;
  if (truth) downloads.set(truth.split("/").pop() as string, truth);
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
  writeFileSync(path, await derive(entry as CorpusEntry & { derive: { rotations: number[] } }));
  console.log(`built ${entry.file}`);
}

const notice = CORPUS.map(
  (e) =>
    `${e.file}\n  source: ${e.url}\n  license: ${e.license}\n  attribution: ${e.attribution}\n`,
).join("\n");
writeFileSync(join(dir, "LICENSES.txt"), notice);
console.log(`corpus ready in ${dir}`);
