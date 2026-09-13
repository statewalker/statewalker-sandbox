/**
 * 02 — Can a Biscuit token be verified INSIDE a ServiceWorker?
 *
 * Two workers, identical but for how the wasm is loaded, each registered by
 * `@statewalker/webrun-http-browser`'s `initServiceWorker` and each asked to
 * verify one real token minted here by `httpeers.core`'s own `mintToken`.
 *
 * `localhost` is a secure context, so ServiceWorkers are available over plain
 * http — no TLS needed for the fixture server.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { generateMeshKey, mintToken } from "@statewalker/httpeers.core/tokens";
import { peerIdOf } from "@statewalker/httpeers-stack/src/setup/keys.js";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture } from "../src/build.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

interface Outcome {
  stage: string;
  ok: boolean;
  detail: string;
}

describe("02 — Biscuit inside a ServiceWorker", () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let browser: Browser;
  let token: string;
  let issuer: string;
  let sub: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-sw-access-"));
    await buildFixture(dir);

    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const file = join(dir, path === "/" ? "index.html" : path);
      try {
        const body = readFileSync(file);
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          // Workers are served from the root scope; no caching, so each test
          // sees the build rather than a previous run's worker.
          "cache-control": "no-store",
          "service-worker-allowed": "/",
        });
        res.end(body);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address == null || typeof address === "string") throw new Error("no server address");
    origin = `http://localhost:${address.port}`;

    // A real mesh key and a real token. `sub` is also passed as the proven
    // peer, standing in for what the transport would have proved.
    const meshKey = await generateMeshKey();
    issuer = peerIdOf(meshKey);
    sub = issuer;
    token = await mintToken({ privateKey: meshKey, sub, roles: ["member"], ttlMs: 600_000 });

    browser = await chromium.launch();
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  });

  async function run(variant: "naive" | "manual"): Promise<Outcome> {
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on("console", (msg) => logs.push(`[console] ${msg.text()}`));
    page.on("pageerror", (err) => logs.push(`[pageerror] ${String(err)}`));
    const url =
      `${origin}/?variant=${variant}&token=${encodeURIComponent(token)}` +
      `&issuer=${encodeURIComponent(issuer)}&sub=${encodeURIComponent(sub)}`;
    await page.goto(url);
    try {
      await page.waitForFunction(() => window.__result !== undefined, undefined, {
        timeout: 60_000,
      });
    } catch (error) {
      throw new Error(`${variant}: the page never reported. Logs:\n${logs.join("\n")}`, {
        cause: error,
      });
    }
    const result = (await page.evaluate(() => window.__result)) as Outcome;
    await page.close();
    return result;
  }

  it("CLAIM 1 — the published build cannot be used in a module worker", async () => {
    const outcome = await run("naive");
    // Recorded whichever way it goes: if this ever starts passing, the
    // constraint has been lifted upstream and the seam below is unnecessary.
    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe("register");
  }, 120_000);

  it("CLAIM 2 — instantiating from bytes through the loader seam verifies a real token", async () => {
    const outcome = await run("manual");
    expect(outcome).toMatchObject({ stage: "verify", ok: true });
    expect(outcome.detail).toContain(sub);
    expect(outcome.detail).toContain("member");
  }, 120_000);
});

declare global {
  interface Window {
    __result?: Outcome;
  }
}
