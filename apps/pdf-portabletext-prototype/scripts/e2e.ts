/**
 * Smoke test: starts the Vite dev server, converts `fixtures/sample-de.pdf`
 * in headless Chromium and checks the resulting PortableText.
 * Writes `e2e-output/document.json` and a screenshot of the preview.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";
import type { PdfPortableTextDocument } from "../src/schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "e2e-output");
mkdirSync(outDir, { recursive: true });

const server = await createServer({
  root,
  configFile: join(root, "vite.config.ts"),
  server: { port: 5199 },
});
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("console", (m) => m.type() === "error" && console.error("[browser]", m.text()));
  await page.goto("http://localhost:5199/");
  await page.setInputFiles("#file", join(root, "fixtures", "sample-de.pdf"));
  await page.click("#convert");
  await page.waitForFunction(
    () => /done in|error:/.test(document.getElementById("log")?.textContent ?? ""),
    null,
    {
      timeout: 180_000,
    },
  );
  const log = await page.textContent("#log");
  console.log(log);
  const json = (await page.textContent("#json pre")) ?? "";
  writeFileSync(join(outDir, "document.json"), json);
  await page.screenshot({ path: join(outDir, "preview.png"), fullPage: true });

  const doc = JSON.parse(json) as PdfPortableTextDocument;
  const text = doc.blocks
    .filter((b) => b._type === "block")
    .map((b) => b.children.map((c) => c.text).join(""))
    .join("\n");
  const images = doc.blocks.filter((b) => b._type === "image");
  const checks: [string, boolean][] = [
    ["heading from text layer", doc.blocks.some((b) => b._type === "block" && b.style === "h1")],
    ["two embedded images", images.filter((i) => i.source.type === "pdfImage").length === 2],
    [
      "vector-only page rendered for OCR",
      images.some((i) => i.source.type === "pageRender" && i.source.page === 3),
    ],
    [
      "images reference assets with sizes",
      images.every((i) => doc.assets[i.asset._ref]?.metadata.dimensions.width === i.width),
    ],
    ["OCR found 'Rechnung'", /Rechnung/.test(text)],
    ["OCR found 'Ergebnisse'", /Ergebnisse/.test(text)],
    [
      "OCR words carry image bboxes",
      doc.blocks.some(
        (b) =>
          b._type === "block" && b.markDefs.some((m) => m._type === "ocrBox" && m.bbox.width > 0),
      ),
    ],
  ];
  for (const [name, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    failed ||= !ok;
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
