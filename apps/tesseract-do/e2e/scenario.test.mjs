// OCR in Durable Objects, one scenario for every runtime (scripts/run-env.mjs starts it).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fixture,
  getJson,
  modelHits,
  ocr,
  RUNTIME,
  recall,
  recordMetric,
  summary,
} from "./helpers.mjs";

test("runtime: what it allows", async () => {
  const runtime = await getJson("/api/runtime");
  recordMetric("runtime", runtime);
  // The wasm reaches tesseract as a module whether or not the runtime compiles bytes.
  assert.ok([true, false, "hangs"].includes(runtime.compileWasmFromBytes));
  if (RUNTIME === "wrangler") assert.equal(runtime.compileWasmFromBytes, false);
});

test("a map in every PNG colour type reads the same", async () => {
  const results = {};
  for (const file of [
    "baiona.png",
    "baiona_gray.png",
    "baiona_colormapped.png",
    "baiona_alpha.png",
  ]) {
    const r = await ocr(file);
    results[file] = summary(r);
    for (const label of ["Komunikabideak", "Milafranga", "Mugerre"]) {
      assert.ok(r.text.includes(label), `${file}: '${label}' in ${JSON.stringify(r.text)}`);
    }
  }
  recordMetric("baiona", results);
});

test("a JPEG book page", async () => {
  const r = await ocr("c03-29.jpg");
  recordMetric("c03-29.jpg", summary(r));
  assert.ok(r.text.includes("Miss Watson"));
  assert.ok(r.meanConfidence > 0.85);
});

test("a 2550×3300 two-column scan, read in bands, matches its transcript", async () => {
  const r = await ocr("linn.png", { cell: "ocr-eng-linn" });
  const rec = recall(fixture("linn.txt").toString(), r.text);
  recordMetric("linn.png", { ...summary(r), recall: Math.round(rec * 1000) / 1000 });
  assert.ok(rec > 0.95, `recall ${rec}`);
  assert.ok(r.bands > 1, "read in bands");
  // Stays well under the 128 MB an isolate may use, wasm included.
  assert.ok(r.wasmMemoryMiB < 80, `wasm ${r.wasmMemoryMiB} MiB`);
  // No word is reported twice where bands overlap.
  const keys = r.words.map((w) => `${w.text}@${w.bbox.x},${w.bbox.y}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("a Dutch 4000×2864 typewriter page in its own language cell", async () => {
  const r = await ocr("typewriter.png", { lang: "nld" });
  recordMetric("typewriter.png", summary(r));
  assert.equal(r.cellName, "ocr-nld");
  for (const w of ["Linzensoep", "kruidnagel", "linzen"]) assert.ok(r.text.includes(w), w);
  assert.ok(r.wasmMemoryMiB < 80, `wasm ${r.wasmMemoryMiB} MiB`);
});

test("the engine stays loaded in its cell between requests", async () => {
  const first = await ocr("c03-29.jpg", { lang: "fra", cell: "ocr-fra-reuse" });
  const second = await ocr("c03-29.jpg", { lang: "fra", cell: "ocr-fra-reuse" });
  assert.notEqual(first.model.source, "memory");
  assert.equal(second.model.source, "memory");
  assert.equal(second.cell.bootId, first.cell.bootId);
  recordMetric("engine reuse", { first: first.seconds, second: second.seconds });
});

test("each model was downloaded once per cell", async () => {
  const hits = await modelHits();
  recordMetric("model downloads (first run)", hits);
  assert.ok(hits["eng.traineddata"] >= 1);
  assert.equal(hits["nld.traineddata"], 1);
});

test("bad input is refused", async () => {
  const res = await fetch(`${process.env.BASE_URL}/api/ocr?lang=eng`, {
    method: "POST",
    body: "not an image",
  });
  assert.equal(res.status, 400);
  const lang = await fetch(`${process.env.BASE_URL}/api/ocr?lang=../x`, {
    method: "POST",
    body: fixture("baiona_gray.png"),
  });
  assert.equal(lang.status, 400);
});
