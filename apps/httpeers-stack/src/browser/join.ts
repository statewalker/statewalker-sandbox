/**
 * Joining the mesh: the `/webrtc` pre-dial, invitation redemption, and the
 * two timers this runtime owns itself (the third -- circuit-relay's own
 * reservation refresh -- is libp2p-managed; there is no code for it here,
 * on purpose, see `startJoin`'s doc comment).
 */

import type { PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import type {
  ChangeEntry,
  Libp2p,
  Peer,
  PeerIdStr,
  RevocationCache,
  Vocabulary,
} from "@statewalker/httpeers.core";
import type { MeshView } from "../hub/mesh-view.js";

/**
 * Dial `${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}` explicitly, BEFORE
 * opening any protocol against `peerId` (design note's Step 2; applies to
 * the hub exactly as it does to any other peer -- spec §7, the hub
 * declares no listen address of its own).
 *
 * WHY THIS IS NOT OPTIONAL. libp2p's auto-dial may already hold a
 * relay-only LIMITED connection to `peerId` -- reachable, but not upgraded
 * to WebRTC -- from nothing more than address exchange via `identify`.
 * libp2p SILENTLY refuses to open a custom protocol (`/httpeers/1.0.0`)
 * over a limited connection: the dial simply never completes, with no
 * error naming a limited connection as the cause. Explicitly dialling the
 * full `/webrtc/p2p/...` address forces the WebRTC upgrade before any
 * `peer.call` is attempted, so that failure mode never has a chance to
 * occur.
 */
export async function preDialPeer(
  node: Libp2p,
  relayAddr: string,
  peerId: PeerIdStr,
): Promise<void> {
  const target = multiaddr(`${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}`);
  await node.dial(target);
}

interface InviteRedeemResponse {
  token: string;
  mesh: string;
  roles: string[];
}

/** Redeem `invitationId` against the hub -- `POST /.well-known/invite`, `../hub/endpoints.ts`'s bootstrap handler. No token exists yet: this call is proven by the transport handshake alone. */
export async function redeemInvitation(
  peer: Peer,
  hubPeerId: PeerIdStr,
  invitationId: string,
): Promise<InviteRedeemResponse> {
  const res = await peer.call(hubPeerId, "/.well-known/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: invitationId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `join: invitation redemption failed (${res.status} ${res.statusText}): ${body}`,
    );
  }
  return (await res.json()) as InviteRedeemResponse;
}

/** This peer's own advertisement, as carried on the heartbeat body -- `../hub/endpoints.ts`'s `PresenceBody.advertisements`. */
export interface AdvertisementInput {
  id: string;
  kind: string;
  title: string;
}

interface HeartbeatVersions {
  mesh: number;
  policy: number;
  vocabulary: number;
}

interface PresenceHeartbeatResponse {
  token: string;
  versions: HeartbeatVersions;
  ttl: number;
}

interface RevocationsResponse {
  version: number;
  entries: ChangeEntry[];
}

/** How often the presence heartbeat fires -- design note's Step 3, 5 s. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How often the connection-keepalive timer checks the link to the hub.
 * DELIBERATELY SEPARATE from `HEARTBEAT_INTERVAL_MS`: a heartbeat that
 * fails to send says "the request failed," which could be the connection,
 * the hub, or a revoked membership -- it does not by itself diagnose
 * "the underlying libp2p connection to the hub is gone." This timer
 * checks that fact directly (`node.getConnections(hubPeerId)`) and
 * re-runs the `/webrtc` pre-dial when it finds nothing open, independent
 * of whether a heartbeat happens to be in flight at the same moment.
 * Matches the interval the validated p2p-demo prototype uses for the same
 * purpose (`workspaces/webrun-wire/apps/p2p-demo/server-page/main.ts`,
 * "relay link lost; re-dialing").
 */
export const KEEPALIVE_INTERVAL_MS = 10_000;

/**
 * How long a pulled revocation snapshot may go unconfirmed before this
 * peer refuses every token rather than trust one it can no longer vouch
 * for (`RevocationCache`'s own `maxStalenessMs` -- "there is a case that
 * no default is correct and this should be required," `revocation.ts`).
 * Generous relative to `HEARTBEAT_INTERVAL_MS` deliberately: the cache's
 * freshness clock is reset on EVERY successful heartbeat (see
 * `startJoin` below), not only when `versions.policy` actually moves, so
 * this bound is really "how many consecutive heartbeats may fail before
 * this peer stops trusting its own revocation snapshot," not "how often
 * the policy must change." Twelve missed 5 s heartbeats' worth of
 * tolerance before a live peer starts refusing tokens on staleness alone.
 */
export const REVOCATION_MAX_STALENESS_MS = 60_000;

export interface JoinInit {
  peer: Peer;
  node: Libp2p;
  hubPeerId: PeerIdStr;
  relayAddr: string;
  /** The token `redeemInvitation` minted -- `startJoin` owns rotating it from here on; the heartbeat response mints a fresh one every call. */
  initialToken: string;
  revocationCache: RevocationCache;
  /** This peer's own advertisements, read fresh on every heartbeat. Defaults to none. */
  advertisements?: () => AdvertisementInput[];
  heartbeatIntervalMs?: number;
  keepaliveIntervalMs?: number;
  /** Fired after each successful heartbeat, whether or not any version moved -- for a caller that wants to observe liveness, not just react to a version bump. */
  onHeartbeat?: (versions: HeartbeatVersions) => void;
}

export interface JoinHandle {
  /** The mesh view as of the last time `versions.mesh` moved -- `null` until the first heartbeat lands. Never fetched more often than that: re-fetching every heartbeat regardless of whether anything changed is exactly the design the version vector replaces. */
  meshView(): MeshView | null;
  /** The vocabulary as of the last time `versions.vocabulary` moved -- `null` until the first heartbeat lands. */
  vocabulary(): Vocabulary | null;
  stop(): void;
}

/**
 * Start the presence heartbeat and the connection-keepalive timer over an
 * already-joined peer (post `redeemInvitation`). Fires an immediate
 * heartbeat rather than waiting for the first interval tick, so a caller
 * observing `meshView()` sees a populated view as soon as the network
 * allows rather than up to `heartbeatIntervalMs` later.
 *
 * THREE TIMERS, KEPT APART (design note's Step 3 / note 07 §6). This
 * function owns two of them -- the heartbeat and the keepalive, below.
 * THE THIRD, circuit-relay's own reservation refresh, is NOT started
 * here: it is entirely libp2p-managed (the `circuitRelayTransport`
 * service renews the reservation on its own schedule once granted), and
 * folding it into either of these two would conflate "is my reservation
 * still valid" with "does the hub still consider me a member" or "is my
 * connection to the hub still open" -- three questions this design keeps
 * separate because they fail independently and mean different things.
 */
export function startJoin(init: JoinInit): JoinHandle {
  const { peer, node, hubPeerId, relayAddr, revocationCache } = init;
  const heartbeatIntervalMs = init.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const keepaliveIntervalMs = init.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;

  let token = init.initialToken;
  let seq = 0;
  let heartbeatInFlight = false;

  let meshViewCache: MeshView | null = null;
  let meshVersion = 0;
  let vocabularyCache: Vocabulary | null = null;
  let vocabularyVersion = 0;
  let revocationEntriesCache: ChangeEntry[] = [];

  async function heartbeatOnce(): Promise<void> {
    if (heartbeatInFlight) return; // never overlap two in-flight heartbeats -- see the module comment on why this is safe to just skip a tick rather than queue.
    heartbeatInFlight = true;
    try {
      seq += 1;
      // THE PEER'S OWN CURRENT MULTIADDRS -- `node.getMultiaddrs()`, read
      // fresh on every heartbeat. This is what makes THIS peer's own
      // addresses the freshest possible source for OTHER peers reading
      // them back out of the mesh view -- see `JoinHandle.meshView`'s doc
      // comment and `peer-runtime.ts`'s module comment for the other half
      // of this contract (never read a PEER's addrs from libp2p's own
      // `peerStore`).
      const addrs = node.getMultiaddrs().map((addr) => addr.toString());
      const advertisements = init.advertisements?.() ?? [];

      let res: Response;
      try {
        res = await peer.call(hubPeerId, "/.well-known/presence", {
          method: "POST",
          token,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ seq, addrs, advertisements }),
        });
      } catch {
        // Dial/transport failure -- leave every cached value as-is; the
        // next tick retries. `KEEPALIVE_INTERVAL_MS`'s timer is what
        // actually diagnoses and repairs a dropped connection to the hub;
        // this heartbeat has no business doing that job too.
        return;
      }
      if (!res.ok) return; // e.g. a revoked membership (403) or a hub-side rejection -- surfaced by the response simply not advancing any cache.

      const body = (await res.json()) as PresenceHeartbeatResponse;
      token = body.token; // rotates every heartbeat -- the hub mints a fresh token on each call.

      if (body.versions.mesh !== meshVersion) {
        const meshRes = await peer.call(hubPeerId, "/.well-known/mesh", { method: "GET", token });
        if (meshRes.ok) {
          meshViewCache = (await meshRes.json()) as MeshView;
          meshVersion = body.versions.mesh;
        }
      }

      if (body.versions.vocabulary !== vocabularyVersion) {
        const vocabRes = await peer.call(hubPeerId, "/.well-known/vocabulary", {
          method: "GET",
          token,
        });
        if (vocabRes.ok) {
          vocabularyCache = (await vocabRes.json()) as Vocabulary;
          vocabularyVersion = body.versions.vocabulary;
        }
      }

      if (body.versions.policy !== revocationCache.knownVersion()) {
        const revRes = await peer.call(hubPeerId, "/.well-known/revocations", {
          method: "GET",
          token,
        });
        if (revRes.ok) {
          const revBody = (await revRes.json()) as RevocationsResponse;
          revocationEntriesCache = revBody.entries;
        }
      }
      // Refresh the cache's freshness stamp on EVERY successful heartbeat
      // -- see `REVOCATION_MAX_STALENESS_MS`'s doc comment for why this is
      // NOT gated on the policy version having actually moved.
      revocationCache.update(body.versions.policy, revocationEntriesCache);

      init.onHeartbeat?.(body.versions);
    } finally {
      heartbeatInFlight = false;
    }
  }

  const heartbeatTimer = setInterval(() => void heartbeatOnce(), heartbeatIntervalMs);
  void heartbeatOnce();

  let hubPeerIdObj: PeerId | undefined;
  try {
    hubPeerIdObj = peerIdFromString(hubPeerId);
  } catch {
    hubPeerIdObj = undefined; // malformed hubPeerId -- the keepalive timer below simply never finds a match and keeps re-predialling, which is the correct degraded behaviour.
  }

  const keepaliveTimer = setInterval(() => {
    const stillOpen =
      hubPeerIdObj != null && node.getConnections(hubPeerIdObj).some((c) => c.status === "open");
    if (stillOpen) return;
    void preDialPeer(node, relayAddr, hubPeerId).catch(() => {
      // Best-effort -- the next tick retries, and a heartbeat that keeps
      // failing on its own schedule surfaces the same underlying
      // unreachability independently.
    });
  }, keepaliveIntervalMs);

  return {
    meshView: () => meshViewCache,
    vocabulary: () => vocabularyCache,
    stop() {
      clearInterval(heartbeatTimer);
      clearInterval(keepaliveTimer);
    },
  };
}
