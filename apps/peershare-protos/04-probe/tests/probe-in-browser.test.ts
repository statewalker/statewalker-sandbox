/**
 * 04 — the Probe where it will run: in the PeerShare page, in Chromium.
 *
 * A "remote resource with a domain name and a certificate" is an https
 * server for `remote.localhost` (Chromium resolves `*.localhost` to loopback)
 * with a matching certificate, relabelled `public` so no Local Network Access
 * applies, as for a real remote site.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridge } from "../../02-bridge-lockdown/src/bridge.js";
import { type Listening, listenLoopback } from "../../02-bridge-lockdown/src/serve.js";
import {
  launchChromium,
  openPage,
  type PublicPage,
  startHttps,
  startPublicPage,
} from "../../03-local-network-access/src/harness.js";
import { startApp } from "../src/apps.js";
import type { ProbeReport } from "../src/probe.js";

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../src/browser-entry.ts");
const TOKEN = "pairing-token-04b";

let site: PublicPage;
let withCors: PublicPage;
let withoutCors: PublicPage;
let gone: PublicPage;
let bridge: Listening;
let browser: Browser;

/** An https "remote" resource at `remote.localhost`. */
function remote(cors: boolean) {
  return startHttps("DNS:remote.localhost", (req, res) => {
    const headers: Record<string, string> = { "content-type": "text/html" };
    if (cors) headers["access-control-allow-origin"] = req.headers.origin ?? "*";
    res.writeHead(200, headers).end("<p>remote</p>");
  });
}

beforeAll(async () => {
  site = await startPublicPage();
  withCors = await remote(true);
  withoutCors = await remote(false);
  gone = await remote(true);
  await gone.close();
  bridge = await listenLoopback(createBridge({ token: TOKEN, allowedOrigin: site.origin }));
  browser = await launchChromium(
    [site, withCors, withoutCors, gone].map((s) => `127.0.0.1:${s.port}=public`),
  );
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await bridge?.close();
  await Promise.all([site, withCors, withoutCors].map((s) => s?.close()));
});

type ProbeSpec =
  | { kind: "direct"; target: string }
  | { kind: "bridged"; target: string; bridge: { base: string; token: string } };

async function probeInPage(spec: ProbeSpec): Promise<ProbeReport> {
  const { page, context, console } = await openPage(browser, site.origin, {
    grant: true,
    entry: ENTRY,
    name: "Rung04",
  });
  try {
    return await page.evaluate(async (s) => {
      const { Rung04 } = window as unknown as { Rung04: typeof import("../src/browser-entry.js") };
      return Rung04.probe(
        Rung04.createUpstream(s),
        s.kind === "direct" ? { direct: s.target } : {},
      );
    }, spec);
  } catch (e) {
    throw new Error(`${e}\n${console.join("\n")}`);
  } finally {
    await context.close();
  }
}

const at = (s: PublicPage) => `https://remote.localhost:${s.port}`;

describe("04 — Direct, in the browser", () => {
  it("ok: https, a domain name, and CORS headers", async () => {
    expect(await probeInPage({ kind: "direct", target: at(withCors) })).toMatchObject({
      health: "ok",
    });
  });

  it("down, cause cors-missing: the site answers, but not to other origins", async () => {
    expect(await probeInPage({ kind: "direct", target: at(withoutCors) })).toMatchObject({
      health: "down",
      cause: "cors-missing",
    });
  });

  it("down, cause service-down: nothing answers", async () => {
    expect(await probeInPage({ kind: "direct", target: at(gone) })).toMatchObject({
      health: "down",
      cause: "service-down",
    });
  });
});

describe("04 — Bridged, in the browser", () => {
  it("cookies-set reaches the page although Set-Cookie itself never does", async () => {
    const app = await startApp({ setCookie: "session=abc; Path=/" });
    try {
      const report = await probeInPage({
        kind: "bridged",
        target: app.origin,
        bridge: { base: bridge.origin, token: TOKEN },
      });
      expect(report.warnings).toContain("cookies-set");
    } finally {
      await app.close();
    }
  });
});
