/**
 * 06 — the link, end to end: what the Sharer copies is what a Guest joins with.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
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
import { decodeInvite, encodeInvite } from "../src/invite-link.js";

let app: Running;
let relay: Relay;
let sharer: Sharer;

beforeAll(async () => {
  app = await startService();
  relay = await startRelay();
  const upstream = createUpstream({ kind: "direct", target: app.origin });
  sharer = await startSharer({
    relayAddr: relay.addr,
    name: "Dirk",
    services: shareRouter({ services: () => [{ id: "foo", upstream }] }),
  });
}, 60_000);
afterAll(async () => {
  await sharer?.stop();
  await relay?.stop();
  await app?.close();
});

it("a Guest joins with nothing but the decoded link", async () => {
  const { id } = await sharer.invite();
  const link = encodeInvite("https://tools.sandclaw.ai/peer-share/invite", {
    relayAddrs: [relay.addr],
    sharerPeerId: sharer.peerId,
    invitationId: id,
    sharerName: "Dirk",
  });

  const invite = decodeInvite(link);
  expect(invite.sharerName).toBe("Dirk");
  const guest = await startGuest({
    relayAddr: invite.relayAddrs[0] ?? "",
    sharerPeerId: invite.sharerPeerId,
    invitationId: invite.invitationId,
  });
  try {
    const res = await guest.fetch(toSharer(invite.sharerPeerId, "/s/foo/echo/via-link"));
    expect(await res.json()).toMatchObject({ path: "/echo/via-link" });
  } finally {
    await guest.stop();
  }
}, 60_000);
