// After a restart on the same state: the cells come back with their models in SQLite, so OCR
// works without downloading them again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getJson, modelHits, ocr, recordMetric } from "./helpers.mjs";

test("models survive a restart in the cell's SQLite", async () => {
  const before = await modelHits();
  const stats = await getJson("/api/cells/ocr-nld");
  assert.deepEqual(
    stats.models.map((m) => m.lang),
    ["nld"],
  );
  assert.deepEqual(stats.enginesLoaded, [], "a fresh isolate has no engine yet");
  const r = await ocr("typewriter.png", { lang: "nld" });
  assert.equal(r.model.source, "sqlite");
  assert.ok(r.text.includes("Linzensoep"));
  const after = await modelHits();
  assert.equal(after["nld.traineddata"] ?? 0, before["nld.traineddata"] ?? 0, "no new download");
  recordMetric("after restart", {
    model: r.model.source,
    seconds: r.seconds,
    wasmMemoryMiB: r.wasmMemoryMiB,
  });
});
