// HTML → PDF over plain CDP. Local Chromium always; Cloudflare Browser Run (Kitesurf, and its
// default Chromium engine) when CF_ACCOUNT_ID and CF_API_TOKEN are set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CdpConnection, type CdpEndpoint, CdpError } from "../src/cdp.ts";
import { browserRunEndpoint, credentialsFromEnv, launchLocalChromium } from "../src/endpoints.ts";
import { printHtmlToPdf } from "../src/print.ts";

const html = readFileSync(new URL("../fixtures/sample.html", import.meta.url), "utf8");

/** What a PDF holds: pages, their text, font names, and whether any image is painted. */
async function inspect(pdf: Uint8Array) {
  const doc = await getDocument({ data: pdf.slice(), verbosity: 0, fontExtraProperties: true })
    .promise;
  const pages: { text: string; width: number; height: number }[] = [];
  const fonts = new Set<string>();
  let images = 0;
  const fills = new Set<string>();
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items.map((i) => ("str" in i ? i.str : "")).join(" ");
    const ops = await page.getOperatorList();
    const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    images += ops.fnArray.filter((f) => f === OPS.paintImageXObject).length;
    for (let i = 0; i < ops.fnArray.length; i++)
      if (ops.fnArray[i] === OPS.setFillRGBColor)
        fills.add(String(ops.argsArray[i][0]).toLowerCase());
    // Font names (with fontExtraProperties) from the fonts setFont used, before cleanup.
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.setFont) continue;
      const id = ops.argsArray[i][0];
      if (page.commonObjs.has(id))
        fonts.add(String((page.commonObjs.get(id) as { name?: string }).name));
    }
    const [, , width, height] = page.view;
    pages.push({ text, width, height });
    page.cleanup();
  }
  await doc.loadingTask.destroy();
  return {
    pages,
    fonts: [...fonts],
    images,
    fills: [...fills],
    all: pages.map((p) => p.text).join("\n"),
  };
}

/** The checks every engine must pass: a PDF with the page's words, on separate pages. */
function assertSample(info: Awaited<ReturnType<typeof inspect>>, { strict }: { strict: boolean }) {
  assert.ok(info.all.includes("Quarterly Field Report"), "the heading's text");
  assert.ok(info.all.includes("Appendix"), "the second page's heading");
  if (!strict) return;
  assert.equal(info.pages.length, 2, "break-before: page gives a second page");
  assert.ok(info.pages[1].text.includes("Appendix"));
  assert.ok(info.all.includes("café") && info.all.includes("Zürich"), "accents as text");
  assert.ok(info.all.includes("North ridge") && info.all.includes("pending"), "table cells");
  assert.ok(
    info.fonts.some((f) => /bold/i.test(f)),
    `a bold font (fonts: ${info.fonts.join(", ")})`,
  );
  assert.ok(
    info.images >= 1 || info.fills.includes("#1a73e8"),
    `the SVG chart is painted, as an image or as vectors (fills: ${info.fills.join(" ")})`,
  );
  const [w, h] = [info.pages[0].width, info.pages[0].height];
  assert.ok(Math.abs(w - 595) < 2 && Math.abs(h - 842) < 2, `A4 (${w}×${h} pt)`);
}

describe("local Chromium", () => {
  let local: Awaited<ReturnType<typeof launchLocalChromium>>;
  let cdp: CdpConnection;
  before(async () => {
    local = await launchLocalChromium();
    cdp = await CdpConnection.connect(local.endpoint);
  });
  after(async () => {
    cdp?.close();
    await local?.close();
  });

  test("HTML set with Page.setDocumentContent, printed with Page.printToPDF", async () => {
    const r = await printHtmlToPdf(cdp, { html, pdf: { preferCSSPageSize: true } });
    assert.equal(r.loadedWith, "setDocumentContent");
    assert.equal(r.awaitedResources, true);
    const info = await inspect(r.pdf);
    assertSample(info, { strict: true });
    console.log(`  ${local.version}: ${r.pdf.byteLength} bytes, ${JSON.stringify(r.timings)}`);
  });

  test("the data: URL route gives the same document", async () => {
    const r = await printHtmlToPdf(cdp, {
      html,
      load: "dataUrl",
      pdf: { preferCSSPageSize: true },
    });
    assert.equal(r.loadedWith, "dataUrl");
    assertSample(await inspect(r.pdf), { strict: true });
  });

  test("streamed (IO.read in parts) gives a PDF too", async () => {
    const r = await printHtmlToPdf(cdp, { html, stream: true, pdf: { preferCSSPageSize: true } });
    assertSample(await inspect(r.pdf), { strict: true });
  });

  test("printBackground: false leaves the note's background out", async () => {
    const withBg = await printHtmlToPdf(cdp, { html, pdf: { printBackground: true } });
    const without = await printHtmlToPdf(cdp, { html, pdf: { printBackground: false } });
    assert.ok(without.pdf.byteLength < withBg.pdf.byteLength, "smaller without fills");
  });

  test("a 1.7 MB page too large for a data: URL is written into the page instead", async () => {
    const filler = `<p>${"lorem ipsum dolor sit amet ".repeat(64)}</p>\n`.repeat(1000);
    const big = html.replace("<h2 class", `${filler}<h2 class`);
    assert.ok(big.length > 1_700_000);
    const r = await printHtmlToPdf(cdp, { html: big, load: "dataUrl" });
    assert.equal(r.loadedWith, "documentWrite");
    const info = await inspect(r.pdf);
    assert.ok(info.all.includes("Quarterly Field Report") && info.all.includes("Appendix"));
  });

  test("an image that never loads delays printing at most 10 s, then prints", async () => {
    const hang = createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
    const { port } = hang.address() as { port: number };
    try {
      const page = html.replace(
        "<h2 class",
        `<img loading="lazy" width="10" height="10" src="http://127.0.0.1:${port}/never.png"><h2 class`,
      );
      const started = Date.now();
      const r = await printHtmlToPdf(cdp, { html: page });
      assert.equal(r.awaitedResources, false, "reported as not awaited");
      assert.ok(Date.now() - started < 25_000);
      assert.ok((await inspect(r.pdf)).all.includes("Appendix"));
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });

  test("targets are closed after printing", async () => {
    type Targets = { targetInfos: { type: string }[] };
    const pages = async () =>
      (await cdp.send<Targets>("Target.getTargets")).targetInfos.filter((t) => t.type === "page")
        .length;
    const before = await pages();
    await printHtmlToPdf(cdp, { html });
    // Target.closeTarget answers before the target is gone from the list.
    let after = await pages();
    for (let i = 0; i < 20 && after !== before; i++) {
      await new Promise((r) => setTimeout(r, 100));
      after = await pages();
    }
    assert.equal(after, before);
  });
});

const creds = credentialsFromEnv();
for (const [name, browser] of [
  ["Cloudflare Browser Run, Kitesurf", "kitesurf"],
  ["Cloudflare Browser Run, Chromium", undefined],
] as const) {
  test(name, { skip: creds ? false : "set CF_ACCOUNT_ID and CF_API_TOKEN" }, async () => {
    if (!creds) return;
    const endpoint: CdpEndpoint = browserRunEndpoint(creds, browser ? { browser } : {});
    const cdp = await CdpConnection.connect(endpoint);
    try {
      const r = await printHtmlToPdf(cdp, { html, pdf: { preferCSSPageSize: true } });
      const info = await inspect(r.pdf);
      // Kitesurf renders "not pixel-perfect": the words must be there, the layout may differ.
      assertSample(info, { strict: browser !== "kitesurf" });
      console.log(
        `  ${name}: ${r.pdf.byteLength} bytes, ${info.pages.length} pages, loaded with ` +
          `${r.loadedWith}, resources ${r.awaitedResources ? "awaited" : "not awaited"}, ` +
          `${JSON.stringify(r.timings)}, fonts: ${info.fonts.join(", ")}`,
      );
    } finally {
      cdp.close();
    }
  });
}

test("CdpError.notImplemented: a missing method, not a missing session", () => {
  assert.equal(new CdpError("Page.x", -32601, "'Page.x' wasn't found").notImplemented, true);
  assert.equal(new CdpError("Page.x", -32000, "'Page.x' wasn't found").notImplemented, true);
  assert.equal(
    new CdpError("Page.x", -32001, "Session with given id not found.").notImplemented,
    false,
  );
});

test("event waiters fail when the socket closes, not on their timeout", async () => {
  const local = await launchLocalChromium();
  try {
    const cdp = await CdpConnection.connect(local.endpoint);
    const waiter = cdp.waitFor("Page.loadEventFired", undefined, 60_000);
    const started = Date.now();
    cdp.close();
    await assert.rejects(waiter.promise, /ECONNRESET/);
    assert.ok(Date.now() - started < 1000);
  } finally {
    await local.close();
  }
});
