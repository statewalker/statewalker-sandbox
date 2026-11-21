// PDF → PortableText on the Workers runtime: pdf.js in-thread for the text layer and image
// pixels, OCR in the language's cells. One scenario for every runtime (scripts/run-env.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_URL, fixture, recall, recordMetric } from "./helpers.mjs";

async function pdf(file, query = {}) {
  const params = new URLSearchParams({ lang: "auto", name: file, ...query });
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/pdf?${params}`, { method: "POST", body: fixture(file) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} ${JSON.stringify(body)}`);
  return { ...body, seconds: (Date.now() - started) / 1000 };
}

const text = (doc) =>
  doc.blocks
    .map((b) =>
      b._type === "block"
        ? b.children.map((c) => c.text).join("")
        : b._type === "table"
          ? b.rows.map((r) => r.cells.join(" ")).join("\n")
          : "",
    )
    .join("\n");
const images = (doc) => doc.blocks.filter((b) => b._type === "image");

test("a LaTeX two-column paper: headings, paragraphs, a table", async () => {
  const { document: doc, seconds } = await pdf("multicolumn.pdf");
  assert.equal(doc.pages.length, 3);
  assert.equal(doc.blocks[0].style, "h1");
  const tables = doc.blocks.filter((b) => b._type === "table");
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].rows[0].cells, [
    "Country",
    "Population (millions)",
    "Area (km2)",
    "Capital",
    "Official Language",
  ]);
  assert.equal(tables[0].headerRows, 1);
  recordMetric("pdf multicolumn.pdf", { blocks: doc.blocks.length, seconds });
});

test("a JBIG2 scan (precompiled wasm decoder), OCR'd in a cell, words in image pixels", async () => {
  const { document: doc, seconds } = await pdf("linn.pdf", { lang: "eng" });
  const [img] = images(doc);
  assert.ok(img, "one image block");
  assert.equal(img.ocr.engine, "tesseract-wasm (durable object)");
  const rec = recall(fixture("linn.txt").toString(), text(doc));
  assert.ok(rec > 0.95, `recall ${rec}`);
  for (const b of doc.blocks.filter((x) => x._type === "block")) {
    for (const m of b.markDefs) {
      assert.ok(m.bbox.x >= 0 && m.bbox.x + m.bbox.width <= img.width, "word box inside the image");
      assert.ok(
        m.bbox.y >= 0 && m.bbox.y + m.bbox.height <= img.height,
        "word box inside the image",
      );
    }
  }
  recordMetric("pdf linn.pdf", {
    recall: Math.round(rec * 1000) / 1000,
    words: img.ocr.wordCount,
    seconds,
  });
});

test("JPEG 2000 decoded by pdf.js's precompiled OpenJPEG wasm", async () => {
  const { document: doc } = await pdf("lichtenstein.pdf", { lang: "eng" });
  const [img] = images(doc);
  assert.ok(img, "the JPX image is extracted");
  assert.deepEqual([img.width, img.height], [512, 512]);
  assert.ok(doc.assets[img.asset._ref].size > 10_000, "a real picture, not a blank");
});

test("the same page with OCR in Worker Loader isolates", async () => {
  const { document: doc } = await pdf("linn.pdf", { lang: "eng", engine: "isolate" });
  const rec = recall(fixture("linn.txt").toString(), text(doc));
  assert.ok(rec > 0.95, `recall ${rec}`);
});

test("German lecture notes: language from the text layer, bold kept", async () => {
  const { document: doc, seconds } = await pdf("GeoTopo.pdf", { maxPages: "6" });
  assert.equal(doc.language, "de");
  assert.equal(doc.pages.length, 6);
  const strong = doc.blocks
    .flatMap((b) => (b._type === "block" ? b.children : []))
    .filter((s) => s.marks.includes("strong"));
  assert.ok(strong.length >= 3, `${strong.length} strong spans`);
  assert.ok(text(doc).includes("Topologie"));
  recordMetric("pdf GeoTopo.pdf (6 pages)", { blocks: doc.blocks.length, seconds });
});

test("a chart with an invisible OCR layer: the layer is dropped, the image OCR'd once", async () => {
  const { document: doc } = await pdf("graph_ocred.pdf", { lang: "eng" });
  const t = text(doc);
  assert.equal(t.split("Percentage").length - 1, 1, JSON.stringify(t));
});

test("a French scan with the French model", async () => {
  const { document: doc } = await pdf("francais.pdf", { lang: "fra" });
  const t = text(doc);
  for (const w of ["vieux whisky", "capharnaüm", "qualité"]) assert.ok(t.includes(w), w);
  assert.equal(images(doc)[0].ocr.model, "fra");
});

test("streamed: one NDJSON event per page, PNG assets inline", async () => {
  const res = await fetch(`${BASE_URL}/api/pdf?lang=eng&stream=1&assets=inline&name=c03-29.pdf`, {
    method: "POST",
    body: fixture("c03-29.pdf"),
  });
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  const events = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    events.map((e) => e.type),
    ["page", "end"],
  );
  const [page] = events;
  assert.equal(page.assets.length, 1);
  const png = Buffer.from(page.assets[0].png, "base64");
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG");
  assert.equal(page.assets[0].meta.size, png.length);
  assert.ok(text(page).includes("Miss"), "OCR text in the page's blocks");
  assert.equal(events[1].document.pages.length, 1);
});

test("not a PDF is refused", async () => {
  const res = await fetch(`${BASE_URL}/api/pdf`, { method: "POST", body: fixture("baiona.png") });
  assert.equal(res.status, 400);
});
