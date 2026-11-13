// Opens the page in Chromium and prints what the in-tab CDP client got (title, text, timings),
// saving the screenshot next to this file.
//   node run.mjs [url] [port]
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const target = process.argv[2] ?? "https://example.com/";
const port = Number(process.argv[3] ?? 8800);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => process.stdout.write(`[page] ${m.text().slice(0, 300)}\n`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/?url=${encodeURIComponent(target)}`);
await page.waitForFunction(() => window.__result?.done, null, { timeout: 600_000 });
const r = await page.evaluate(() => window.__result);
if (r.screenshot) {
  const file = new URL(`tab-${new URL(target).hostname}.png`, import.meta.url).pathname;
  writeFileSync(file, Buffer.from(r.screenshot, "base64"));
  r.screenshot = file;
}
console.log(JSON.stringify(r, null, 2));
await browser.close();
