// PDF jobs over HTTP: start a PdfJob, poll it, read its document. Shared by the job suites.
import { BASE_URL, fixture } from "./helpers.mjs";

export async function startJob(file, query = {}) {
  const params = new URLSearchParams({ lang: "auto", name: file, ...query });
  const res = await fetch(`${BASE_URL}/api/pdf/jobs?${params}`, {
    method: "POST",
    body: fixture(file),
  });
  const body = await res.json();
  if (res.status !== 202) throw new Error(`${file}: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function jobJson(id, path = "") {
  const res = await fetch(`${BASE_URL}/api/pdf/jobs/${id}${path}`);
  return { status: res.status, body: await res.json() };
}

/** Polls until the job is no longer queued or running; returns its last status. */
export async function waitForJob(id, { timeoutMs = 600_000, onProgress } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await jobJson(id);
    onProgress?.(body);
    if (body.status !== "queued" && body.status !== "running") return body;
    if (Date.now() > deadline)
      throw new Error(`job ${id}: still ${body.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export const text = (doc) =>
  doc.blocks
    .map((b) =>
      b._type === "block"
        ? b.children.map((c) => c.text).join("")
        : b._type === "table"
          ? b.rows.map((r) => r.cells.join(" ")).join("\n")
          : "",
    )
    .join("\n");
