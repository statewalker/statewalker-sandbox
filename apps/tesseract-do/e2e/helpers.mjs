// Shared by the scenario and durability suites: HTTP helpers, metrics file, text metrics.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8787";
export const RUNTIME = process.env.RUNTIME ?? "unknown";
export const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
export const fixture = (name) => readFileSync(join(fixtures, name));

export async function ocr(file, query = {}) {
  const params = new URLSearchParams({ lang: "eng", ...query });
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/ocr?${params}`, {
    method: "POST",
    body: fixture(file),
    headers: { "content-type": "application/octet-stream" },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status} ${JSON.stringify(body)}`);
  return { ...body, seconds: (Date.now() - started) / 1000 };
}

export async function getJson(path) {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

export async function modelHits() {
  return (await fetch(process.env.MODEL_HITS_URL)).json();
}

const words = (t) =>
  t
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

/** Share of the transcript's words (as a multiset) found in the text. */
export function recall(truth, text) {
  const bag = new Map();
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
  return hit / expected.length;
}

/** Records metrics of a run in the runtime's metrics file (merged with earlier phases). */
export function recordMetric(name, value) {
  const file = process.env.METRICS_FILE;
  if (!file) return;
  const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  all[name] = value;
  writeFileSync(file, JSON.stringify(all, null, 2));
}

export const summary = (r) => ({
  size: `${r.width}×${r.height}`,
  bands: r.bands,
  words: r.words.length,
  meanConfidence: r.meanConfidence,
  wasmMemoryMiB: r.wasmMemoryMiB,
  decodedMiB: r.decodedMiB,
  seconds: r.seconds,
  model: r.model.source,
});
