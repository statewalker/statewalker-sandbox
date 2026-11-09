/**
 * The demos, end to end, on each host:
 *
 *   tsx scripts/e2e.ts [wrangler|celld|cellb|all] [astro] [emdash] [notebooks] [--no-browser]
 *
 * For each host: the platform (../dist/platform, `npm run build` in ..) is started on it; each
 * demo is built by its own toolchain where it needs one (Astro, on Node), sent to the platform's
 * bundler (which places it: in a Durable Object when small, on the Node runner when large), and
 * the bundle the platform returns is unpacked and run on the same host, where its pages are
 * checked over HTTP and in Chromium.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HOSTS, type RunningHost, startHost } from "../../scripts/hosts.mjs";
import { unzip, zip } from "../../src/core/util.js";
import { astroProject } from "./astro-project.js";
import { notebooksDemo } from "./notebooks.js";

const demos = resolve(import.meta.dirname, "..");
const platformRoot = resolve(demos, "..");
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const hostArg =
  HOSTS.includes(positional[0]) || positional[0] === "all" ? positional.shift() : "all";
const hosts = hostArg === "all" ? HOSTS : [hostArg as string];
const apps = positional.length ? positional : ["astro", "emdash", "notebooks"];
const browserOn = !args.includes("--no-browser");

const results: { host: string; check: string; ok: boolean; detail: string }[] = [];
async function check(host: string, name: string, fn: () => Promise<string>) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ host, check: name, ok: true, detail: `${detail} (${Date.now() - t} ms)` });
    console.log(`  ok   ${name}: ${detail} (${Date.now() - t} ms)`);
    return true;
  } catch (e) {
    results.push({ host, check: name, ok: false, detail: String((e as Error).message ?? e) });
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
    return false;
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
// biome-ignore lint/suspicious/noExplicitAny: Playwright is installed on the machine, untyped here
const playwright = () => createRequire(import.meta.url)("playwright") as any;

function ensureBuilt(app: string) {
  const dir = join(demos, app);
  if (existsSync(join(dir, "dist/server/wrangler.json"))) return;
  console.log(`  building ${app} with Astro…`);
  const r = spawnSync("pnpm", ["run", "build"], { cwd: dir, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${app}: astro build failed`);
}

/** Sends `files` to the platform's bundler; runs the Node runner when the build is queued for it. */
async function bundleOnPlatform(base: string, files: Map<string, Uint8Array>, query = "") {
  const res = await fetch(`${base}/builds${query}`, {
    method: "POST",
    body: zip([...files]) as BodyInit,
  });
  let s = (await res.json()) as {
    id: string;
    status: string;
    tier: string;
    error?: string;
    log: string[];
    stats?: Record<string, unknown>;
  };
  if (s.status === "queued") {
    await new Promise<void>((ok, fail) => {
      const p = spawn(
        process.execPath,
        [
          join(platformRoot, "node_modules/tsx/dist/cli.mjs"),
          join(platformRoot, "bin/webrun-build.ts"),
          "--runner",
          base,
          "--once",
        ],
        {
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`runner exited ${code}`))));
    });
    s = (await (await fetch(`${base}/builds/${s.id}`)).json()) as typeof s;
  }
  assert(s.status === "done", `build ${s.id} ${s.status}: ${s.error ?? s.log.join("\n")}`);
  return s;
}

/** Unpacks a build's project.zip; `vars` are deployment settings added to its wrangler.json. */
async function unpackBuild(base: string, id: string, vars: Record<string, string> = {}) {
  const z = await fetch(`${base}/b/${id}/project.zip`);
  assert(z.ok, `project.zip ${z.status}`);
  const out = mkdtempSync(join(tmpdir(), `webrun-demo-${id}-`));
  for (const [p, b] of await unzip(new Uint8Array(await z.arrayBuffer()))) {
    mkdirSync(dirname(join(out, p)), { recursive: true });
    writeFileSync(join(out, p), b);
  }
  const cfgPath = join(out, "wrangler.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.vars = { ...cfg.vars, ...vars };
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return out;
}

const freePort = () => 20000 + Math.floor(Math.random() * 20000);

async function astroDemo(host: string, base: string) {
  ensureBuilt("astro-app");
  let id = "";
  const built = await check(host, "astro: bundled by the platform", async () => {
    const s = await bundleOnPlatform(base, astroProject(join(demos, "astro-app")));
    id = s.id;
    return `build ${s.id}, tier ${s.tier}, ${JSON.stringify(s.stats?.workerBytes)} bytes`;
  });
  if (!built) return;
  const dir = await unpackBuild(base, id);
  let app: RunningHost | undefined;
  try {
    await check(host, "astro: SSR, Durable Object, API route, assets", async () => {
      app = await startHost(host, dir);
      const first = await (await fetch(`${app.url}/`)).text();
      assert(first.includes("Astro on the webrun platform"), `home: ${first.slice(0, 300)}`);
      const second = await (await fetch(`${app.url}/`)).text();
      const n = (html: string) => Number(html.match(/visits: (\d+)/)?.[1]);
      assert(n(second) === n(first) + 1, `visits ${n(first)} then ${n(second)}`);
      const post = await (await fetch(`${app.url}/posts/hello`)).text();
      assert(post.includes("Post: hello"), "post");
      const api = (await (await fetch(`${app.url}/api/time`)).json()) as { ok: boolean };
      assert(api.ok, "api");
      const asset = second.match(/\/_astro\/[^"']+\.js/)?.[0];
      assert(asset, "no client script in the page");
      assert((await fetch(`${app.url}${asset}`)).ok, `asset ${asset}`);
      return "home, visits counter, post, API, client asset";
    });
    if (browserOn && app)
      await check(host, "astro: React island hydrates in Chromium", async () => {
        const b = await playwright().chromium.launch();
        try {
          const page = await b.newPage();
          await page.goto(`${app?.url}/`);
          await page.waitForSelector("#island");
          await page.waitForFunction(
            () => document.querySelector("astro-island:not([ssr])") !== null,
            null,
            { timeout: 15000 },
          );
          await page.click("#island");
          await page.waitForSelector("text=island clicks: 1", { timeout: 10000 });
          return "hydrated, clicked";
        } finally {
          await b.close();
        }
      });
  } finally {
    await app?.stop();
  }
}

async function emdashDemo(host: string, base: string) {
  ensureBuilt("emdash");
  let id = "";
  const built = await check(host, "emdash: bundled by the platform", async () => {
    const files = astroProject(join(demos, "emdash"));
    const bytes = [...files.values()].reduce((n, b) => n + b.length, 0);
    const s = await bundleOnPlatform(base, files);
    id = s.id;
    return `build ${s.id}, ${files.size} input files (${(bytes / 1e6).toFixed(1)} MB), tier ${s.tier}, worker ${((s.stats?.workerBytes as number) / 1e6).toFixed(1)} MB`;
  });
  if (!built) return;
  const port = freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dir = await unpackBuild(base, id, { EMDASH_SITE_URL: origin });
  let app: RunningHost | undefined;
  try {
    await check(host, "emdash: setup seeds D1, pages render", async () => {
      app = await startHost(host, dir, { port, timeoutMs: 180_000 });
      const get = (p: string) => fetch(`${origin}${p}`, { redirect: "manual" });
      const status = (await (await get("/_emdash/api/setup/status")).json()) as {
        data: { needsSetup: boolean };
      };
      assert(status.data.needsSetup, `setup status ${JSON.stringify(status)}`);
      let seeded = false;
      for (let i = 0; i < 15 && !seeded; i++) {
        const r = await fetch(`${origin}/_emdash/api/setup`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-emdash-request": "1", origin },
          body: JSON.stringify({
            title: `EmDash on ${host}`,
            tagline: "Bundled by webrun",
            includeContent: true,
          }),
        });
        const body = await r.text();
        assert(r.status === 200, `setup ${r.status}: ${body.slice(0, 400)}`);
        seeded = (JSON.parse(body) as { data: { seedComplete: boolean } }).data.seedComplete;
      }
      assert(seeded, "seed did not complete");
      const home = await (await get("/")).text();
      assert(home.includes(`EmDash on ${host}`), "home title");
      assert(home.includes("Notes on Simplicity"), "seeded post on home");
      const post = await get("/posts/notes-on-simplicity");
      assert(
        post.status === 200 && (await post.text()).includes("Notes on Simplicity"),
        "post page",
      );
      const rss = await (await get("/rss.xml")).text();
      assert(rss.includes("<rss"), "rss");
      const admin = await get("/_emdash/admin");
      assert([200, 302].includes(admin.status), `admin ${admin.status}`);
      return "setup wizard seeded D1; home, post, RSS and admin answer";
    });
    if (browserOn && app)
      await check(host, "emdash: home and post render in Chromium", async () => {
        const b = await playwright().chromium.launch();
        try {
          const page = await b.newPage();
          const errors: string[] = [];
          page.on("pageerror", (e: Error) => errors.push(e.message));
          await page.goto(`${origin}/`);
          await page.waitForSelector("text=Notes on Simplicity");
          await page.click("text=Notes on Simplicity");
          await page.waitForURL(/notes-on-simplicity/);
          const h1 = await page.textContent("h1");
          assert(h1?.includes("Notes on Simplicity"), `h1 ${h1}`);
          return `navigated to the post${errors.length ? `; page errors: ${errors.join("; ")}` : ""}`;
        } finally {
          await b.close();
        }
      });
  } finally {
    await app?.stop();
  }
}

for (const host of hosts) {
  console.log(`\n== ${host}`);
  const dir = join(platformRoot, "dist/platform", host === "cellb" ? "cellb" : "workerd");
  const platform = await startHost(host, dir);
  try {
    if (apps.includes("astro")) await astroDemo(host, platform.url);
    if (apps.includes("emdash")) await emdashDemo(host, platform.url);
    if (apps.includes("notebooks"))
      await notebooksDemo(host, platform.url, { check, assert, browserOn, playwright });
  } finally {
    await platform.stop();
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(join(demos, "e2e-results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.exit(failed.length ? 1 : 0);
