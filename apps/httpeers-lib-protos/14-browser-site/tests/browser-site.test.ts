/**
 * 14 — Does the SAME site work in a browser, published over a ServiceWorker?
 *
 * The fourth column of rung 11's parity table, and the last transport the
 * requirements name. The page builds the site with `createSite` and publishes
 * it with `HostedSiteBuilder`; the scenarios are rung 11's, unchanged, so the
 * browser column is produced by the same assertions as direct, port and
 * libp2p.
 *
 * It also measures the defect the research predicted: `SwHttpAdapter` rides
 * `handleHttpRequests`/`sendHttpRequest`, which are `@deprecated` in their own
 * source for having no backpressure, no chunking and no per-stream timeout —
 * and, relevant here, no abort path at all.
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
  name: string;
  pass: boolean;
  detail: string;
}

interface PageResult {
  baseUrl?: string;
  outcomes?: Outcome[];
  error?: string;
  abort?: {
    rejected: boolean;
    unwound: boolean;
    ticksAtAbort: number;
    ticksAfter: number;
    handlerStillRunning: boolean;
  };
}

describe("14 — the same site, in a browser, over a ServiceWorker", () => {
  let dir: string;
  let server: Server;
  let origin: string;
  let browser: Browser;
  let result: PageResult;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "httpeers-browser-site-"));
    await buildFixture(dir);

    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const file = join(dir, path.endsWith("/") ? `${path}index.html` : path);
      try {
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
          // The worker is served from the root so its scope covers the site.
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

    // Real keys and real tokens, exactly as rung 11 mints them.
    const meshKey = await generateMeshKey();
    const issuer = peerIdOf(meshKey);
    const subject = peerIdOf(await generateMeshKey());
    const selfPeer = peerIdOf(await generateMeshKey());
    const goodToken = await mintToken({
      privateKey: meshKey,
      sub: subject,
      roles: ["member"],
      ttlMs: 600_000,
    });
    const foreignToken = await mintToken({
      privateKey: await generateMeshKey(),
      sub: subject,
      roles: ["member"],
      ttlMs: 600_000,
    });

    browser = await chromium.launch();
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on("console", (m) => logs.push(`[console] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e)}`));

    const query = new URLSearchParams({
      issuer,
      self: selfPeer,
      sub: subject,
      good: goodToken,
      foreign: foreignToken,
    });
    await page.goto(`${origin}/?${query.toString()}`);

    try {
      await page.waitForFunction(
        () => window.__rung14?.outcomes !== undefined || window.__rung14?.error !== undefined,
        undefined,
        { timeout: 90_000 },
      );
    } catch (error) {
      throw new Error(`the page never reported. Logs:\n${logs.join("\n")}`, { cause: error });
    }

    result = (await page.evaluate(() => window.__rung14)) as PageResult;
    if (result.error != null) throw new Error(`page failed: ${result.error}\n${logs.join("\n")}`);

    const rows = (result.outcomes ?? []).map(
      (o) => `  ${o.pass ? "✓" : "✗"}  ${o.name}${o.pass ? "" : ` — ${o.detail}`}`,
    );
    console.log(`\nBrowser column (HostedSiteBuilder over a ServiceWorker):\n${rows.join("\n")}\n`);
    await page.close();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
    if (dir != null) rmSync(dir, { recursive: true, force: true });
  });

  it("CLAIM 1 — the site is published and reachable at its own base URL", () => {
    expect(result.baseUrl).toContain("/mesh/");
  });

  it("CLAIM 2 — every rung-11 scenario passes in the browser too", () => {
    const failed = (result.outcomes ?? []).filter((o) => !o.pass);
    expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  });

  it("CLAIM 3 — Biscuit validation works in a page, with no libp2p present", () => {
    const name = "GET /secret with a valid token → 200 (no libp2p needed)";
    expect((result.outcomes ?? []).find((o) => o.name === name)?.pass).toBe(true);
  });

  it("CLAIM 5 — the abort IS observable to a ServiceWorker, so claim 4 is a transport defect", async () => {
    // Rung 13 had to separate "a library defect" from "a limit of the
    // language". This is the browser's version of that question, and it has
    // to be measured rather than reasoned about: if a worker is never told
    // that its client walked away, no transport could propagate the abort and
    // claim 4 would be a platform limit to document. It is not.
    const page = await browser.newPage();
    const logs: string[] = [];
    page.on("console", (m) => logs.push(`[console] ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e)}`));
    await page.goto(`${origin}/probe-app/`);
    try {
      await page.waitForFunction(() => window.__probe !== undefined, undefined, {
        timeout: 60_000,
      });
    } catch (error) {
      throw new Error(`the probe never reported. Logs:\n${logs.join("\n")}`, { cause: error });
    }
    const probe = (await page.evaluate(() => window.__probe)) as {
      controlled?: boolean;
      rejected?: boolean;
      seen?: { signal: boolean; cancel: boolean; ticks: number; ended: boolean };
      error?: string;
    };
    await page.close();

    if (probe.error != null) throw new Error(`probe failed: ${probe.error}\n${logs.join("\n")}`);
    console.log(`\nWhat the worker saw on abort: ${JSON.stringify(probe.seen)}\n`);

    expect(probe.controlled).toBe(true);
    expect(probe.rejected).toBe(true);
    // At least one of the two channels must fire, or the fix is impossible.
    expect(probe.seen?.signal === true || probe.seen?.cancel === true).toBe(true);
  }, 120_000);

  it("CLAIM 4 — an aborted request unwinds the handler, in the browser too", () => {
    // THIS CLAIM USED TO DOCUMENT A HAZARD, and it is kept as evidence of the
    // fix rather than rewritten out of the record. As first measured, an
    // aborted `fetch` stopped at the caller: the handler's producer kept
    // producing for the life of the page, where Node's gateway propagates the
    // abort into the handler (rung 08 claim 7). That was three defects in a
    // row, each hiding the next:
    //
    //   1. `toReadableStream` had no `cancel`, so a cancelled response body
    //      never released the iterator feeding it;
    //   2. `fromReadableStream` never released its reader, so returning the
    //      generator left the handler's own stream uncancelled;
    //   3. the SW transport had no cancellation MESSAGE — and closing a
    //      `MessagePort` does not notify its peer.
    //
    // Claim 5 is what made fixing them worth attempting: it proves the browser
    // does tell the worker, so this was never a platform limit.
    expect(result.abort?.rejected).toBe(true);
    expect(result.abort?.unwound).toBe(true);
    expect(result.abort?.handlerStillRunning).toBe(false);
    // Not merely "unwound eventually": it must stop PROMPTLY, or a slow leak
    // is indistinguishable from a fixed one. The producer ticks every 100ms;
    // measured latency is about two ticks, which is the queued-`.return()`
    // cost rung 13 documented — a cancellation cannot land until the pending
    // `next()` it is queued behind resolves, and here that is the producer's
    // own next tick. Unfixed, the 800ms that follow would add eight.
    expect(result.abort?.ticksAfter).toBeLessThanOrEqual((result.abort?.ticksAtAbort ?? 0) + 3);
  });
});

declare global {
  interface Window {
    __rung14?: PageResult;
    __probe?: {
      controlled?: boolean;
      rejected?: boolean;
      seen?: { signal: boolean; cancel: boolean; ticks: number; ended: boolean };
      error?: string;
    };
  }
}
