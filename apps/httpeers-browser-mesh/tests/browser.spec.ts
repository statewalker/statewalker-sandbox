/**
 * Two real browser tabs, one mesh.
 *
 *   npx playwright install chromium     # once
 *   npm run test:browser                # against relay.httpeers.net
 *   RELAY=http://127.0.0.1:9592 npm run test:browser        # a local relay
 *
 * WHAT THIS ADDS OVER `npm run verify:node`. The Node harness runs the same
 * `src/mesh.ts` and `src/hub.ts`, so the hub logic is already covered there.
 * What only a browser can establish is the part the product actually
 * depends on: that a TAB — no listening socket, no installed software —
 * reserves a slot on a public relay, is reached by another tab, upgrades
 * the circuit to WebRTC, and serves HTTP over it. If this fails while the
 * Node run passes, the difference is the browser, the relay, or ICE.
 *
 * NO MOCKS, AND NO SECOND RELAY. `RELAY` defaults to the deployed relay
 * because a test against a local one cannot tell you whether the deployment
 * works, and that is the question this file exists to answer.
 *
 * THE RELAY IS NAMED BY URL, NOT BY MULTIADDR. It publishes its addresses —
 * peer id included — at `/.well-known/httpeers-relay.json`, so nothing here
 * is kept in step with a deployment by hand. This also means the run exercises
 * the CORS header on that document: the page fetches it from its own origin,
 * and without `Access-Control-Allow-Origin` the guest tab fails at the first
 * step while curl against the same URL keeps working.
 *
 * STATUS 7 September 2026: WRITTEN AND TYPECHECKED, NEVER RUN. The machine
 * it was authored on reaches only npm and GitHub, so relay.httpeers.net was
 * unreachable from it. Treat the first run as the real test.
 */

import { expect, test } from "@playwright/test";

const RELAY = process.env.RELAY;
const relayParam = RELAY != null ? `&relay=${encodeURIComponent(RELAY)}` : "";

interface MeshState {
  ready: boolean;
  peerId?: string;
  address?: string;
  joinUrl?: string;
  results?: { label: string; ok: boolean; detail?: string }[];
  error?: string;
}

test("two in-browser peers: one hosts a hub, the other joins and they exchange resources", async ({
  browser,
}) => {
  // Separate contexts, not two pages in one: peers must not share storage or
  // a service worker, and a shared context would let a bug hide behind
  // state neither tab would have in reality.
  const hubContext = await browser.newContext();
  const guestContext = await browser.newContext();

  const hubPage = await hubContext.newPage();
  const guestPage = await guestContext.newPage();

  for (const [name, page] of [
    ["hub", hubPage],
    ["guest", guestPage],
  ] as const) {
    page.on("console", (msg) => console.log(`  [${name}] ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`  [${name}] pageerror: ${err.message}`));
  }

  // --- the hub tab -----------------------------------------------------
  await hubPage.goto(`/?role=hub${relayParam}`);
  await hubPage.waitForFunction(() => window.__mesh?.ready === true, undefined, {
    timeout: 60_000,
  });

  const hubState = (await hubPage.evaluate(() => window.__mesh)) as MeshState;
  expect(hubState.error, "the hub tab failed to start").toBeUndefined();
  expect(hubState.address, "the hub tab never got a circuit reservation").toContain("/p2p-circuit");
  console.log(`  hub address: ${hubState.address}`);

  const joinUrl = hubState.joinUrl;
  expect(joinUrl, "the hub tab published no join link").toBeTruthy();

  // --- the guest tab ---------------------------------------------------
  await guestPage.goto(joinUrl as string);
  await guestPage.waitForFunction(() => window.__mesh?.ready === true, undefined, {
    timeout: 90_000,
  });

  const guestState = (await guestPage.evaluate(() => window.__mesh)) as MeshState;
  expect(guestState.error, "the guest tab failed").toBeUndefined();

  for (const result of guestState.results ?? []) {
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.label}`);
  }

  // Assert per claim rather than on a single aggregate, so a failure names
  // the step that broke instead of "something in the cycle".
  const byLabel = new Map((guestState.results ?? []).map((r) => [r.label, r]));
  for (const label of [
    "the relay's addresses were discovered from its URL",
    "guest obtained a reservation",
    "a peer that has not joined is refused",
    "guest redeemed the invitation",
    "guest consumed the hub's resource",
    "the guest's own resource is advertised in the mesh view",
  ]) {
    expect(byLabel.get(label)?.ok, `${label} — ${byLabel.get(label)?.detail ?? "missing"}`).toBe(
      true,
    );
  }

  // --- the hub saw the guest -------------------------------------------
  await expect(hubPage.locator("#status")).toContainText("members: 1", { timeout: 15_000 });

  await guestContext.close();
  await hubContext.close();
});

declare global {
  interface Window {
    __mesh?: MeshState & { role: "hub" | "guest" };
  }
}
