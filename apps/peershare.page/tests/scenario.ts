/**
 * The usage scenario, as a person drives it, against any deployment of the
 * page: Dirk shares his local app and invites Claudia; she sees it in her own
 * isolated origin; Dirk sees her in his Guests list.
 */

import type { Browser, Frame, Page } from "playwright";
import { expect } from "vitest";

export interface ScenarioInit {
  browser: Browser;
  pageOrigin: string;
  bridge: { origin: string; token: string };
  /** Dirk's local app. */
  appOrigin: string;
  /** Matches a session origin's URL. */
  sessionUrl: RegExp;
  screenshots?: string;
}

async function person(browser: Browser): Promise<{ tab: Page; errors: string[] }> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.grantPermissions(["local-network-access"]);
  const tab = await context.newPage();
  const errors: string[] = [];
  tab.on("pageerror", (e) => errors.push(String(e)));
  return { tab, errors };
}

async function viewerFrame(tab: Page, sessionUrl: RegExp): Promise<Frame> {
  for (let i = 0; i < 300; i++) {
    const frame = tab
      .frames()
      .find((f) => sessionUrl.test(f.url()) && !f.url().endsWith("/relay.html"));
    if (frame != null) return frame;
    await tab.waitForTimeout(100);
  }
  throw new Error("no Viewer frame");
}

export async function dirkSharesClaudiaViews(init: ScenarioInit): Promise<void> {
  const dirk = await person(init.browser);
  await dirk.tab.goto(
    `${init.pageOrigin}/peer-share#localUrl=${encodeURIComponent(init.bridge.origin)}&t=${init.bridge.token}`,
  );
  await dirk.tab.getByText("Bridge connected").waitFor({ timeout: 30_000 });
  await dirk.tab.getByRole("button", { name: /Turn off server/ }).waitFor({ timeout: 60_000 }); // sharing

  await dirk.tab.getByLabel("Your name").fill("Dirk");
  await dirk.tab.getByLabel("Name", { exact: true }).fill("fooService");
  await dirk.tab.getByLabel("Local URL to expose").fill(init.appOrigin);
  await dirk.tab.getByRole("button", { name: "Expose service" }).click();
  await dirk.tab.getByText("fooService").first().waitFor();

  await dirk.tab.getByRole("button", { name: /Invite Guest User/ }).click();
  const field = dirk.tab.getByLabel("Link", { exact: true });
  await field.waitFor({ timeout: 30_000 });
  const link = await field.inputValue();
  expect(link).toContain("from=Dirk");

  const claudia = await person(init.browser);
  await claudia.tab.goto(link);
  await claudia.tab.getByRole("button", { name: /Join Dirk/ }).click();
  await claudia.tab.getByText("SandClaw.ai presents:").waitFor({ timeout: 60_000 });

  const frame = await viewerFrame(claudia.tab, init.sessionUrl);
  await frame.getByText("hello from Dirk's app").waitFor({ timeout: 30_000 });
  expect(new URL(frame.url()).origin).not.toBe(init.pageOrigin);
  // And Dirk sees who joined.
  await dirk.tab.keyboard.press("Escape");
  await dirk.tab.getByText(/Guest \S{6}/).waitFor({ timeout: 10_000 });
  expect([...dirk.errors, ...claudia.errors]).toEqual([]);

  if (init.screenshots != null) {
    await dirk.tab.screenshot({ path: `${init.screenshots}/dirk.png`, fullPage: true });
    await claudia.tab.screenshot({ path: `${init.screenshots}/claudia.png`, fullPage: true });
  }
  await dirk.tab.context().close();
  await claudia.tab.context().close();
}

/** Dirk's local app. */
export async function startDirksApp(): Promise<{ origin: string; close(): Promise<void> }> {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Dirk's app</title><h1 id=hello>hello from Dirk's app</h1>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
