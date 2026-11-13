// Drives Kitesurf-on-CellB over CDP: open a page, read its title and text, take a screenshot.
//   node smoke.mjs [url] [endpoint]
import puppeteer from "puppeteer-core";

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
await browser.disconnect();
