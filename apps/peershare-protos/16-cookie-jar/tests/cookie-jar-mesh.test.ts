/**
 * 16 (spike) — cookie jars end to end: two real Guests on the mesh.
 */

import type { MemberHandle } from "@statewalker/httpeers-member";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Running } from "../../01-upstream-kinds/src/fixtures.js";
import { BRIDGE_GUEST_HEADER, createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import { createBridge } from "../../02-bridge-lockdown/src/bridge.js";
import { type Listening, listenLoopback } from "../../02-bridge-lockdown/src/serve.js";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../../05-tab-hub-invite/src/mesh.js";
import { serviceTable } from "../../07-advertised-services/src/service-table.js";
import { startLoginApp } from "../src/login-app.js";
import { stampGuest } from "../src/stamp-guest.js";

const TOKEN = "pairing-token-16m";
let app: Running;
let bridge: Listening;
let relay: Relay;
let sharer: Sharer;
let claudia: MemberHandle;
let marta: MemberHandle;

beforeAll(async () => {
  app = await startLoginApp();
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai", cookieJars: true }),
  );
  relay = await startRelay();
  const upstream = createUpstream({
    kind: "bridged",
    target: app.origin,
    bridge: { base: bridge.origin, token: TOKEN },
  });
  sharer = await startSharer({
    relayAddr: relay.addr,
    services: stampGuest(
      serviceTable(() => [{ id: "app", name: "app", upstream, enabled: true, isDefault: true }]),
    ),
  });
  const join = async () =>
    startGuest({
      relayAddr: relay.addr,
      sharerPeerId: sharer.peerId,
      invitationId: (await sharer.invite()).id,
    });
  claudia = await join();
  marta = await join();
}, 60_000);
afterAll(async () => {
  for (const stop of [
    () => claudia?.stop(),
    () => marta?.stop(),
    () => sharer?.stop(),
    () => relay?.stop(),
  ]) {
    await stop()?.catch(() => {});
  }
  await bridge?.close();
  await app?.close();
});

const get = (guest: MemberHandle, path: string, headers: Record<string, string> = {}) =>
  guest.fetch(toSharer(sharer.peerId, `/s/app${path}`, { headers })).then((r) => r.text());

describe("16 — cookie logins over the mesh", () => {
  it("Claudia logs in and stays logged in; Marta does not inherit it", async () => {
    await get(claudia, "/login?user=claudia");

    expect(await get(claudia, "/whoami")).toBe("claudia");
    expect(await get(marta, "/whoami")).toBe("anonymous");
  }, 30_000);

  it("Marta cannot claim Claudia's jar by sending her peer id herself", async () => {
    expect(await get(marta, "/whoami", { [BRIDGE_GUEST_HEADER]: claudia.peerId })).toBe(
      "anonymous",
    );
  }, 30_000);
});
