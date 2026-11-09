/**
 * The platform in a browser tab on cellb (dist/browser, `npm run build:browser`), checked in
 * Chromium behind a plain static file server:
 *
 *   tsx scripts/e2e-browser.ts
 *
 * The host tab starts the platform in a Dedicated Worker; every other request of the origin is
 * answered by it through the ServiceWorker. Then, from pages of that origin: the ESM CDN serves a
 * graph, the React project renders, the bundler builds hello-worker with esbuild-wasm in the tab,
 * and the notebooks compile and run.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { zip } from "../src/core/util.js";
import { readTree } from "./tree.js";

const root = resolve(import.meta.dirname, "..");
const port = 20000 + Math.floor(Math.random() * 20000);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(
  "python3",
  [
    "-m",
    "http.server",
    String(port),
    "--bind",
    "127.0.0.1",
    "--directory",
    join(root, "dist/browser"),
  ],
  { stdio: "ignore" },
);
// biome-ignore lint/suspicious/noExplicitAny: Playwright is installed on the machine, untyped here
const { chromium } = createRequire(import.meta.url)("playwright") as any;

const results: { check: string; ok: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ check: name, ok: true, detail });
    console.log(`  ok   ${name}: ${detail} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push({ check: name, ok: false, detail: String((e as Error).message) });
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

await new Promise((r) => setTimeout(r, 800));
// The pages fetch packages from registry.npmjs.org; where outbound HTTPS goes through a proxy
// (HTTPS_PROXY), Chromium is told so, with the local file server bypassing it.
const proxy = process.env.HTTPS_PROXY
  ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" }
  : undefined;
const browser = await chromium.launch(proxy ? { proxy } : {});
try {
  const context = await browser.newContext();
  const host = await context.newPage();
  const logs: string[] = [];
  host.on("console", (m: { text(): string }) => logs.push(m.text()));
  console.log("\n== cellb in Chromium");
  await check("host tab starts the platform", async () => {
    await host.goto(`${origin}/__cellb/`);
    await host.waitForFunction(
      () => document.body.dataset.ready === "true" || document.body.dataset.error,
      null,
      { timeout: 180_000 },
    );
    const error = await host.evaluate(() => document.body.dataset.error);
    assert(!error, `${error}\n${logs.slice(-20).join("\n")}`);
    return (await host.textContent("#status")) ?? "";
  });

  const page = await context.newPage();
  await page.goto(`${origin}/`);
  const call = (
    path: string,
    init?: { method?: string; body?: string | number[]; json?: boolean },
  ) =>
    page.evaluate(
      async ({
        path,
        init,
      }: {
        path: string;
        init?: { method?: string; body?: string | number[]; json?: boolean };
      }) => {
        const body = Array.isArray(init?.body) ? new Uint8Array(init.body) : init?.body;
        const r = await fetch(path, {
          method: init?.method ?? "GET",
          body,
          headers: init?.json ? { "content-type": "application/json" } : undefined,
          redirect: "follow",
        });
        return { status: r.status, url: r.url, text: await r.text() };
      },
      { path, init },
    );

  await check("cdn: react-dom/client graph", async () => {
    const g = await call("/npm/browser/react-dom@19/client?graph");
    assert(g.status === 200, `graph ${g.status}: ${g.text.slice(0, 300)}`);
    const urls = JSON.parse(g.text) as string[];
    for (const u of urls) assert((await call(u)).status === 200, u);
    return `${urls.length} modules`;
  });

  await check("projects: react-page renders", async () => {
    const files: Record<string, string> = {};
    for (const [p, b] of readTree(join(root, "examples/react-page")))
      files[p] = new TextDecoder().decode(b);
    const imp = await call("/p/react-page/import", {
      method: "POST",
      body: JSON.stringify({ files }),
      json: true,
    });
    assert(imp.status === 200, `import ${imp.status} ${imp.text}`);
    const snap = JSON.parse((await call("/p/react-page/snapshots", { method: "POST" })).text) as {
      base: string;
    };
    const p = await context.newPage();
    await p.goto(`${snap.base}~/index.html`);
    await p.waitForSelector("text=Hello from webrun", { timeout: 60_000 });
    await p.click("#inc");
    const label = await p.textContent("#inc");
    assert(label?.includes("1"), label);
    await p.close();
    return label ?? "";
  });

  await check("bundler: hello-worker built with esbuild-wasm in the tab", async () => {
    const z = zip([...readTree(join(root, "examples/hello-worker"))]);
    const r = await call("/builds?tier=object", { method: "POST", body: [...z] });
    const s = JSON.parse(r.text) as {
      status: string;
      id: string;
      error?: string;
      stats?: { packages: string[]; workerBytes: number };
    };
    assert(s.status === "done", `${s.status}: ${s.error}`);
    const w = await call(`/b/${s.id}/worker.js`);
    assert(w.status === 200 && w.text.includes("Counter"), "worker.js");
    return `build ${s.id}: ${s.stats?.packages.join(", ")}, ${s.stats?.workerBytes} bytes`;
  });

  await check("notebooks: compiled in the tab and run", async () => {
    const files: Record<string, string> = {};
    const dir = join(root, "demos/notebooks");
    for (const n of readdirSync(dir)) files[n] = readFileSync(join(dir, n), "utf8");
    assert(
      (
        await call("/nb/demo/import", {
          method: "POST",
          body: JSON.stringify({ files }),
          json: true,
        })
      ).status === 200,
      "import",
    );
    const b = await call("/nb/demo/build", { method: "POST" });
    assert(b.status === 200, `build ${b.status}: ${b.text.slice(0, 300)}`);
    const p = await context.newPage();
    await p.goto(`${origin}/nb/demo/plots.html`);
    await p.waitForSelector("#summary", { timeout: 90_000 });
    const summary = await p.textContent("#summary");
    assert(summary?.includes("60 points"), summary);
    await p.close();
    return summary ?? "";
  });
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
