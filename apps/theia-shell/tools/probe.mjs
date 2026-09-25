import { chromium } from "@playwright/test";

const url = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
p.on("console", (m) => console.log("console", m.type(), m.text().slice(0, 300)));
p.on("pageerror", (e) => console.log("pageerror", e.message.slice(0, 500)));
p.on("requestfailed", (r) => console.log("reqfailed", r.url()));
await p.goto(url);
await p.waitForTimeout(Number(process.argv[3] ?? 8000));
console.log(
  await p.evaluate(() =>
    [...document.querySelectorAll("[id]")]
      .map((e) => `${e.id}${e.classList.contains("lm-mod-hidden") ? "(hidden)" : ""}`)
      .join(" "),
  ),
);
if (process.argv[4]) await p.screenshot({ path: process.argv[4] });
await b.close();
