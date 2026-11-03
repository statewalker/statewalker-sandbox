/**
 * 05 — Can a Sharer-hosted hub mint a one-time, 24 h Invite to all Services?
 *
 * The whole Way A pipeline, for real: a Guest on the mesh → the Sharer (the
 * hub) → `/s` → the Bridge → Dirk's app.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Running, startService } from "../../01-upstream-kinds/src/fixtures.js";
import { shareRouter } from "../../01-upstream-kinds/src/share-router.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import { createBridge } from "../../02-bridge-lockdown/src/bridge.js";
import { type Listening, listenLoopback } from "../../02-bridge-lockdown/src/serve.js";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../src/mesh.js";

const TOKEN = "pairing-token-05";
let app: Running;
let bridge: Listening;
let relay: Relay;
let sharer: Sharer;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  app = await startService();
  bridge = await listenLoopback(
    createBridge({ token: TOKEN, allowedOrigin: "https://tools.sandclaw.ai" }),
  );
  relay = await startRelay();
  const upstream = createUpstream({
    kind: "bridged",
    target: app.origin,
    bridge: { base: bridge.origin, token: TOKEN },
  });
  sharer = await startSharer({
    relayAddr: relay.addr,
    name: "Dirk",
    services: shareRouter({ services: () => [{ id: "foo", upstream }] }),
  });
}, 60_000);
afterAll(async () => {
  for (const stop of stops.reverse()) await stop().catch(() => {});
  await sharer?.stop();
  await relay?.stop();
  await bridge?.close();
  await app?.close();
});

describe("05 — Invite and join", () => {
  it("a redeemed Invite makes a Guest, who reaches Dirk's app through the mesh", async () => {
    const invite = await sharer.invite();
    const guest = await startGuest({
      relayAddr: relay.addr,
      sharerPeerId: sharer.peerId,
      invitationId: invite.id,
    });
    stops.push(() => guest.stop());

    const res = await guest.fetch(toSharer(sharer.peerId, "/s/foo/echo/hello?from=claudia"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-peershare-bridge")).toBe("relayed");
    expect(await res.json()).toMatchObject({
      service: "dirk",
      path: "/echo/hello",
      query: "?from=claudia",
    });
  }, 60_000);

  it("the same Invite a second time is refused: it works once", async () => {
    const invite = await sharer.invite();
    const first = await startGuest({
      relayAddr: relay.addr,
      sharerPeerId: sharer.peerId,
      invitationId: invite.id,
    });
    stops.push(() => first.stop());

    await expect(
      startGuest({ relayAddr: relay.addr, sharerPeerId: sharer.peerId, invitationId: invite.id }),
    ).rejects.toThrow();
    expect(sharer.hub.invitations.status(invite.id)).toBe("redeemed");
  }, 60_000);

  it("a Guest may reach the Services, but not the hub's admin endpoints", async () => {
    const invite = await sharer.invite();
    const guest = await startGuest({
      relayAddr: relay.addr,
      sharerPeerId: sharer.peerId,
      invitationId: invite.id,
    });
    stops.push(() => guest.stop());

    const admin = await guest.fetch(toSharer(sharer.peerId, "/admin/members"));
    expect(admin.status).toBe(403);
  }, 60_000);

  it("a stranger with no Invite reaches nothing", async () => {
    await expect(
      startGuest({ relayAddr: relay.addr, sharerPeerId: sharer.peerId }),
    ).rejects.toThrow();
  }, 60_000);
});

describe("05 — 24 hours", () => {
  it("an Invite not used within 24 h is refused", async () => {
    let now = Date.now();
    const clocked = await startSharer({
      relayAddr: relay.addr,
      services: shareRouter({ services: () => [] }),
      now: () => now,
    });
    stops.push(() => clocked.stop());
    const invite = await clocked.invite();
    expect(invite.expiresAt - now).toBe(24 * 60 * 60 * 1000);

    now += 24 * 60 * 60 * 1000 + 1;
    expect(clocked.hub.invitations.status(invite.id)).toBe("expired");
    await expect(
      startGuest({ relayAddr: relay.addr, sharerPeerId: clocked.peerId, invitationId: invite.id }),
    ).rejects.toThrow();
  }, 60_000);
});
