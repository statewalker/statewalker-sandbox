/**
 * 10 — Does the Guest come back after closing the tab, and not after Close session?
 *
 * "The tab" is the Guest's member; its saved identity is its private key.
 */

import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Running, startService } from "../../01-upstream-kinds/src/fixtures.js";
import { shareRouter } from "../../01-upstream-kinds/src/share-router.js";
import { createUpstream } from "../../01-upstream-kinds/src/upstreams.js";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../../05-tab-hub-invite/src/mesh.js";
import { joinOutcome } from "../src/guest-session.js";

let app: Running;
let relay: Relay;
let sharer: Sharer;
let now = Date.now();
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  app = await startService();
  relay = await startRelay();
  const upstream = createUpstream({ kind: "direct", target: app.origin });
  sharer = await startSharer({
    relayAddr: relay.addr,
    services: shareRouter({ services: () => [{ id: "foo", upstream }] }),
    now: () => now,
  });
}, 60_000);
afterAll(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
  await sharer?.stop();
  await relay?.stop();
  await app?.close();
});

const join = (invitationId?: string, privateKey?: Ed25519PrivateKey) =>
  startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    ...(invitationId != null ? { invitationId } : {}),
    ...(privateKey != null ? { privateKey } : {}),
  });

/** The failure a join ends in, as the Join screen would name it. */
async function outcomeOf(attempt: Promise<{ stop(): Promise<void> }>) {
  try {
    const guest = await attempt;
    cleanup.push(() => guest.stop());
    return "joined";
  } catch (error) {
    return joinOutcome(error);
  }
}

describe("10 — coming back", () => {
  it("closing the tab and reopening the link: back in, without the Invite", async () => {
    const savedIdentity = await generateKeyPair("Ed25519");
    const { id } = await sharer.invite();
    const first = await join(id, savedIdentity);
    await first.stop(); // the tab closes

    const again = await join(undefined, savedIdentity); // the saved identity, no Invite
    cleanup.push(() => again.stop());

    expect(again.joinedBy).toBe("resumed");
    expect((await again.fetch(toSharer(sharer.peerId, "/s/foo/echo/back"))).status).toBe(200);
  }, 60_000);

  it("after Close session (identity forgotten) the same link is spent: invite-used", async () => {
    const { id } = await sharer.invite();
    const guest = await join(id, await generateKeyPair("Ed25519"));
    await guest.stop(); // Close session: leave, and forget the key

    expect(await outcomeOf(join(id, await generateKeyPair("Ed25519")))).toBe("invite-used");
  }, 60_000);
});

describe("10 — why a join failed", () => {
  it("invite-expired: opened more than 24 h after it was made", async () => {
    const { id } = await sharer.invite();
    now += 24 * 60 * 60 * 1000 + 1;
    try {
      expect(await outcomeOf(join(id))).toBe("invite-expired");
    } finally {
      now = Date.now();
    }
  }, 60_000);

  it("machine-offline: the Sharer is not there", async () => {
    const upstream = createUpstream({ kind: "direct", target: app.origin });
    const gone = await startSharer({
      relayAddr: relay.addr,
      services: shareRouter({ services: () => [{ id: "foo", upstream }] }),
    });
    const { id } = await gone.invite();
    await gone.stop();

    const attempt = startGuest({
      relayAddr: relay.addr,
      sharerPeerId: gone.peerId,
      invitationId: id,
    });
    expect(await outcomeOf(attempt)).toBe("machine-offline");
  }, 90_000);
});
