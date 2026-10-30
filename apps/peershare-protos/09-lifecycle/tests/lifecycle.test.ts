/**
 * 09 — Do Stop, reload and Revoke behave as agreed?
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { memoryStorage } from "@statewalker/httpeers-hub";
import type { MemberHandle } from "@statewalker/httpeers-member";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Running, startService } from "../../01-upstream-kinds/src/fixtures.js";
import { shareRouter } from "../../01-upstream-kinds/src/share-router.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import {
  type Relay,
  type Sharer,
  type SharerInit,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../../05-tab-hub-invite/src/mesh.js";
import { isSharerOffline, revokeGuest } from "../src/lifecycle.js";

let app: Running;
let relay: Relay;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  app = await startService();
  relay = await startRelay();
}, 60_000);
afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
  await relay?.stop();
  await app?.close();
});

function sharerWith(extra: Partial<SharerInit> = {}): Promise<Sharer> {
  const upstream = createUpstream({ kind: "direct", target: app.origin });
  return startSharer({
    relayAddr: relay.addr,
    services: shareRouter({ services: () => [{ id: "foo", upstream }] }),
    ...extra,
  });
}

async function guestOf(sharer: Sharer, extra: { privateKey?: Ed25519PrivateKey } = {}) {
  const { id } = await sharer.invite();
  const guest = await startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    invitationId: id,
    ...extra,
  });
  cleanup.push(() => guest.stop());
  return guest;
}

const fooOf = (guest: MemberHandle, sharer: Sharer) =>
  guest.fetch(toSharer(sharer.peerId, "/s/foo/echo/x"));

/** Polls `check` until it holds or `ms` pass; returns how long it took. */
async function eventually(check: () => Promise<boolean>, ms: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check().catch(() => false)) return Date.now() - started;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`not within ${ms} ms`);
}

describe("09 — Revoke", () => {
  it("a revoked Guest's next request is refused", async () => {
    const sharer = await sharerWith();
    cleanup.push(() => sharer.stop());
    const guest = await guestOf(sharer);
    expect((await fooOf(guest, sharer)).status).toBe(200);

    revokeGuest(sharer, guest.peerId);

    const res = await fooOf(guest, sharer);
    expect([401, 403]).toContain(res.status);
  }, 60_000);
});

describe("09 — Stop", () => {
  it("a Guest's request to a stopped Sharer fails fast, as 'the Sharer is offline'", async () => {
    const sharer = await sharerWith();
    const guest = await guestOf(sharer);
    expect((await fooOf(guest, sharer)).status).toBe(200);

    await sharer.stop();

    const started = Date.now();
    const res = await fooOf(guest, sharer);
    const ms = Date.now() - started;
    expect(await isSharerOffline(res)).toBe(true);
    expect(ms).toBeLessThan(10_000);
  }, 60_000);
});

describe("09 — the Sharer reloads", () => {
  it("same key and storage: same peer id, and the SAME Guest gets back in without an Invite", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    const storage = memoryStorage();
    const before = await sharerWith({ privateKey, storage });
    const guest = await guestOf(before);
    expect((await fooOf(guest, before)).status).toBe(200);

    await before.stop();
    const after = await sharerWith({ privateKey, storage });
    cleanup.push(() => after.stop());

    expect(after.peerId).toBe(before.peerId);
    const ms = await eventually(async () => (await fooOf(guest, after)).status === 200, 30_000);
    console.log(`the Guest was back ${ms} ms after the Sharer restarted`);
  }, 90_000);
});
