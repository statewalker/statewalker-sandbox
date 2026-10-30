/**
 * 08 — Does a real web app run unmodified in its own isolated origin?
 *
 * Chromium, the vendored session-shell, the real mesh, the real Bridge:
 *   Viewer page (public https) → session origin `<name>.localhost` (its
 *   ServiceWorker answers every request) → the Viewer's handler → the Guest
 *   (stand-in edge, see src/guest-edge.ts) → mesh → the Sharer → `/s/app` →
 *   the Bridge → Dirk's SPA.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemberHandle } from "@statewalker/httpeers-member";
import type { Browser, Frame, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import { createBridge } from "../../02-bridge-lockdown/src/bridge.js";
import { type Listening, listenLoopback } from "../../02-bridge-lockdown/src/serve.js";
import {
  launchChromium,
  openPage,
  type PublicPage,
  startPublicPage,
} from "../../03-local-network-access/src/harness.js";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
} from "../../05-tab-hub-invite/src/mesh.js";
import { serviceTable } from "../../07-advertised-services/src/service-table.js";
import { type GuestEdge, startGuestEdge } from "../src/guest-edge.js";
import { type SessionServer, startSessionServer } from "../src/session-server.js";
import { startSpa } from "../src/spa.js";

const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../src/browser-entry.ts");
const TOKEN = "pairing-token-08";

let spa: Running;
let bridge: Listening;
let relay: Relay;
let sharer: Sharer;
let guest: MemberHandle;
let site: PublicPage;
let edge: GuestEdge;
let sessions: SessionServer;
let browser: Browser;
let appEnabled = true;

beforeAll(async () => {
  spa = await startSpa();
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai" }),
  );
  relay = await startRelay({ limits: "httpeers" });
  const upstream = () =>
    createUpstream({
      kind: "bridged",
      target: spa.origin,
      bridge: { base: bridge.origin, token: TOKEN },
    });
  sharer = await startSharer({
    relayAddr: relay.addr,
    name: "Dirk",
    services: serviceTable(
      () => [
        {
          id: "app",
          name: "Dirk's app",
          upstream: upstream(),
          enabled: appEnabled,
          isDefault: true,
        },
        { id: "wiki", name: "Wiki", upstream: upstream(), enabled: true, isDefault: false },
      ],
      { sharerName: "Dirk" },
    ),
  });
  const { id } = await sharer.invite();
  guest = await startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    invitationId: id,
  });
  site = await startPublicPage();
  edge = await startGuestEdge(guest, site.origin);
  sessions = await startSessionServer();
  browser = await launchChromium([`127.0.0.1:${site.port}=public`], [sessions.spki]);
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await sessions?.close();
  await edge?.close();
  await site?.close();
  await guest?.stop();
  await sharer?.stop();
  await relay?.stop();
  await bridge?.close();
  await spa?.close();
});

/** The Viewer page, with `serviceIds` opened in it; returns each Service's frame. */
async function viewer(
  serviceIds: string[],
): Promise<{ page: Page; frames: Frame[]; origins: string[] }> {
  const { page } = await openPage(browser, site.origin, {
    grant: true,
    entry: ENTRY,
    name: "Rung08",
  });
  await page.evaluate(() => localStorage.setItem("peershare-identity", "the Guest's key"));
  const origins: string[] = [];
  for (const serviceId of serviceIds) {
    const { origin } = await page.evaluate(
      (init) =>
        (
          window as unknown as { Rung08: typeof import("../src/browser-entry.js") }
        ).Rung08.openViewer(init),
      {
        edge: edge.origin,
        sharerPeerId: sharer.peerId,
        serviceId,
        sessionOrigin: `https://{name}.localhost:${sessions.port}`,
      },
    );
    origins.push(origin);
  }
  const frames: Frame[] = [];
  for (const origin of origins) frames.push(await frameAt(page, origin));
  return { page, frames, origins };
}

/** The Viewer's frame for `origin` (not the session's hidden relay frame, same origin), once it has navigated. */
async function frameAt(page: Page, origin: string): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page
      .frames()
      .find((f) => f.url().startsWith(origin) && !f.url().endsWith("/relay.html"));
    if (frame != null) return frame;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no Viewer frame for ${origin}`);
}

/** Waits for the SPA to finish its API call, then reads what it reported. */
async function spaReport(frame: Frame) {
  await frame.waitForFunction(
    () => document.getElementById("out")?.textContent !== "loading",
    null,
    {
      timeout: 15_000,
    },
  );
  return frame.evaluate(() => {
    const out = document.getElementById("out") as HTMLElement;
    return {
      text: out.textContent,
      color: getComputedStyle(out).color,
      origin: out.dataset.origin,
      identity: out.dataset.identity,
      mine: out.dataset.mine,
      parent: out.dataset.parent,
    };
  });
}

describe("08 — Dirk's app in the Viewer", () => {
  it("renders unmodified: absolute asset paths load, its API call is answered over the mesh", async () => {
    const { page, frames, origins } = await viewer(["app"]);
    try {
      const report = await spaReport(frames[0] as Frame);

      expect(report.text).toBe("hello from Dirk's app");
      expect(report.color).toBe("rgb(1, 2, 3)"); // /assets/app.css
      expect(report.origin).toBe(origins[0]);
      expect(origins[0]).not.toBe(site.origin);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it("cannot reach the Viewer: not its storage (the Guest's key), not its DOM", async () => {
    const { page, frames } = await viewer(["app"]);
    try {
      const report = await spaReport(frames[0] as Frame);

      expect(report.identity).toBe("null");
      expect(report.parent).toBe("blocked");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it("two Services: two origins, and neither sees the other's storage", async () => {
    const { page, frames, origins } = await viewer(["app", "wiki"]);
    try {
      const [app, wiki] = await Promise.all(frames.map(spaReport));

      expect(origins[0]).not.toBe(origins[1]);
      expect(app?.mine).toBe("null");
      expect(wiki?.mine).toBe("null"); // app wrote "app-note" in ITS origin only
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it("a redirect the app writes absolutely to itself keeps the Guest in their origin", async () => {
    const { page, frames, origins } = await viewer(["app"]);
    try {
      const frame = frames[0] as Frame;
      await spaReport(frame);
      // From inside the app, as a link would: the shell refuses a navigation
      // without the session's own Referer (Playwright's `goto` sends none).
      await frame.evaluate(() => {
        location.href = "/login";
      });
      await frame.waitForURL(`${origins[0]}/landed`, { timeout: 15_000 });

      expect(frame.url()).toBe(`${origins[0]}/landed`);
      expect((await spaReport(frame)).text).toBe("hello from Dirk's app");
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it("Pause shows inside the Viewer as Dirk's paused page", async () => {
    appEnabled = false;
    const { page, frames } = await viewer(["app"]);
    try {
      const frame = frames[0] as Frame;
      await frame.waitForFunction(() => document.body?.textContent?.includes("paused"), null, {
        timeout: 15_000,
      });
      expect(await frame.textContent("body")).toContain("Dirk paused Dirk's app");
    } finally {
      appEnabled = true;
      await page.context().close();
    }
  }, 60_000);

  it("SHELL FACT: a navigation with no Referer (typed, pasted, or Playwright's goto) is refused", async () => {
    const { page, frames, origins } = await viewer(["app"]);
    try {
      const response = await (frames[0] as Frame).goto(`${origins[0]}/`);
      expect(response?.status()).toBe(403);
      expect(response?.headers()["x-httpeers-session"]).toBe("shell");
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
