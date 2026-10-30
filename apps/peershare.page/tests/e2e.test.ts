/**
 * End to end, in Chromium: Dirk shares his local app from the page; Claudia
 * opens his invite in another browser and sees the app in an isolated origin.
 * Two browser contexts: two separate IndexedDBs, two separate mesh nodes.
 */

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridge, type Listening, listenLoopback } from "@statewalker/httpeers-share/bridge";
import type { Browser, Frame, Page } from "playwright";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Hosted, launch, servePage, serveSessions, startRelay } from "./e2e-harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN = "peershare-e2e";
let app: { origin: string; close(): Promise<void> };
let relay: Awaited<ReturnType<typeof startRelay>>;
let page: Hosted;
let sessions: Hosted;
let bridge: Listening;
let browser: Browser;

beforeAll(async () => {
  await build({ root: resolve(here, ".."), logLevel: "error" });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Dirk's app</title><h1 id=hello>hello from Dirk's app</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  app = {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };

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

/** A browser of its own: its own storage, its own mesh node; "Allow" on the local-network prompt. */
async function person(): Promise<{ tab: Page; errors: string[] }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.grantPermissions(["local-network-access"]);
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (e) => errors.push(String(e)));
  return { tab, errors };
}

async function viewerFrame(tab: Page): Promise<Frame> {
  for (let i = 0; i < 300; i++) {
    const frame = tab
      .frames()
      .find(
        (f) => /^https:\/\/[a-z0-9]+\.localhost:/.test(f.url()) && !f.url().endsWith("/relay.html"),
      );
    if (frame != null) return frame;
    await tab.waitForTimeout(100);
  }
  throw new Error("no Viewer frame");
}

describe("PeerShare, end to end", () => {
  it("Dirk exposes his local app and invites Claudia; she sees it in her own isolated origin", async () => {
    const dirk = await person();
    await dirk.tab.goto(
      `${page.origin}/peer-share#localUrl=${encodeURIComponent(bridge.origin)}&t=${TOKEN}`,
    );
    await dirk.tab.getByText("Bridge connected").waitFor({ timeout: 30_000 });
    await dirk.tab.getByRole("button", { name: /Turn off server/ }).waitFor({ timeout: 60_000 }); // sharing

    await dirk.tab.getByLabel("Your name").fill("Dirk");
    await dirk.tab.getByLabel("Name", { exact: true }).fill("fooService");
    await dirk.tab.getByLabel("Local URL to expose").fill(app.origin);
    await dirk.tab.getByRole("button", { name: "Expose service" }).click();
    await dirk.tab.getByText("fooService").first().waitFor();

    await dirk.tab.getByRole("button", { name: /Invite Guest User/ }).click();
    const field = dirk.tab.getByLabel("Link", { exact: true });
    await field.waitFor({ timeout: 30_000 });
    const link = await field.inputValue();
    expect(link).toContain("from=Dirk");

    const claudia = await person();
    await claudia.tab.goto(link);
    await claudia.tab.getByRole("button", { name: /Join Dirk/ }).click();
    await claudia.tab.getByText("SandClaw.ai presents:").waitFor({ timeout: 60_000 });

    const frame = await viewerFrame(claudia.tab);
    await frame.getByText("hello from Dirk's app").waitFor({ timeout: 30_000 });
    expect(new URL(frame.url()).origin).not.toBe(page.origin);
    // And Dirk sees who joined.
    await dirk.tab.keyboard.press("Escape");
    await dirk.tab.getByText(/Guest \S{6}/).waitFor({ timeout: 10_000 });
    expect([...dirk.errors, ...claudia.errors]).toEqual([]);

    const shots = process.env.PEERSHARE_SCREENSHOTS;
    if (shots != null) {
      await dirk.tab.screenshot({ path: `${shots}/dirk.png`, fullPage: true });
      await claudia.tab.screenshot({ path: `${shots}/claudia.png`, fullPage: true });
    }
  });
});
