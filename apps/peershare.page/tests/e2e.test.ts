/**
 * End to end, in Chromium: the scenario (tests/scenario.ts) against the built
 * page on a public https origin, with a real relay, Bridge and session shell.
 * Two browser contexts: two separate IndexedDBs, two separate mesh nodes.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge, type Listening, listenLoopback } from "@statewalker/httpeers-share/bridge";
import type { Browser } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, it } from "vitest";
import { type Hosted, launch, servePage, serveSessions, startRelay } from "./e2e-harness.js";
import { dirkSharesClaudiaViews, startDirksApp } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = "peershare-e2e";
let app: Awaited<ReturnType<typeof startDirksApp>>;
let relay: Awaited<ReturnType<typeof startRelay>>;
let page: Hosted;
let sessions: Hosted;
let bridge: Listening;
let browser: Browser;

beforeAll(async () => {
  await build({ root: resolve(here, ".."), logLevel: "error" });
  app = await startDirksApp();
  relay = await startRelay();
  sessions = await serveSessions(resolve(here, "../src/vendor/session-shell"));
  page = await servePage(resolve(here, "../dist"), () => ({
    relayAddrs: [relay.addr],
    sessionOrigin: `https://{name}.localhost:${sessions.port}`,
    dev: true,
  }));
  bridge = await listenLoopback(createBridge({ token: TOKEN, allowedOrigin: page.origin }));
  browser = await launch(page, sessions);
});
afterAll(async () => {
  await browser?.close();
  await bridge?.close();
  await page?.close();
  await sessions?.close();
  await relay?.stop();
  await app?.close();
});

describe("PeerShare, end to end", () => {
  it("Dirk exposes his local app and invites Claudia; she sees it in her own isolated origin", async () => {
    await dirkSharesClaudiaViews({
      browser,
      pageOrigin: page.origin,
      bridge: { origin: bridge.origin, token: TOKEN },
      appOrigin: app.origin,
      sessionUrl: /^https:\/\/[a-z0-9]+\.localhost:/,
      ...(process.env.PEERSHARE_SCREENSHOTS != null
        ? { screenshots: process.env.PEERSHARE_SCREENSHOTS }
        : {}),
    });
  });
});
