/**
 * 12 — The whole hub protocol as HTTP, tested with DIRECT calls.
 *
 * The directive: "All hub functionalities including invitations, revocations,
 * presence, tokens renewals etc should be implemented as HTTP handlers and the
 * corresponding client calls (with fetch) without implication of libp2p
 * layers… Ideally the full set of these functionalities should be implemented
 * and tested locally using fetch handlers with direct calls, and after that
 * re-configured and tested over MessagePorts and P2P connections."
 *
 * This file is the "locally, with direct calls" half. There is no transport
 * here at all: the client calls the site's handler as a function. If the
 * membership lifecycle cannot be driven this way, it is coupled to something
 * it should not be — which is the whole claim.
 *
 * RED FIRST: neither `hub-site.ts` nor `hub-client.ts` existed when this was
 * written.
 */

import { createMemberStore } from "@statewalker/httpeers.core";
import { generateMeshKey } from "@statewalker/httpeers.core/tokens";
import { createHubState } from "@statewalker/httpeers-stack/src/hub/hub-state.js";
import { appRules } from "@statewalker/httpeers-stack/src/policy.js";
import { peerIdOf } from "@statewalker/httpeers-stack/src/setup/keys.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createHubClient, type HubClient } from "../src/hub-client.js";
import { createHubSite, type HubSite } from "../src/hub-site.js";

const ALICE = "12D3KooWPbzaA61nmJyktyUaszpxftMLqrCh7Yd1UvJ9ZuQJYnBZ";
const BOB = "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR";

const PRESENCE_TTL_MS = 2_000;

/** A hub, and a client for each member, all in one process with no transport. */
async function standUpHub() {
  const meshKey = await generateMeshKey();
  const mesh = peerIdOf(meshKey);
  const rules = appRules([]);

  // The proven state pieces, reused: invitations and members over a snapshot.
  const snapshot = { value: { members: [], spentInvitationIds: [] } as never };
  const state = createHubState({
    store: {
      read: () => snapshot.value,
      write: (next) => {
        snapshot.value = next as never;
      },
    },
    rules,
    createMemberStore,
  });

  /**
   * WHO IS CALLING, as a per-request seam. On this rung it is a CLAIM: the
   * client puts its peer id in a header and nothing can contradict it. On
   * libp2p the same seam is filled by the proven peer. The hub's code does
   * not change between the two, and that is the property under test.
   */
  const site: HubSite = createHubSite({
    mesh,
    meshKey,
    state,
    rules,
    presenceTtlMs: PRESENCE_TTL_MS,
    callerOf: (request) => request.headers.get("x-test-peer") ?? undefined,
  });

  const clientFor = (peerId: string): HubClient =>
    createHubClient({
      // No transport: the "fetch" a client is given is the handler itself.
      fetch: (request) => {
        const withPeer = new Request(request, { headers: request.headers });
        withPeer.headers.set("x-test-peer", peerId);
        return site.handler(withPeer);
      },
      peerId,
    });

  return { mesh, state, site, clientFor };
}

describe("12 — the hub protocol over direct calls", () => {
  let hub: Awaited<ReturnType<typeof standUpHub>>;
  let alice: HubClient;
  let bob: HubClient;

  beforeEach(async () => {
    hub = await standUpHub();
    alice = hub.clientFor(ALICE);
    bob = hub.clientFor(BOB);
  });

  it("CLAIM 1 — a member redeems an invitation over HTTP and receives a token", async () => {
    const invitation = hub.site.invite({ roles: ["member"] });
    const joined = await alice.redeem(invitation.id);
    expect(joined.mesh).toBe(hub.mesh);
    expect(joined.roles).toEqual(["member"]);
    expect(joined.token.length).toBeGreaterThan(0);
  });

  it("CLAIM 2 — an invitation is single-use, and the refusal says why", async () => {
    const invitation = hub.site.invite({ roles: ["member"] });
    await alice.redeem(invitation.id);
    await expect(bob.redeem(invitation.id)).rejects.toThrow(/already-redeemed/i);
  });

  it("CLAIM 3 — an unknown invitation is refused rather than granted", async () => {
    await expect(alice.redeem("not-an-invitation")).rejects.toThrow(/not-found/i);
  });

  it("CLAIM 4 — a heartbeat RENEWS the token and reports versions", async () => {
    const invitation = hub.site.invite({ roles: ["member"] });
    const joined = await alice.redeem(invitation.id);

    const beat = await alice.heartbeat({ seq: 1, addrs: ["/ip4/127.0.0.1/tcp/1"] });
    expect(beat.token.length).toBeGreaterThan(0);
    // A fresh token on every beat is what makes the rotation in the edge work.
    expect(beat.token).not.toBe(joined.token);
    expect(beat.versions.mesh).toBeGreaterThan(0);
    expect(beat.ttl).toBe(PRESENCE_TTL_MS);
  });

  it("CLAIM 5 — a stale sequence number is refused", async () => {
    const invitation = hub.site.invite({ roles: ["member"] });
    await alice.redeem(invitation.id);
    await alice.heartbeat({ seq: 5, addrs: [] });
    await expect(alice.heartbeat({ seq: 4, addrs: [] })).rejects.toThrow(/stale-sequence/i);
  });

  it("CLAIM 6 — a non-member's heartbeat is refused, so presence cannot be forged", async () => {
    await expect(bob.heartbeat({ seq: 1, addrs: [] })).rejects.toThrow(/not-a-member/i);
  });

  it("CLAIM 7 — the mesh view lists members and their advertisements", async () => {
    const a = hub.site.invite({ roles: ["member"] });
    const b = hub.site.invite({ roles: ["member"] });
    await alice.redeem(a.id);
    await bob.redeem(b.id);

    await alice.heartbeat({
      seq: 1,
      addrs: ["/ip4/127.0.0.1/tcp/1"],
      advertisements: [{ id: "images", kind: "images", title: "Images" }],
    });
    await bob.heartbeat({ seq: 1, addrs: [] });

    const view = await bob.meshView();
    expect(view.members.map((m) => m.peerId).sort()).toEqual([ALICE, BOB].sort());
    const offer = view.advertisements.find((ad) => ad.peerId === ALICE);
    expect(offer?.kind).toBe("images");
  });

  it("CLAIM 8 — REVOCATION: a removed member is refused and appears in the deny list", async () => {
    const invitation = hub.site.invite({ roles: ["member"] });
    await alice.redeem(invitation.id);
    await alice.heartbeat({ seq: 1, addrs: [] });

    const removed = hub.site.remove(ALICE);
    expect(removed.policyVersion).toBeGreaterThan(0);

    // The member's next beat is refused — the whole point of revocation.
    await expect(alice.heartbeat({ seq: 2, addrs: [] })).rejects.toThrow(/not-a-member/i);

    // And every other peer can pull the deny list to refuse her offline.
    const deny = await bob.revocations();
    expect(deny.entries.map((e) => e.peerId)).toContain(ALICE);
  });

  it("CLAIM 9 — roles can be changed, and the change bumps the policy version", async () => {
    const invitation = hub.site.invite({ roles: ["member"] });
    await alice.redeem(invitation.id);
    // `admin` and `hidden` are the other roles this app's vocabulary defines
    // (`roleNames(appRules([]))` → admin, hidden, member); a role outside it
    // is refused by claim 10.
    const changed = hub.site.setRoles(ALICE, ["member", "admin"]);
    expect(changed.policyVersion).toBeGreaterThan(0);

    const beat = await alice.heartbeat({ seq: 1, addrs: [] });
    // The renewed token carries the new roles, which is how a role change
    // reaches a provider without the hub being on the request path.
    expect(beat.roles).toContain("admin");
  });

  it("CLAIM 10 — an unknown role is refused at invitation time, not at redemption", () => {
    expect(() => hub.site.invite({ roles: ["not-a-real-role"] })).toThrow();
  });
});
