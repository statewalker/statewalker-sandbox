// Interactive check: React TodoMVC on Kitesurf-on-CellB. Types two todos, completes one.
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({
  browserWSEndpoint: process.argv[2] ?? "ws://127.0.0.1:8787/devtools/browser",
  protocolTimeout: 120_000,
});
const page = await browser.newPage();
await page.goto("https://todomvc.com/examples/react/dist/index.html", { waitUntil: "load" });
await page.waitForSelector(".new-todo", { timeout: 60_000 });
for (const text of ["run kitesurf on cellb", "write the report"]) {
  await page.type(".new-todo", text);
  await page.keyboard.press("Enter");
}
await page.click(".todo-list li:first-child .toggle");
const items = await page.$$eval(".todo-list li", (lis) =>
  lis.map((li) => `${li.classList.contains("completed") ? "[x]" : "[ ]"} ${li.textContent.trim()}`),
);
console.log("todos:", items);
console.log("counter:", await page.$eval(".todo-count", (e) => e.textContent.trim()));
await page.screenshot({ path: "todomvc.png" });
await browser.disconnect();
