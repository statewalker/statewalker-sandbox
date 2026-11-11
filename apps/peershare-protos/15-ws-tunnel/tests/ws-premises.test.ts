/**
 * 15 (spike) — Could a WebSocket from the isolated origin be carried over the mesh?
 *
 * Two premises, measured; carrying the socket is left open (README).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemberHandle } from "@statewalker/httpeers-member";
import type { Browser, Frame, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
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
import { type GuestEdge, startGuestEdge } from "../../08-isolated-viewer/src/guest-edge.js";
import {
  type SessionServer,
  startSessionServer,
} from "../../08-isolated-viewer/src/session-server.js";
import { startSpa } from "../../08-isolated-viewer/src/spa.js";

const ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../08-isolated-viewer/src/browser-entry.ts",
);
let spa: Running;
let relay: Relay;
let sharer: Sharer;
let guest: MemberHandle;
let site: PublicPage;
let edge: GuestEdge;
let sessions: SessionServer;
let browser: Browser;

beforeAll(async () => {
  spa = await startSpa();
  relay = await startRelay({ limits: "httpeers" });
  const upstream = createUpstream({ kind: "direct", target: spa.origin });
  sharer = await startSharer({
    relayAddr: relay.addr,
    services: serviceTable(() => [
      { id: "app", name: "app", upstream, enabled: true, isDefault: true },
    ]),
  });
  guest = await startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    invitationId: (await sharer.invite()).id,
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
  await spa?.close();
});

async function appFrame(
  injectWsShim: boolean,
): Promise<{ page: Page; frame: Frame; origin: string }> {
  const { page } = await openPage(browser, site.origin, {
    grant: true,
    entry: ENTRY,
    name: "Rung08",
  });
  const { origin } = await page.evaluate(
    (init) =>
      (
        window as unknown as {
          Rung08: typeof import("../../08-isolated-viewer/src/browser-entry.js");
        }
      ).Rung08.openViewer(init),
    {
      edge: edge.origin,
      sharerPeerId: sharer.peerId,
      serviceId: "app",
      sessionOrigin: `https://{name}.localhost:${sessions.port}`,
      injectWsShim,
    },
  );
  for (let i = 0; i < 100; i++) {
    const frame = page
      .frames()
      .find((f) => f.url().startsWith(origin) && !f.url().endsWith("/relay.html"));
    if (frame != null) {
      await frame.waitForFunction(
        () => (document.getElementById("out")?.textContent ?? "loading") !== "loading",
      );
      return { page, frame, origin };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no frame");
}

describe("15 — WebSockets in the isolated origin", () => {
  it("BROWSER FACT: a socket the app opens goes to the session's HOST, past its ServiceWorker and the mesh", async () => {
    const { page, frame, origin } = await appFrame(false);
    try {
      sessions.upgrades.length = 0;
      await frame.evaluate((o) => {
        new WebSocket(`${o.replace("https:", "wss:")}/live`);
      }, origin);
      await expect.poll(() => sessions.upgrades.length, { timeout: 5_000 }).toBe(1);
      expect(sessions.upgrades[0]).toBe(`${new URL(origin).host}/live`);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  it("the hook exists: the Viewer can install a WebSocket shim before the app's scripts run", async () => {
    const { page, frame, origin } = await appFrame(true);
    try {
      sessions.upgrades.length = 0;
      const seen = await frame.evaluate((o) => {
        new WebSocket(`${o.replace("https:", "wss:")}/live`);
        const w = window as unknown as {
          WebSocket: { peershare?: boolean };
          __peershareSockets?: string[];
        };
        return { shim: w.WebSocket.peershare === true, sockets: w.__peershareSockets ?? [] };
      }, origin);
      expect(seen.shim).toBe(true);
      expect(seen.sockets).toEqual([`${origin.replace("https:", "wss:")}/live`]);
      // The app still renders with the shim in front of it.
      expect(await frame.textContent("#out")).toBe("hello from Dirk's app");
      await new Promise((r) => setTimeout(r, 500));
      expect(sessions.upgrades).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
