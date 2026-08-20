/**
 * Test-only scaffolding shared by the three promoted E2E suites
 * (`chain.test.ts`, `integration.test.ts`, `revocation-e2e.test.ts`) —
 * Task 7b. Real libp2p nodes, real dials; not the in-process `app.fetch`
 * style `hub.test.ts` (Task 7a) uses.
 *
 * `buildTestHub` assembles the same production wiring `src/hub/main.ts`
 * does (mounts factory, `DEFAULT_ACCESS_TREE`, the TTL sweep is NOT started
 * here — these suites call `hub.peer` methods over real time, well under
 * one presence TTL, so nothing needs sweeping) but returns the pieces
 * (`memberStore`, `invitations`, `revocations`) directly rather than through
 * the archived tests' single combined `hub.store` — Task 1 split what the
 * archive kept as one `MeshStore` into three separate registries, so a
 * promoted test that calls `hub.store.removeMember(id)` now calls BOTH
 * `hub.memberStore.remove(id)` (drops membership) AND
 * `hub.revocations.revoke(id)` (records the change so a provider's pulled
 * cache can see it) — the archive's one call did both jobs at once because
 * its `MeshStore` was one object; splitting it did not remove either job.
 *
 * `buildTestPeer` wraps `createPeer` with two conveniences the archived
 * prototype's own monolithic `peer.ts` had built in, which the split
 * `httpeers.core`/`httpeers-stack` architecture does not (by design — see
 * `revocation.ts`'s own header comment: wiring `RevocationCache.check` to
 * the binding is "a wrap-at-the-call-site concern for whichever task
 * assembles the peer", not this package's job):
 *   - `.heartbeat(hubPeerId, token)`: one presence POST, with a
 *     per-peer-instance monotonic `seq`; pulls `/.well-known/revocations`
 *     and updates the attached cache only when the returned policy version
 *     actually moved (E3's "fetch only when the counter moved").
 *   - `.revocations`: the `RevocationCache` wired into this peer's own
 *     `revocationCache` binding option, exposed so a test can read
 *     `knownVersion()` directly.
 * Every peer gets one, even peers that never call `.heartbeat` — an unused
 * cache with no entries never denies anything, so this costs nothing and
 * keeps one construction path for every non-hub peer across all three
 * suites.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreatePeerInit,
  MemberStore,
  Peer,
  PeerIdStr,
} from "@statewalker/httpeers.core";
import {
  createMemberStore,
  createMonotonicClock,
  createPeer,
  DEFAULT_ACCESS_TREE,
  DEFAULT_VOCABULARY,
  RevocationCache,
  RevocationRegistry,
} from "@statewalker/httpeers.core";
import { createHubEndpoints, usesTransportIdentity } from "../../src/hub/endpoints.js";
import { createPersistentHub, type InvitationStore } from "../../src/hub/persist.js";

/** The longest life of a token these test hubs mint. Matches `src/hub/main.ts`. */
const MAX_TOKEN_TTL_MS = 5 * 60_000;

export interface TestHub {
  peer: Peer;
  memberStore: MemberStore;
  invitations: InvitationStore;
  revocations: RevocationRegistry;
  stop: () => Promise<void>;
}

/** A real, listening hub peer over loopback TCP, state in a scratch temp dir. */
export async function buildTestHub(): Promise<TestHub> {
  const dir = mkdtempSync(join(tmpdir(), "httpeers-e2e-hub-"));
  const vocabulary = DEFAULT_VOCABULARY;
  // ONE shared clock for this hub's minting AND its revocation registry —
  // see `revocation.ts`'s "ONE HUB-ISSUED CLOCK, NOT TWO". Two independent
  // `Date.now` defaults can tie (mint a token, then revoke that same peer,
  // both well within a millisecond); a `RevocationRegistry` and a
  // `mintToken` call drawing from the SAME monotonic instance cannot.
  const clock = createMonotonicClock();
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS, now: clock });

  const persistent = createPersistentHub({
    filePath: join(dir, "hub-state.json"),
    vocabulary,
    createMemberStore,
  });

  const peer = await createPeer({
    listen: ["/ip4/127.0.0.1/tcp/0"],
    accessTree: DEFAULT_ACCESS_TREE,
    vocabulary,
    usesTransportIdentity: usesTransportIdentity(),
    now: clock,
    mounts: (ctx) =>
      createHubEndpoints({
        selfPeerId: ctx.peerId,
        mintToken: ctx.mintToken,
        memberStore: persistent.memberStore,
        invitations: persistent.invitations,
        vocabulary,
        revocations,
      }).mounts,
  });

  return {
    peer,
    memberStore: persistent.memberStore,
    invitations: persistent.invitations,
    revocations,
    async stop() {
      await peer.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** One advertisement as it travels on a heartbeat body — `src/hub/endpoints.ts`'s `PresenceBody.advertisements`. */
export interface TestAdvertisement {
  id: string;
  kind: string;
  title: string;
}

export interface TestPeer extends Peer {
  /**
   * One presence heartbeat; refreshes `.revocations` only when the policy
   * version moved. Returns the fresh token.
   *
   * `advertisements` is OPTIONAL AND OMITTED-NOT-EMPTY when absent, which is
   * load-bearing rather than tidiness: `hub/endpoints.ts`'s presence handler
   * branches on `body.advertisements !== undefined`, so passing `[]` would
   * withdraw whatever that peer had posted, while omitting the field leaves
   * it untouched. Every caller predating `tests/e2e/harness.ts` (the three
   * Task 7b suites) passes nothing and is therefore unaffected.
   */
  heartbeat: (
    hubPeerId: PeerIdStr,
    token: string,
    advertisements?: TestAdvertisement[],
  ) => Promise<string>;
  revocations: RevocationCache;
}

interface PresenceResponse {
  token: string;
  versions: { mesh: number; policy: number; vocabulary: number };
}

interface RevocationsResponse {
  version: number;
  entries: Array<{ peerId: string; changedAt: number; roles: string[] }>;
}

/** An ordinary member peer (or, with `mounts`, a "provider" — see `createTestSurfaceHandler`). */
export async function buildTestPeer(init: CreatePeerInit = {}): Promise<TestPeer> {
  const revocationCache = new RevocationCache();
  const peer = await createPeer({ ...init, revocationCache });

  let seq = 0;
  const heartbeat = async (
    hubPeerId: PeerIdStr,
    token: string,
    advertisements?: TestAdvertisement[],
  ): Promise<string> => {
    seq += 1;
    const res = await peer.call(hubPeerId, "/.well-known/presence", {
      method: "POST",
      token,
      body: JSON.stringify({
        seq,
        addrs: peer.addrs(),
        ...(advertisements !== undefined ? { advertisements } : {}),
      }),
    });
    const body = (await res.json()) as PresenceResponse;

    if (body.versions.policy !== revocationCache.knownVersion()) {
      const revRes = await peer.call(hubPeerId, "/.well-known/revocations", { token: body.token });
      const revBody = (await revRes.json()) as RevocationsResponse;
      revocationCache.update(revBody.version, revBody.entries);
    }

    return body.token;
  };

  return Object.assign(peer, { heartbeat, revocations: revocationCache });
}
