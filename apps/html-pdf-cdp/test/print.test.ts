// HTML → PDF over plain CDP. Local Chromium always; Cloudflare Browser Run (Kitesurf, and its
// default Chromium engine) when CF_ACCOUNT_ID and CF_API_TOKEN are set.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { CdpConnection, type CdpEndpoint } from "../src/cdp.ts";
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
