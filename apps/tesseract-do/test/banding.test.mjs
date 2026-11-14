// Banded recognition reads the same words as one pass, without repeating words in overlaps.
// tesseract-wasm runs in Node here: the module is compiled from bytes, which Node allows.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeImage } from "../src/decode.ts";
import { createEngine, recognize, wasmMemoryBytes } from "../src/ocr.ts";

const fixture = (name) => new URL(`../fixtures/${name}`, import.meta.url);
const have = existsSync(fixture("models/eng.traineddata"));

test("bands: same words, no duplicates, less memory", {
  skip: !have && "run pnpm fixtures",
}, async () => {
  const wasm = new WebAssembly.Module(
    readFileSync(
      new URL("../node_modules/tesseract-wasm/dist/tesseract-core.wasm", import.meta.url),
    ),
  );
  const model = readFileSync(fixture("models/eng.traineddata"));
  const source = decodeImage(readFileSync(fixture("linn.png")));

  const whole = await createEngine(wasm, model);
  const one = recognize(whole, source, { bandHeight: 0 });
  const banded = await createEngine(wasm, model);
  const many = recognize(banded, source, { bandHeight: 800 });

  assert.equal(one.bands, 1);
  assert.equal(many.bands, 5);
  const keys = many.words.map((w) => `${w.text}@${w.bbox.x},${w.bbox.y}`);
  assert.equal(new Set(keys).size, keys.length, "no word twice");
  const count = (r) => r.words.length;
  assert.ok(
    Math.abs(count(many) - count(one)) <= count(one) * 0.01,
    `${count(many)} vs ${count(one)} words`,
  );
  assert.ok(wasmMemoryBytes(banded) < wasmMemoryBytes(whole) * 0.6, "smaller wasm memory");
});
