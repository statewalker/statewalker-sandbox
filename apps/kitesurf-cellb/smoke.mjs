// Drives Kitesurf-on-CellB over CDP: open a page, read its title and text, take a screenshot,
// and with PDF=<file> print the page to PDF (Page.printToPDF: A4, backgrounds on).
//   node smoke.mjs [url] [endpoint]
import { writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

// A4 in inches, 0.4 in margins. Kitesurf answers a failed print with `error` beside empty `data`.
const PDF_OPTIONS = {
  paperWidth: 8.27,
  paperHeight: 11.69,
  printBackground: true,
  marginTop: 0.4,
  marginBottom: 0.4,
  marginLeft: 0.4,
  marginRight: 0.4,
};

const url = process.argv[2] ?? "https://example.com/";
const endpoint = process.argv[3] ?? "ws://127.0.0.1:8787/devtools/browser";
const out = process.env.OUT ?? "screenshot.png";

const t0 = Date.now();
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: 120_000 });
console.log("connected", (await browser.version()) ?? "");
const page = await browser.newPage();
await page.goto(url, { waitUntil: "load", timeout: 120_000 });
console.log("title:", await page.title());
const text = await page.evaluate(() => document.body?.innerText ?? "");
console.log("text:", text.replace(/\s+/g, " ").slice(0, 300));
await page.screenshot({ path: out });
console.log(`screenshot: ${out} (${Date.now() - t0} ms)`);
if (process.env.PDF) {
  const t1 = Date.now();
  const cdp = await page.createCDPSession();
  const pdf = await cdp.send("Page.printToPDF", PDF_OPTIONS);
  if (pdf.error) throw new Error(`Page.printToPDF: ${pdf.error}`);
  writeFileSync(process.env.PDF, Buffer.from(pdf.data, "base64"));
  console.log(`pdf: ${process.env.PDF} (${Date.now() - t1} ms)`);
}
await browser.disconnect();
