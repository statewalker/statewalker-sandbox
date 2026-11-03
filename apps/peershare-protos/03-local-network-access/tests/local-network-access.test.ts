/**
 * 03 — What does Chromium actually do when a public https page calls 127.0.0.1?
 *
 * Real Chromium (Playwright), a public https page, the real Bridge (rung 02)
 * and a real Service (rung 01's fixture). Headless Chromium cannot show the
 * Local Network Access prompt: an unanswered prompt is refused at once, and
 * `grant: true` stands for the Sharer clicking "Allow".
 */

import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deadOrigin, type Running, startService } from "../../01-upstream-kinds/src/fixtures.js";
import { createBridge } from "../../02-bridge-lockdown/src/bridge.js";
import { type Listening, listenLoopback } from "../../02-bridge-lockdown/src/serve.js";
import type { BridgeDiagnosis } from "../src/diagnose.js";
import {
  lanAddress,
  launchChromium,
  openPage,
  type PublicPage,
  startLanService,
  startPublicPage,
} from "../src/harness.js";

const TOKEN = "pairing-token-03";

let service: Running;
let site: PublicPage;
let bridge: Listening;
let browser: Browser;
/** Every request that actually arrived at the Bridge. */
const reachedBridge: { method: string; pna: string | null }[] = [];

beforeAll(async () => {
  service = await startService();
  site = await startPublicPage();
  const handler = createBridge({ token: TOKEN, allowedOrigin: site.origin });
  bridge = await listenLoopback(async (request) => {
    reachedBridge.push({
      method: request.method,
      pna: request.headers.get("access-control-request-private-network"),
    });
    return handler(request);
  });
  browser = await launchChromium([`127.0.0.1:${site.port}=public`]);
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await bridge?.close();
  await site?.close();
  await service?.close();
});

/** `diagnoseBridge` run inside the public page. */
async function diagnoseInPage(opts: { grant: boolean; localUrl?: string; token?: string }) {
  const { page, context } = await openPage(browser, site.origin, { grant: opts.grant });
  try {
    return await page.evaluate(
      (init) =>
        (
          window as unknown as {
            Rung03: { diagnoseBridge(i: typeof init): Promise<BridgeDiagnosis> };
          }
        ).Rung03.diagnoseBridge(init),
      { localUrl: opts.localUrl ?? bridge.origin, token: opts.token ?? TOKEN },
    );
  } finally {
    await context.close();
  }
}

describe("03 — the page diagnoses its Bridge", () => {
  it("ok: allowed, running, and the token is right", async () => {
    expect(await diagnoseInPage({ grant: true })).toBe("ok");
  });

  it("permission-needed: the Sharer has not allowed local network access", async () => {
    expect(await diagnoseInPage({ grant: false })).toBe("permission-needed");
  });

  it("bridge-not-running: allowed, but nothing listens where the Bridge should be", async () => {
    const dead = await deadOrigin();
    expect(await diagnoseInPage({ grant: true, localUrl: dead })).toBe("bridge-not-running");
  });

  it("token-rejected: the Bridge runs, but was restarted with a new token", async () => {
    expect(await diagnoseInPage({ grant: true, token: "token-from-last-launch" })).toBe(
      "token-rejected",
    );
  });
});

describe("03 — Way A in the browser: rung 01's Bridged upstream through the real Bridge", () => {
  /** A Guest's request, answered inside the page by a Bridged Service `foo`. */
  async function guestRequest(path: string) {
    const { page, context } = await openPage(browser, site.origin, { grant: true });
    try {
      return await page.evaluate(
        async ({ path, target, base, token }) => {
          const { Rung03 } = window as unknown as {
            Rung03: typeof import("../src/browser-entry.js");
          };
          const upstream = Rung03.createUpstream({
            kind: "bridged",
            target,
            bridge: { base, token },
          });
          const router = Rung03.shareRouter({ services: () => [{ id: "foo", upstream }] });
          const res = await router(new Request(`${location.origin}/s/foo${path}`));
          return {
            status: res.status,
            marker: res.headers.get("x-peershare-bridge"),
            location: res.headers.get("location"),
            body: await res.text(),
          };
        },
        { path, target: service.origin, base: bridge.origin, token: TOKEN },
      );
    } finally {
      await context.close();
    }
  }

  it("reaches the Service, and the page can read that the Bridge relayed it", async () => {
    const res = await guestRequest("/echo/hello");

    expect(res.status).toBe(200);
    expect(res.marker).toBe("relayed");
    expect(JSON.parse(res.body)).toMatchObject({ path: "/echo/hello" });
  });

  it("a Service's redirect reaches the Guest as a real 302 inside their origin", async () => {
    const res = await guestRequest("/redirect-self");

    expect(res.status).toBe(302);
    expect(res.location).toBe("/echo/landed?from=redirect");
  });

  it("BROWSER FACT: a manual redirect is opaque even same-origin, which is why the Bridge restates it", async () => {
    const { page, context } = await openPage(browser, site.origin);
    try {
      const seen = await page.evaluate(async () => {
        const res = await fetch("/redirect", { redirect: "manual" });
        return { type: res.type, status: res.status, location: res.headers.get("location") };
      });
      expect(seen).toEqual({ type: "opaqueredirect", status: 0, location: null });
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(lanAddress() == null)("03 — Way B: a Direct Service on the LAN", () => {
  it("is reached from the https page through rung 01's Direct upstream", async () => {
    const host = lanAddress() as string;
    const nas = await startLanService(host);
    const lanBrowser = await launchChromium([
      `127.0.0.1:${site.port}=public`,
      `${host}:${nas.port}=private`,
    ]);
    try {
      const { page, console } = await openPage(lanBrowser, site.origin, { grant: true });
      const result = await page.evaluate(async (target) => {
        const { Rung03 } = window as unknown as {
          Rung03: typeof import("../src/browser-entry.js");
        };
        const upstream = Rung03.createUpstream({ kind: "direct", target });
        const router = Rung03.shareRouter({ services: () => [{ id: "nas", upstream }] });
        const res = await router(new Request(`${location.origin}/s/nas/photos`));
        return { status: res.status, body: await res.text() };
      }, nas.origin);

      expect(result.status, console.join("\n")).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ service: "nas", path: "/photos" });
    } finally {
      await lanBrowser.close();
      await nas.close();
    }
  });
});

describe("03 — BROWSER FACTS (Chromium 153), recorded so a change in Chromium fails here", () => {
  it("without permission, nothing reaches the Bridge, and the console says why", async () => {
    const { page, context, console } = await openPage(browser, site.origin);
    reachedBridge.length = 0;
    try {
      const error = await page.evaluate(
        (url) =>
          fetch(url).then(
            () => "fetched",
            (e: Error) => e.message,
          ),
        `${bridge.origin}/`,
      );
      expect(error).toBe("Failed to fetch");
      expect(reachedBridge).toEqual([]);
      expect(console.join("\n")).toContain("Permission was denied for this request");
    } finally {
      await context.close();
    }
  });

  it("with permission, no Private Network Access preflight header is sent any more", async () => {
    const { page, context } = await openPage(browser, site.origin, { grant: true });
    reachedBridge.length = 0;
    try {
      await page.evaluate(
        (init) => fetch(`${init.url}/`, { headers: { "x-peershare-bridge-token": init.token } }),
        { url: bridge.origin, token: TOKEN },
      );
      expect(reachedBridge.map((r) => r.method)).toEqual(["OPTIONS", "GET"]);
      expect(reachedBridge.every((r) => r.pna == null)).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("granting local-network-access grants all three names Chromium knows", async () => {
    const { page, context } = await openPage(browser, site.origin, { grant: true });
    try {
      const states = await page.evaluate(async () => {
        const out: Record<string, string> = {};
        for (const name of ["local-network-access", "local-network", "loopback-network"]) {
          out[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
        }
        return out;
      });
      expect(states).toEqual({
        "local-network-access": "granted",
        "local-network": "granted",
        "loopback-network": "granted",
      });
    } finally {
      await context.close();
    }
  });
});
