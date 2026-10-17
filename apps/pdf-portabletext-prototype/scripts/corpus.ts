/**
 * Converts every corpus PDF in headless Chromium (language: auto-detect) and
 * checks the result: detected language, OCR text against expected words or a
 * ground-truth transcript, and the integrity of every extracted image (asset
 * present, sizes consistent, placement inside the page, decodable, not blank).
 *
 * Usage: pnpm corpus:fetch && pnpm corpus [file-name-filter]
 * Writes e2e-output/corpus/<file>.json, <file>.png and report.md.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import type { PdfPortableTextDocument } from "../src/schema.ts";
import { CORPUS, type CorpusEntry } from "./corpus-manifest.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(root, "fixtures", "corpus");
const outDir = join(root, "e2e-output", "corpus");
mkdirSync(outDir, { recursive: true });
const filter = process.argv[2];

type ImageStat = { id: string; width: number; height: number; mean: number; stddev: number };
type Check = { name: string; ok: boolean; detail: string };
type Row = { entry: CorpusEntry; seconds: number; checks: Check[]; doc?: PdfPortableTextDocument };

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

/** Fraction of ground-truth words (as a multiset) found in `text`. */
function recall(truth: string, text: string): number {
  const bag = new Map<string, number>();
  for (const w of words(text)) bag.set(w, (bag.get(w) ?? 0) + 1);
  const expected = words(truth);
  let hit = 0;
  for (const w of expected) {
    const n = bag.get(w) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(w, n - 1);
    }
  }
  return expected.length === 0 ? 1 : hit / expected.length;
}

function blockText(doc: PdfPortableTextDocument, page?: number): string {
  return doc.blocks
    .filter((b) => b._type === "block" && (page === undefined || b.source.page === page))
    .map((b) => (b._type === "block" ? b.children.map((c) => c.text).join("") : ""))
    .join("\n");
}

function check(doc: PdfPortableTextDocument, entry: CorpusEntry, stats: ImageStat[]): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const { expect } = entry;
  const images = doc.blocks.filter((b) => b._type === "image");
  const text = blockText(doc);

  if (expect.language) {
    add("language", doc.language === expect.language, `${doc.language ?? "none"}`);
  }
  if (expect.minImages !== undefined) {
    add("images", images.length >= expect.minImages, `${images.length}`);
  }
  // Image integrity, for every image.
  const problems: string[] = [];
  for (const img of images) {
    const asset = doc.assets[img.asset._ref];
    const stat = stats.find((s) => s.id === img.asset._ref);
    const page = doc.pages[img.source.page - 1];
    const b = img.source.bbox;
    if (!asset) problems.push(`${img._key}: missing asset`);
    else if (
      asset.metadata.dimensions.width !== img.width ||
      asset.metadata.dimensions.height !== img.height
    )
      problems.push(`${img._key}: asset size differs from block size`);
    if (!stat) problems.push(`${img._key}: binary not decodable`);
    else if (stat.width !== img.width || stat.height !== img.height)
      problems.push(`${img._key}: binary is ${stat.width}×${stat.height}`);
    else if (stat.stddev < 1) problems.push(`${img._key}: uniform image (mean ${stat.mean})`);
    // Images may extend past the page (bleed, skewed scans) but must overlap it.
    if (
      b.width <= 0 ||
      b.height <= 0 ||
      b.x >= page.width ||
      b.y >= page.height ||
      b.x + b.width <= 0 ||
      b.y + b.height <= 0
    )
      problems.push(`${img._key}: bbox ${b.x},${b.y} ${b.width}×${b.height} off the page`);
    if (img.ocr) {
      for (const key of img.ocr.blocks) {
        const block = doc.blocks.find((x) => x._key === key);
        if (block?._type !== "block") continue;
        for (const m of block.markDefs) {
          const r = m.bbox;
          if (r.x < 0 || r.y < 0 || r.x + r.width > img.width || r.y + r.height > img.height) {
            problems.push(`${img._key}: word box ${m._key} outside the image`);
            break;
          }
        }
      }
    }
  }
  if (images.length > 0) add("image integrity", problems.length === 0, problems.join("; "));

  if (expect.rotations) {
    const actual = images.map((i) => i.ocr?.rotation ?? 0);
    add("rotations", actual.join() === expect.rotations.join(), actual.join("/"));
  }
  if (expect.placementRotations) {
    const actual = images.map((i) => {
      const m = i.source.transform;
      return m ? (Math.round((Math.atan2(m[1], m[0]) * 180) / Math.PI) + 360) % 360 : 0;
    });
    add("placement", actual.join() === expect.placementRotations.join(), actual.join("/"));
  }
  for (const phrase of expect.contains ?? []) {
    add(`contains "${phrase}"`, text.toLowerCase().includes(phrase.toLowerCase()));
  }
  if (expect.groundTruth) {
    const truth = readFileSync(
      join(corpusDir, expect.groundTruth.url.split("/").pop() as string),
      "utf8",
    );
    const pages = expect.groundTruth.perPage ? doc.pages.map((p) => p.number) : [undefined];
    for (const page of pages) {
      const r = recall(truth, blockText(doc, page));
      add(
        `recall${page ? ` p${page}` : ""}`,
        r >= expect.groundTruth.minRecall,
        `${(r * 100).toFixed(1)}% (min ${expect.groundTruth.minRecall * 100}%)`,
      );
    }
  }
  return checks;
}

const server = await createServer({
  root,
  configFile: join(root, "vite.config.ts"),
  server: { port: 5198 },
  logLevel: "warn",
});
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const rows: Row[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  await page.goto("http://localhost:5198/");
  for (const entry of CORPUS.filter((e) => !filter || e.file.includes(filter))) {
    const started = Date.now();
    await page.reload();
    await page.selectOption("#language", "auto");
    await page.fill("#max-pages", String(entry.maxPages ?? 50));
    await page.setInputFiles("#file", join(corpusDir, entry.file));
    await page.click("#convert");
    await page.waitForFunction(
      () => /done in|error:/.test(document.getElementById("log")?.textContent ?? ""),
      null,
      { timeout: 600_000 },
    );
    const seconds = (Date.now() - started) / 1000;
    const log = (await page.textContent("#log")) ?? "";
    const base = join(outDir, entry.file.replace(/\.pdf$/, ""));
    writeFileSync(`${base}.log`, log);
    if (/error:/.test(log)) {
      rows.push({
        entry,
        seconds,
        checks: [{ name: "conversion", ok: false, detail: log.split("error:")[1].trim() }],
      });
      console.log(`✗ ${entry.file}: ${log.split("error:")[1].trim()}`);
      continue;
    }
    const doc = JSON.parse((await page.textContent("#json pre")) ?? "") as PdfPortableTextDocument;
    writeFileSync(`${base}.json`, JSON.stringify(doc, null, 2));
    // Decode every binary asset and measure it.
    const stats = (await page.evaluate(`(async () => {
      const result = window.__lastResult;
      const out = [];
      for (const [id, blob] of result.blobs) {
        try {
          const bmp = await createImageBitmap(blob);
          const w = Math.min(bmp.width, 512), h = Math.max(1, Math.round(bmp.height * w / bmp.width));
          const ctx = new OffscreenCanvas(w, h).getContext("2d");
          ctx.drawImage(bmp, 0, 0, w, h);
          const d = ctx.getImageData(0, 0, w, h).data;
          let sum = 0, sq = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            sum += l; sq += l * l; n++;
          }
          const mean = sum / n;
          out.push({ id, width: bmp.width, height: bmp.height, mean: Math.round(mean), stddev: Math.round(Math.sqrt(sq / n - mean * mean) * 10) / 10 });
        } catch (e) {}
      }
      return out;
    })()`)) as ImageStat[];
    await page
      .locator("#preview")
      .screenshot({ path: `${base}.png` })
      .catch(() => {});
    const checks = check(doc, entry, stats);
    rows.push({ entry, seconds, checks, doc });
    const failed = checks.filter((c) => !c.ok);
    console.log(
      `${failed.length ? "✗" : "✓"} ${entry.file} (${seconds.toFixed(1)}s, lang ${doc.language ?? "-"}) ` +
        checks
          .map((c) => `${c.ok ? "" : "!"}${c.name}${c.detail ? `=${c.detail}` : ""}`)
          .join(", "),
    );
  }
} finally {
  await browser.close();
  await server.close();
}

const report = [
  "# Corpus report",
  "",
  "| File | Purpose | Lang | Images | OCR (model, source, rotation, conf.) | Time | Result |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  ...rows.map(({ entry, seconds, checks, doc }) => {
    const images = doc?.blocks.filter((b) => b._type === "image") ?? [];
    const ocr = images
      .filter((i) => i.ocr)
      .map((i) => {
        const o = i.ocr as NonNullable<typeof i.ocr>;
        const tried =
          o.attempts.length > 1 ? ` after ${o.attempts.map((a) => a.model).join("→")}` : "";
        return `${o.model} (${o.languageSource}${tried})${o.rotation ? ` ${o.rotation}°` : ""} ${(o.confidence * 100).toFixed(0)}%`;
      })
      .join("<br>");
    const failed = checks.filter((c) => !c.ok);
    const result = failed.length
      ? `✗ ${failed.map((c) => `${c.name} ${c.detail}`).join("; ")}`
      : `✓ ${checks.map((c) => `${c.name}${c.detail ? ` ${c.detail}` : ""}`).join("; ")}`;
    return `| [${entry.file}](${entry.url}) | ${entry.purpose} | ${doc?.language ?? "-"} | ${images.length} | ${ocr || "-"} | ${seconds.toFixed(1)}s | ${result} |`;
  }),
  "",
].join("\n");
writeFileSync(join(outDir, "report.md"), report);
const failures = rows.filter((r) => r.checks.some((c) => !c.ok)).length;
console.log(
  `\n${rows.length - failures}/${rows.length} files passed. Report: ${join(outDir, "report.md")}`,
);
process.exit(failures ? 1 : 0);
