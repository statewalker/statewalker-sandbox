// PDF conversion in a PdfJob Durable Object: the upload returns at once, the job converts one
// page per alarm and keeps its results in its own SQLite. A last job is left running for the
// durability suite, which checks it finishes after the runtime restarts.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { BASE_URL, fixture, recall, recordMetric } from "./helpers.mjs";
import { jobJson, startJob, text, waitForJob } from "./jobs-helpers.mjs";

test("a 117-page document: one page per alarm, the whole document at the end", async () => {
  const started = Date.now();
  const job = await startJob("GeoTopo.pdf");
  const accepted = (Date.now() - started) / 1000;
  assert.equal(job.status, "queued");
  assert.match(job.id, /^[0-9a-f]{64}$/);
  let sawProgress = false;
  const done = await waitForJob(job.id, {
    onProgress: (s) => {
      if (s.status === "running" && s.pagesDone > 0 && s.pagesDone < s.pageCount)
        sawProgress = true;
    },
  });
  assert.equal(done.status, "done", JSON.stringify(done));
  assert.equal(done.pageCount, 117);
  assert.equal(done.pagesDone, 117);
  assert.deepEqual(done.failedPages, []);
  assert.equal(done.language, "deu");
  assert.ok(sawProgress, "progress is visible while the job runs");
  const { body } = await jobJson(job.id, "/document");
  assert.equal(body.complete, true);
  assert.equal(body.document.pages.length, 117);
  assert.equal(body.document.language, "de");
  assert.ok(text(body.document).includes("Topologie"));
  const page = await jobJson(job.id, "/pages/1");
  assert.equal(page.body.page.number, 1);
  const seconds = (Date.now() - started) / 1000;
  recordMetric("job GeoTopo.pdf (117 pages)", {
    acceptedSeconds: accepted,
    seconds,
    blocks: body.document.blocks.length,
    assets: Object.keys(body.document.assets).length,
  });
});

test("a scan via a job: OCR in the language's cell, the PNG asset served by the job", async () => {
  const job = await startJob("linn.pdf", { lang: "eng" });
  const done = await waitForJob(job.id);
  assert.equal(done.status, "done", JSON.stringify(done));
  const { body } = await jobJson(job.id, "/document");
  const rec = recall(fixture("linn.txt").toString(), text(body.document));
  assert.ok(rec > 0.95, `recall ${rec}`);
  const img = body.document.blocks.find((b) => b._type === "image");
  const res = await fetch(`${BASE_URL}/api/pdf/jobs/${job.id}/assets/${img.asset._ref}`);
  assert.equal(res.headers.get("content-type"), "image/png");
  const png = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(png.length, body.document.assets[img.asset._ref].size);
  const inline = await jobJson(job.id, "/document?assets=inline");
  assert.equal(Buffer.from(inline.body.assets[img.asset._ref], "base64").length, png.length);
  recordMetric("job linn.pdf", { recall: Math.round(rec * 1000) / 1000 });
});

test("cancel keeps what is done; delete removes the job", async () => {
  const job = await startJob("GeoTopo.pdf", { lang: "deu", throttleMs: "1000" });
  await waitForPages(job.id, 1);
  const cancel = await fetch(`${BASE_URL}/api/pdf/jobs/${job.id}/cancel`, { method: "POST" });
  const cancelled = await cancel.json();
  assert.equal(cancelled.status, "cancelled");
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await jobJson(job.id)).body;
  assert.equal(after.pagesDone, cancelled.pagesDone, "no page after the cancel");
  assert.ok(after.pagesDone >= 1 && after.pagesDone < 117);
  const del = await fetch(`${BASE_URL}/api/pdf/jobs/${job.id}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal((await jobJson(job.id)).status, 404);
});

test("refusals: not a PDF, an unknown job", async () => {
  const res = await fetch(`${BASE_URL}/api/pdf/jobs`, {
    method: "POST",
    body: fixture("baiona.png"),
  });
  assert.equal(res.status, 400);
  assert.equal((await jobJson("0".repeat(64))).status, 404);
});

test("a job left running for the restart", async () => {
  // Slow on purpose: a second per page, so it is half-way when the runtime stops.
  const job = await startJob("GeoTopo.pdf", { lang: "deu", maxPages: "40", throttleMs: "1000" });
  const before = await waitForPages(job.id, 2);
  assert.equal(before.status, "running");
  writeFileSync(
    process.env.JOB_FILE ?? "/dev/null",
    JSON.stringify({ id: job.id, pagesDone: before.pagesDone }),
  );
});

async function waitForPages(id, n) {
  for (let i = 0; i < 600; i++) {
    const { body } = await jobJson(id);
    if (body.pagesDone >= n) return body;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job ${id}: fewer than ${n} pages`);
}
