// After a restart on the same state: the cells come back with their models in SQLite, so OCR
// works without downloading them again, and a PDF job left half-way resumes from its alarm.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { getJson, modelHits, ocr, recordMetric } from "./helpers.mjs";
import { jobJson, waitForJob } from "./jobs-helpers.mjs";

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

test("after a restart an OCR isolate gets the model from the cell's SQLite", async () => {
  const before = await modelHits();
  const r = await ocr("c03-29.jpg", { cell: "ocr-eng-isolate", engine: "isolate" });
  assert.equal(r.isolate.modelSent, true);
  assert.equal(r.model.source, "sqlite");
  assert.ok(r.text.includes("Miss Watson"));
  const after = await modelHits();
  assert.equal(after["eng.traineddata"] ?? 0, before["eng.traineddata"] ?? 0, "no new download");
});

test("a PDF job started before the restart resumes and finishes", async (t) => {
  const file = process.env.JOB_FILE;
  if (!file || !existsSync(file)) return t.skip("no job was left running");
  const { id, pagesDone } = JSON.parse(readFileSync(file, "utf8"));
  const resumed = (await jobJson(id)).body;
  assert.ok(resumed.pagesDone >= pagesDone, "the pages done before the restart are kept");
  const done = await waitForJob(id, { timeoutMs: 300_000 });
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(done.pagesDone, 40);
  assert.deepEqual(done.failedPages, []);
  assert.ok(done.reads.opens >= 2, "the PDF was opened again from SQLite after the restart");
  const { body } = await jobJson(id, "/document");
  assert.equal(body.document.pages.length, 40);
  assert.deepEqual(
    body.document.pages.map((p) => p.number),
    Array.from({ length: 40 }, (_, i) => i + 1),
  );
  recordMetric("job resumed after restart", {
    pagesBeforeRestart: pagesDone,
    pagesAtRestart: resumed.pagesDone,
  });
});
