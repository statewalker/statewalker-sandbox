/**
 * A-2 end to end: revocation as a pulled, cached deny list, over real
 * libp2p. Note 34.
 *
 * PROMOTED (Task 7b) -- E1 through E6 only -- from the `describe('A-2 end
 * to end', ...)` block of
 * `notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/35-httpeers-prototype-v0.8.0-revocation/revocation.test.ts`.
 * That file's ten `describe('A-2 unit: ...')` tests (the registry and the
 * cache, no network) were already promoted by Task 5 into
 * `packages/httpeers.core/tests/revocation.test.ts` -- NOT duplicated here.
 *
 * No assertion was altered -- see
 * `.superpowers/sdd/2026-08-18-httpeers-stack/task-7b-report.md` for the
 * full adaptation record and the measured E4 latency.
 *
 * The acceptance criterion is a MEASURED number, not a preference. The
 * archive measured 59 ms on localhost -- the mechanism's floor, not a
 * production figure; in deployment the bound is one heartbeat interval
 * (~5 s), plus a list fetch that happens only when the policy counter moved.
 *
 * Adapted at the call sites only (see `tests/support/mesh.ts` for
 * `buildTestHub`/`buildTestPeer`, and `integration.test.ts`'s header for the
 * token-minting and invite-body adaptations, which apply here too):
 *  - `hub.store.removeMember(id)` / `hub.store.setRoles(id, roles)` ->
 *    `hub.memberStore.remove(id)` + `hub.revocations.revoke(id)` /
 *    `hub.memberStore.setRoles(id, roles)` +
 *    `hub.revocations.changeRoles(id, roles)`. The archive's `MeshStore`
 *    was one object that did both jobs per call; Task 1 split membership
 *    and revocation into separate registries (`MemberStore`,
 *    `RevocationRegistry`), so the test now makes both calls the archive's
 *    one call used to make.
 *  - `alice`/`provider`/`bob`/`carol`/`dan.heartbeat(hubPeerId, token)` and
 *    `provider.revocations.knownVersion()` -> `buildTestPeer`'s
 *    conveniences, wrapping this package's `Peer.call` and a
 *    `RevocationCache` the archive's monolithic `peer.ts` had built in.
 *  - `provider` mounts `createTestSurfaceHandler` (`src/hub/endpoints.ts`)
 *    at `/test` -- it is not the hub, but the archive's `createEndpoints`
 *    mounted the SAME `/test/whoami`+`/test/echo` shape on every peer,
 *    unconditionally, hub or not; this reconstruction reuses the one
 *    exported handler rather than duplicating it.
 */
import { multiaddr } from "@multiformats/multiaddr";
import { createMounts, verifyToken } from "@statewalker/httpeers.core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestSurfaceHandler } from "../src/hub/endpoints.js";
import { buildTestHub, buildTestPeer, type TestHub, type TestPeer } from "./support/mesh.js";

let hub: TestHub, alice: TestPeer, provider: TestPeer;
let aliceToken: string, providerToken: string;

beforeAll(async () => {
  hub = await buildTestHub();
  alice = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
  provider = await buildTestPeer({
    hubPeerId: hub.peer.peerId,
    listen: ["/ip4/127.0.0.1/tcp/0"],
    mounts: (ctx) => {
      const mounts = createMounts();
      mounts.provide("/test", createTestSurfaceHandler(ctx.peerId));
      return mounts;
    },
  });

  for (const p of [alice, provider]) await p.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
  await alice.libp2p.dial(multiaddr(provider.addrs()[0]!));

  for (const [peer, code] of [
    [alice, "A"],
    [provider, "P"],
  ] as const) {
    hub.invitations.create(code, ["member"], 60_000);
    const res = await peer.call(hub.peer.peerId, "/.well-known/invite", {
      method: "POST",
      body: JSON.stringify({ id: code }),
    });
    const body = (await res.json()) as any;
    if (peer === alice) aliceToken = body.token;
    else providerToken = body.token;
  }
}, 40_000);

afterAll(async () => {
  await Promise.all([hub?.stop(), alice?.stop(), provider?.stop()]);
});

describe("A-2 end to end", () => {
  it(
    "E1: the heartbeat carries a version vector",
    async () => {
      const res = await alice.call(hub.peer.peerId, "/.well-known/presence", {
        method: "POST",
        body: JSON.stringify({ seq: 1, addrs: alice.addrs() }),
      });
      const body = (await res.json()) as any;
      expect(body.versions).toMatchObject({ mesh: expect.any(Number), policy: expect.any(Number) });
    },
    20_000,
  );

  it("E2: tokens carry iat, and it comes from the hub", async () => {
    const claims = await verifyToken(aliceToken, { issuer: hub.peer.peerId });
    expect(claims?.iat).toBeGreaterThan(0);
    expect(claims!.iat).toBeLessThanOrEqual(claims!.exp);
  });

  it(
    "E3: a provider pulls the list only when the policy version moves",
    async () => {
      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken);
      const v0 = provider.revocations.knownVersion();
      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken);
      expect(provider.revocations.knownVersion()).toBe(v0); // unchanged: no refetch needed

      hub.memberStore.remove(alice.peerId);
      hub.revocations.revoke(alice.peerId);
      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken);
      expect(provider.revocations.knownVersion()).toBeGreaterThan(v0);
    },
    30_000,
  );

  it(
    "E4: THE MEASUREMENT -- revoked token refused, and how long it took",
    async () => {
      // Fresh member, valid token, provider accepting it.
      hub.invitations.create("BOB", ["member"], 60_000);
      const bob = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
      await bob.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
      await bob.libp2p.dial(multiaddr(provider.addrs()[0]!));
      const bobToken = (
        (await (
          await bob.call(hub.peer.peerId, "/.well-known/invite", {
            method: "POST",
            body: JSON.stringify({ id: "BOB" }),
          })
        ).json()) as any
      ).token;

      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken);
      expect((await bob.call(provider.peerId, "/test/whoami", { token: bobToken })).status).toBe(200);

      // Revoke, then measure to the first refusal.
      const t0 = Date.now();
      hub.memberStore.remove(bob.peerId);
      hub.revocations.revoke(bob.peerId);
      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken); // one heartbeat
      const res = await bob.call(provider.peerId, "/test/whoami", { token: bobToken });
      const elapsed = Date.now() - t0;

      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error).toMatch(/revoked/);
      console.log(`\n  TIMING: revocation took effect in ${elapsed} ms (one heartbeat)\n`);
      expect(elapsed).toBeLessThan(2000);
      await bob.stop();
    },
    40_000,
  );

  it(
    "E5: a role downgrade invalidates the old token but does not lock the peer out",
    async () => {
      hub.invitations.create("CAR", ["member", "admin"], 60_000);
      const carol = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
      await carol.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
      await carol.libp2p.dial(multiaddr(provider.addrs()[0]!));
      let carolToken = (
        (await (
          await carol.call(hub.peer.peerId, "/.well-known/invite", {
            method: "POST",
            body: JSON.stringify({ id: "CAR" }),
          })
        ).json()) as any
      ).token;

      hub.memberStore.setRoles(carol.peerId, ["member"]);
      hub.revocations.changeRoles(carol.peerId, ["member"]);
      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken);

      // The stale token is refused...
      const stale = await carol.call(provider.peerId, "/test/whoami", { token: carolToken });
      expect(stale.status).toBe(403);
      expect(((await stale.json()) as any).error).toMatch(/roles changed/);

      // ...but one heartbeat restores service, with the reduced roles.
      carolToken = await carol.heartbeat(hub.peer.peerId, carolToken);
      const fresh = await carol.call(provider.peerId, "/test/whoami", { token: carolToken });
      expect(fresh.status).toBe(200);
      expect(((await fresh.json()) as any).roles).toEqual(["member"]);
      await carol.stop();
    },
    40_000,
  );

  it(
    "E6: the hub is never on the critical path -- a provider enforces offline",
    async () => {
      hub.invitations.create("DAN", ["member"], 60_000);
      const dan = await buildTestPeer({ hubPeerId: hub.peer.peerId, listen: ["/ip4/127.0.0.1/tcp/0"] });
      await dan.libp2p.dial(multiaddr(hub.peer.addrs()[0]!));
      await dan.libp2p.dial(multiaddr(provider.addrs()[0]!));
      const danToken = (
        (await (
          await dan.call(hub.peer.peerId, "/.well-known/invite", {
            method: "POST",
            body: JSON.stringify({ id: "DAN" }),
          })
        ).json()) as any
      ).token;

      hub.memberStore.remove(dan.peerId);
      hub.revocations.revoke(dan.peerId);
      providerToken = await provider.heartbeat(hub.peer.peerId, providerToken); // last contact with the hub

      const res = await dan.call(provider.peerId, "/test/whoami", { token: danToken });
      expect(res.status).toBe(403);
      await dan.stop();
    },
    40_000,
  );
});
