// End to end: Kitesurf on CellB, driven over CDP by Puppeteer. Needs a built Kitesurf checkout
// and `node scripts/setup.mjs` (engine/wrangler.json); skipped otherwise. Reaches the network
// (example.com, todomvc.com).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const app = fileURLToPath(new URL("..", import.meta.url));
const ready = existsSync(`${app}engine/wrangler.json`);
const port = 8790 + Math.floor(Math.random() * 100);
const endpoint = `ws://127.0.0.1:${port}/devtools/browser`;
let server;
let browser;

before(async () => {
  if (!ready) return;
  server = spawn(process.execPath, ["server.mjs", "engine", String(port)], { cwd: app });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 180_000);
    const onData = (d) => {
      log += d;
      if (log.includes("kitesurf on cellb:")) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.on("exit", (code) => reject(new Error(`server exited (${code}):\n${log}`)));
  });
  browser = await puppeteer.connect({ browserWSEndpoint: endpoint, protocolTimeout: 120_000 });
});

after(async () => {
  await browser?.disconnect();
  server?.kill("SIGTERM");
});

test("discovery answers as Kitesurf", { skip: !ready && "Kitesurf not set up" }, async () => {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`);
  const json = await res.json();
  assert.equal(json.Browser.split("/")[0], "Kitesurf");
  assert.equal(json.webSocketDebuggerUrl, endpoint);
});

test("renders example.com: title, text, a full-size screenshot", {
  skip: !ready && "Kitesurf not set up",
}, async () => {
  const page = await browser.newPage();
  await page.goto("https://example.com/", { waitUntil: "load", timeout: 120_000 });
  assert.equal(await page.title(), "Example Domain");
  assert.match(await page.evaluate(() => document.body.innerText), /documentation examples/);
  const png = await page.screenshot();
  assert.equal(png.readUInt32BE(16), 800); // width from the PNG header
  assert.equal(png.readUInt32BE(20), 600);
  await page.close();
});

test("React TodoMVC takes typed input and clicks", {
  skip: !ready && "Kitesurf not set up",
}, async () => {
  const page = await browser.newPage();
  await page.goto("https://todomvc.com/examples/react/dist/index.html", {
    waitUntil: "load",
    timeout: 120_000,
  });
  await page.waitForSelector(".new-todo", { timeout: 60_000 });
  for (const text of ["one", "two"]) {
    await page.type(".new-todo", text);
    await page.keyboard.press("Enter");
  }
  await page.click(".todo-list li:first-child .toggle");
  const items = await page.$$eval(".todo-list li", (lis) =>
    lis.map((li) => `${li.classList.contains("completed") ? "x" : "-"} ${li.textContent.trim()}`),
  );
  assert.deepEqual(items, ["x one", "- two"]);
  assert.match(await page.$eval(".todo-count", (e) => e.textContent), /1 item left/);
  await page.close();
});
