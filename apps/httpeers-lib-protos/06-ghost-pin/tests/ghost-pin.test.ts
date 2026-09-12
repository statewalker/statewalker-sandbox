/**
 * 06 — Can a remote peer's app render as a page that can reach ONLY that peer?
 *
 * Two levels, because the claim has two halves:
 *
 *   - The pin itself, in Node: a handler that cannot express a request to any
 *     peer but its own.
 *   - The pin under a real ServiceWorker edge, in Chromium: a host peer's HTML
 *     rendered in an iframe, with the page's own fetches going through the pin
 *     — and one of them trying to escape it.
 *
 * The mesh hop is stubbed on purpose. Rung 01 already carries a real call
 * between two peers; what is unproven, and what this rung is for, is the
 * ISOLATION — so the interesting assertions are the ones about what does NOT
 * get through.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PIN_REFUSED, pinnedPeer } from "../src/ghost.js";
import { createHostApp, type HostLog, OTHER_PEER } from "../src/host-app.js";

const here = dirname(fileURLToPath(import.meta.url));
const PINNED_PEER = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

describe("06 — the ghost's pin, in Node", () => {
  function build_() {
    const log: HostLog = { seen: [], lastAuth: null };
    const reached: string[] = [];
    const handler = pinnedPeer({
      landing: { peerId: PINNED_PEER, appPath: "/app" },
      basePath: "/ghost/",
      token: () => "VIEWER-TOKEN",
      remote: async (peerId, request) => {
        reached.push(peerId);
        return createHostApp(log, false)(request);
      },
    });
    return { handler, log, reached };
  }

  it("CLAIM 1 — a request through the ghost reaches the pinned peer, under the host's own mount", async () => {
    const { handler, log, reached } = build_();
    const res = await handler(new Request("http://viewer.local/ghost/asset.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("asset-from-host");
    expect(reached).toEqual([PINNED_PEER]);
    // The host sees its own path, never the viewer's mount.
    expect(log.seen).toEqual(["/app/asset.txt"]);
  });

  it("CLAIM 2 — the viewer's token is attached for the pinned peer", async () => {
    const { handler, log } = build_();
    await handler(new Request("http://viewer.local/ghost/asset.txt"));
    expect(log.lastAuth).toBe("Bearer VIEWER-TOKEN");
  });

  it("CLAIM 3 — a path naming ANOTHER peer is refused, not forwarded", async () => {
    const { handler, reached } = build_();
    const res = await handler(new Request(`http://viewer.local/ghost/${OTHER_PEER}/anything`));
    expect(res.status).toBe(403);
    expect(res.headers.get(PIN_REFUSED)).toBe("pinned");
    // The decisive part: nothing was dialled at all.
    expect(reached).toEqual([]);
  });

  it("CLAIM 4 — there is no input that makes the pin name a different peer", async () => {
    const { handler, reached } = build_();
    for (const path of [
      `/ghost/${OTHER_PEER}`,
      `/ghost/../${OTHER_PEER}/x`,
      `/ghost/%2e%2e/${OTHER_PEER}/x`,
      `/ghost/x?peer=${OTHER_PEER}`,
      `/ghost/x#${OTHER_PEER}`,
    ]) {
      await handler(new Request(`http://viewer.local${path}`)).catch(() => undefined);
    }
    // Every call either refused or went to the pinned peer; none named another.
    expect(reached.every((p) => p === PINNED_PEER)).toBe(true);
    expect(reached).not.toContain(OTHER_PEER);
  });
});

describe("06 — the ghost's pin, under a real ServiceWorker edge", () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-ghost-"));
    await build({
      root: join(here, "../src"),
      logLevel: "warn",
      build: {
        target: "esnext",
        outDir: dir,
        emptyOutDir: true,
        // rolldownOptions + treeshake:false — see rung 02: the worker's whole
        // job is a side-effecting import of a `sideEffects: false` package.
        rolldownOptions: {
          input: {
            index: join(here, "../src/index.html"),
            sw: join(here, "../src/sw.ts"),
          },
          output: {
            entryFileNames: (chunk: { name: string }) =>
              chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
          },
          treeshake: false,
        },
      },
    });

    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      // The viewer's OWN origin serves this — it is what a root-absolute URL
      // from inside the ghost reaches, and the point of claim 6.
      if (path === "/static/escape.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("VIEWER-ORIGIN-FILE");
        return;
      }
      const file = join(dir, path === "/" ? "index.html" : path);
      try {
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
          "service-worker-allowed": "/",
        });
        res.end(readFileSync(file));
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("no address");
    origin = `http://localhost:${address.port}`;
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  });

  async function render(useBaseHref: boolean) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${origin}/?base=${useBaseHref ? "1" : "0"}`);
    await page.waitForFunction(
      () => {
        const g = window.__ghost;
        return g?.error != null || Object.keys(g?.messages ?? {}).length >= 3;
      },
      undefined,
      { timeout: 60_000 },
    );
    const state = await page.evaluate(() => window.__ghost);
    const title = await page
      .frameLocator("#ghost-frame")
      .locator("#title")
      .textContent()
      .catch(() => null);
    await page.close();
    if (state?.error != null) throw new Error(`page failed: ${state.error}; ${errors.join(";")}`);
    return { state, title };
  }

  it("CLAIM 5 — the host peer's page RENDERS in the viewer, through the ServiceWorker edge", async () => {
    const { state, title } = await render(false);
    expect(state?.baseUrl).toContain("/ghost/");
    expect(title).toBe("hosted by another peer");
    // A relative fetch from inside the rendered page reached the host.
    expect(state?.messages.relative).toBe("asset-from-host");
  }, 180_000);

  it("CLAIM 6 — a ROOT-ABSOLUTE url escapes the ghost and hits the viewer's origin", async () => {
    const { state } = await render(false);
    // The finding, not a bug in the pin: `/static/escape.txt` is outside the
    // ghost's mount, so the ServiceWorker passes it to the network and the
    // VIEWER's origin answers. A host peer's page that uses root-absolute URLs
    // silently reads the viewer's site instead of its own.
    expect(state?.messages.rootAbsolute).toBe("200:VIEWER-ORIGIN-FILE");
  }, 180_000);

  it("CLAIM 7 — `<base href>` does NOT contain root-absolute urls either", async () => {
    const { state } = await render(true);
    // `<base href="/ghost/">` fixes RELATIVE urls only. Root-absolute ones are
    // unaffected by it, so the containment gap survives the documented remedy.
    expect(state?.messages.relative).toBe("asset-from-host");
    expect(state?.messages.rootAbsolute).toBe("200:VIEWER-ORIGIN-FILE");
  }, 180_000);

  it("CLAIM 8 — the rendered page CANNOT reach another peer through the ghost", async () => {
    const { state } = await render(false);
    // 403 from the pin. This is the ghost's whole security claim, exercised
    // from inside the foreign page rather than asserted from outside it.
    expect(state?.messages.otherPeer).toBe("403");
  }, 180_000);
});

declare global {
  interface Window {
    __ghost?: {
      ready: boolean;
      baseUrl: string;
      messages: Record<string, string>;
      hostSaw: string[];
      lastAuth: string | null;
      error?: string;
    };
  }
}
