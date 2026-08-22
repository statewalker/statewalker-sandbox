/**
 * `startBrowserHub`: the machinery the hub page (`../pages/hub/`) uses to
 * BE the mesh's hub from inside a tab -- the same stack `./peer-runtime.ts`
 * builds for an ordinary page, with the join removed and the hub's own
 * surface put in its place.
 *
 * A SIBLING OF `startBrowserPeer`, NOT A FLAG ON IT. That was a real
 * choice, so here is the accounting. Of `startBrowserPeer`'s six steps,
 * this one shares three verbatim (build the node, dial the relay, wait for
 * the reservation; mount the ServiceWorker edge) and differs on the other
 * three:
 *   1. it does not fetch `hubPeerId` from `httpeers.json` -- it IS that
 *      peerId, and reads the file only for `relayAddrs`;
 *   4. `createPeer` is called differently in four ways at once: `mounts` is
 *      a FACTORY (the hub's endpoints need the `mintToken` closure only
 *      that form is handed), `privateKey` is required (nothing else can
 *      sign as the mesh), `usesTransportIdentity` must be supplied (the
 *      bootstrap routes mint the very tokens they cannot require), and
 *      `revocationCache` is the LIVE `RevocationRegistry` rather than a
 *      pulled cache (the hub owns the source of truth and has nothing to
 *      pull from itself);
 *   5. there is no pre-dial, no invitation to redeem, no heartbeat and no
 *      keepalive -- a hub does not join itself, holds no presence record of
 *      its own, and appears in no mesh view.
 * Parameterising would have put five conditionals through a 170-line
 * function whose entire narrative is "how a page joins a mesh", and left
 * both readings harder. What is actually SHARED is shared, and by import,
 * not by copy: `./node-profile.ts`'s `createBrowserNode`,
 * `../reservation.ts`'s `dialRelay`/`waitForCircuitReservation`,
 * `./join.ts`'s `createRouteEnsurer`, `./edge.ts`'s `mountEdge`,
 * `./edge-dispatch.ts`'s `createEdgeDispatch`, and the hub's own
 * `../hub/endpoints.ts` and `../hub/hub-state.ts` unchanged. The
 * duplication left is the ~40 lines of orchestration that genuinely
 * differ, and the unwind stack, which is deliberately alike in all three
 * runtimes (here, `./peer-runtime.ts`, `../hub/main.ts`) because the
 * failure it prevents is the same one.
 *
 * THE HUB PAGE IS A BROWSER PEER LIKE ANY OTHER ON THE WIRE. It listens on
 * `/p2p-circuit` and `/webrtc` and is reached at
 * `<relay>/p2p-circuit/webrtc/p2p/<hubPeerId>` -- the exact address
 * `./join.ts`'s `preDialPeer` composes for the Node hub. Nothing on the
 * other pages' side of the mesh can tell which kind of hub it is talking
 * to, which is the property that makes this a second implementation rather
 * than a second protocol.
 *
 * SEARCH MOVES WITH THE HUB, and it does so for free: `createHubEndpoints`
 * mounts `/search` and posts `SEARCH_ADVERTISEMENT` into its own
 * advertisement store at construction (see that module). So a hub page
 * advertises and serves search exactly as the Node hub does, the topology
 * is unchanged, and the app page still discovers search by `kind` with no
 * idea anything moved.
 */
import type { Ed25519PrivateKey, Mounts, PeerIdStr } from "@statewalker/httpeers.core";
import {
  createMemberStore,
  createMonotonicClock,
  createPeer,
  RevocationRegistry,
  roleNames,
} from "@statewalker/httpeers.core";
import {
  createHubEndpoints,
  DEFAULT_PRESENCE_TTL_MS,
  usesTransportIdentity,
} from "../hub/endpoints.js";
import type { InvitationStore, SnapshotStore } from "../hub/hub-state.js";
import { createHubState } from "../hub/hub-state.js";
import type { MeshView } from "../hub/mesh-view.js";
import { HUB_RULES } from "../policy.js";
import { dialRelay, waitForCircuitReservation } from "../reservation.js";
import { mountEdge } from "./edge.js";
import { createEdgeDispatch } from "./edge-dispatch.js";
import { createRouteEnsurer } from "./join.js";
import { createBrowserNode, dialNeedsPermissiveGater } from "./node-profile.js";

/** How often the hub sweeps stale presence -- `../hub/main.ts`'s `SWEEP_INTERVAL_MS`, and for the same reason (1 s granularity keeps "leaves the view within one TTL" tight). */
export const SWEEP_INTERVAL_MS = 1_000;

/** The longest life of a token this hub mints -- sets the revocation registry's pruning horizon. Mirrors `../hub/main.ts`. */
export const MAX_TOKEN_TTL_MS = 5 * 60_000;

/**
 * How long the token the hub mints FOR ITSELF lives, and how often it is
 * renewed. See `selfToken` below for what that token is for; the renewal
 * interval is a third of the life so a slow renewal has two more chances
 * before anything expires.
 */
export const SELF_TOKEN_TTL_MS = MAX_TOKEN_TTL_MS;
export const SELF_TOKEN_RENEW_INTERVAL_MS = Math.floor(SELF_TOKEN_TTL_MS / 3);

/** Coarse lifecycle states the hub page renders progress against; ordered, each passed through once. */
export type BrowserHubState =
  | "loading-config"
  | "connecting-relay"
  | "awaiting-reservation"
  | "starting-hub"
  | "mounting-edge"
  | "ready"
  | "stopped";

export interface StartBrowserHubInit {
  /** The ServiceWorker adapter key -- also the mount prefix's required first segment; see `./edge.ts`'s `assertKeyMatchesPrefix`. */
  key: string;
  /** This hub's signing key. Its peerId IS the mesh -- see `./identity.ts`. Required: there is nothing sensible to default it to. */
  privateKey: Ed25519PrivateKey;
  /** Where members and spent invitation ids live -- `./snapshot-store.ts`'s IndexedDB one in the page, a fake in a test. */
  snapshotStore: SnapshotStore;
  /** The relay to reserve through. Defaults to `relayAddrs[0]` from `httpeersConfigUrl`. */
  relayAddr?: string;
  /** Defaults to `/httpeers.json` -- read ONLY for `relayAddrs`; this hub's peerId is its own. */
  httpeersConfigUrl?: string;
  presenceTtlMs?: number;
  advertisementAccess?: Record<string, string>;
  onState?: (state: BrowserHubState) => void;
  serviceWorkerUrl?: string;
  /** Relaxes the libp2p connection gater for insecure/loopback relay dials -- local dev only. See `./node-profile.ts`'s `CreateBrowserNodeInit.dev`. */
  dev: boolean;
}

export interface BrowserHubHandle {
  /** This hub's peerId -- and therefore the mesh's name, restated by every token's `mesh` claim. */
  peerId: PeerIdStr;
  /** The relay this hub reserved through; the same string a joining page must be told. */
  relayAddr: string;
  /** The `/p2p-circuit/webrtc` address the reservation produced. */
  circuitAddr: string;
  /** The same-origin URL prefix a plain `fetch()` on the hub page reaches the mesh through -- always ending in a slash. */
  baseUrl: string;
  /** Mint invitations. One per page, never one per mesh -- see `./join-blob.ts`. */
  invitations: InvitationStore;
  /**
   * Which invitation ids have already been redeemed. Read straight off the
   * snapshot, because that IS the set `redeem` consults -- its spent check
   * runs first and unconditionally (`../hub/hub-state.ts`). A UI asking
   * "is this code still usable?" must ask the same set, not a tally of its
   * own that a reload would disagree with.
   */
  spentInvitationIds: () => ReadonlySet<string>;
  /** Members and their liveness, as `GET /.well-known/mesh` would serve it -- `../hub/endpoints.ts`'s `HubEndpoints.meshView`. */
  meshView: () => MeshView;
  /** Remove a member and revoke its tokens -- see `removeMember` below for the call path and why it is not the edge. */
  removeMember: (peerId: PeerIdStr) => Promise<RemoveMemberResult>;
  /**
   * Every role this mesh defines, read off the rules themselves rather than
   * hard-coded, so a role added to `../policy.ts` appears in the UI without
   * anyone remembering to update a second list. Since ADR-0019 there is no
   * separate role registry: a role exists here exactly when some rule fires
   * on it.
   */
  roleNames: () => string[];
  /**
   * Change an existing member's roles.
   *
   * BOTH HALVES, or the change is a lie. `MemberStore.setRoles` rewrites the
   * record, but a peer is carrying a token that already states its OLD roles
   * and stays valid until it expires -- so a demoted admin would keep admin
   * for the life of that token. `RevocationRegistry.changeRoles` records the
   * change so tokens minted before it stop verifying, which is what makes the
   * new roles take effect on the peer's next heartbeat. The store does not do
   * this for us: `createPersistentHub`'s `setRoles` persists and nothing more.
   */
  setMemberRoles: (peerId: PeerIdStr, roles: string[]) => { policyVersion: number };
  stop(): Promise<void>;
}

/** What `DELETE /admin/members/{peerId}` answers -- `../hub/admin.ts`. */
export interface RemoveMemberResult {
  ok: boolean;
  removed: PeerIdStr;
  /**
   * The revocation registry's version AFTER the removal. It moved, and that
   * movement is the whole mechanism: `RevocationRegistry.revoke` bumps it
   * internally, every peer notices on its next heartbeat, and each then
   * pulls the new deny-list. That is why a removed peer's live, unexpired
   * token stops working rather than lingering until it expires.
   */
  policyVersion: number;
}

async function fetchRelayAddr(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `startBrowserHub: GET ${url} -> ${res.status} ${res.statusText} -- ` +
        'has the server been through "pnpm bootstrap" yet?',
    );
  }
  const config = (await res.json()) as { relayAddrs?: string[] };
  const relayAddr = config.relayAddrs?.[0];
  if (relayAddr == null) {
    throw new Error("startBrowserHub: httpeers.json's relayAddrs is empty -- nothing to dial.");
  }
  return relayAddr;
}

/**
 * Of the `/p2p-circuit` addresses a reservation produces, the one a browser
 * should actually dial -- the `/webrtc`-suffixed one. Same function, same
 * reason, as `../hub/main.ts`'s `preferWebRtcCircuitAddr`: a reservation
 * yields BOTH variants, and the bare one is a LIMITED connection on which
 * libp2p silently refuses `/httpeers/1.0.0`. Publishing the wrong one costs
 * whoever pastes it a genuinely confusing five minutes.
 */
function preferWebRtcCircuitAddr(addrs: string[], reserved: string): string {
  return addrs.find((a) => a.includes("p2p-circuit") && a.includes("/webrtc")) ?? reserved;
}

export async function startBrowserHub(init: StartBrowserHubInit): Promise<BrowserHubHandle> {
  const onState = init.onState ?? ((): void => {});
  const configUrl = init.httpeersConfigUrl ?? "/httpeers.json";

  onState("loading-config");
  const relayAddr = init.relayAddr ?? (await fetchRelayAddr(configUrl));

  onState("connecting-relay");
  // The SAME key the hub signs with -- see `./node-profile.ts`'s
  // `CreateBrowserNodeInit.privateKey`. A node built from one key while
  // `createPeer` minted with another would produce tokens whose `mesh`
  // claim named a peer nobody was talking to.
  // See `dialNeedsPermissiveGater`: what the gater objects to is the address
  // being dialled, not where this page was served from.
  const node = await createBrowserNode({
    dev: init.dev || dialNeedsPermissiveGater(relayAddr),
    privateKey: init.privateKey,
  });

  // EVERY RESOURCE THIS FUNCTION ACQUIRES IS UNWOUND IF A LATER STEP THROWS.
  // `node` is running and holding a relay connection and a reservation the
  // moment it exists; a `startBrowserHub` that threw afterwards would leave
  // it running, and a page that retries would accumulate one more on every
  // attempt with no handle to close. Same stack, same reason, as
  // `./peer-runtime.ts` and `../hub/main.ts`.
  const unwind: Array<() => Promise<void>> = [async () => await node.stop()];
  const startFailed = async (): Promise<void> => {
    // A COPY, so this is idempotent in order -- `reverse()` mutates in place.
    for (const step of [...unwind].reverse()) await step().catch(() => {});
  };

  let circuitAddr: string;
  try {
    await dialRelay(node, relayAddr);
    onState("awaiting-reservation");
    const reserved = await waitForCircuitReservation(node);
    circuitAddr = preferWebRtcCircuitAddr(
      node.getMultiaddrs().map((a) => a.toString()),
      reserved,
    );
  } catch (err) {
    await startFailed();
    throw new Error(
      `startBrowserHub: could not reserve a circuit slot through the relay at "${relayAddr}" -- ` +
        "no page can reach this hub without one. Is the relay running, and is httpeers.json's " +
        `relayAddrs[0] the address it is actually listening on? Cause: ${String(err)}`,
      { cause: err },
    );
  }

  onState("starting-hub");
  // ONE shared clock for this hub's minting AND its revocation registry --
  // two independent `Date.now` defaults can tie (mint a token, then revoke
  // that same peer, both well within a millisecond); one monotonic instance
  // cannot. `../hub/main.ts` makes the same call for the same reason.
  const clock = createMonotonicClock();
  const revocations = new RevocationRegistry({ maxTokenTtlMs: MAX_TOKEN_TTL_MS, now: clock });
  const state = createHubState({
    store: init.snapshotStore,
    rules: HUB_RULES,
    createMemberStore,
  });

  let sweep: (() => void) | undefined;
  let meshView: (() => MeshView) | undefined;
  let hubMounts: Mounts | undefined;
  let mintToken: ((sub: string, roles: string[], ttlMs?: number) => Promise<string>) | undefined;

  let peer: Awaited<ReturnType<typeof createPeer>>;
  try {
    peer = await createPeer({
      node,
      // NOT redundant with `node`'s own key. `CreatePeerInit.privateKey`
      // says it is "ignored when `node` is supplied", and that sentence is
      // about node CONSTRUCTION only: the `mintToken` closure handed to the
      // `mounts` factory still closes over whatever `privateKey` this call
      // was given, and throws lazily when there was none -- so omitting it
      // leaves a hub that cannot mint a single token, and only says so at
      // the first redemption. (Already reported as a doc defect in
      // `httpeers.core`; see `../hub/main.ts`, which carries the same note.)
      privateKey: init.privateKey,
      rules: HUB_RULES,
      usesTransportIdentity: usesTransportIdentity(),
      now: clock,
      // The live registry, not a pulled cache: this peer OWNS the source of
      // truth and has nothing to pull from itself. Passing it here is what
      // makes a revoked token stop working on the very next request to ANY
      // hub mount rather than only the one route someone remembered.
      revocationCache: revocations,
      mounts: (ctx) => {
        const hub = createHubEndpoints({
          selfPeerId: ctx.peerId,
          mintToken: ctx.mintToken,
          memberStore: state.memberStore,
          invitations: state.invitations,
          rules: HUB_RULES,
          revocations,
          presenceTtlMs: init.presenceTtlMs ?? DEFAULT_PRESENCE_TTL_MS,
          advertisementAccess: init.advertisementAccess,
        });
        sweep = hub.sweep;
        meshView = hub.meshView;
        mintToken = ctx.mintToken;
        hubMounts = hub.mounts;
        return hub.mounts;
      },
    });
  } catch (err) {
    await startFailed();
    throw err;
  }
  unwind.push(async () => await peer.stop());

  const sweepTimer = setInterval(() => sweep?.(), SWEEP_INTERVAL_MS);
  unwind.push(async () => clearInterval(sweepTimer));

  // THE HUB MINTS ITSELF A TOKEN, and it is the only peer entitled to.
  // `./edge-dispatch.ts` attaches a bearer token to every call the PAGE
  // makes through its own edge -- that is what lets a page be an ordinary
  // `fetch()` client with no credential of its own. An ordinary page gets
  // that token by joining; this page cannot join itself, so it signs one,
  // which is exactly what being the issuer means. It is an ordinary token
  // in every respect: `admin` roles out of `../policy.ts`'s rules,
  // `mesh` = this hub, checked by the same policies and the same
  // revocation registry as anybody else's. It expires like anybody else's
  // too, hence the renewal timer -- `token()` is synchronous by contract,
  // so it can only ever return the last one minted.
  if (mintToken == null) {
    await startFailed();
    throw new Error("startBrowserHub: createPeer never called the mounts factory -- no mintToken.");
  }
  const mint = mintToken;
  let selfToken = await mint(peer.peerId, ["admin"], SELF_TOKEN_TTL_MS);
  const renewTimer = setInterval(() => {
    void mint(peer.peerId, ["admin"], SELF_TOKEN_TTL_MS).then(
      (token) => {
        selfToken = token;
      },
      (err: unknown) => {
        // Logged, not thrown: the previous token is still valid for another
        // two renewal intervals, so one failed mint is not yet a failure the
        // page can act on.
        console.warn("hub: could not renew the hub's own token:", err);
      },
    );
  }, SELF_TOKEN_RENEW_INTERVAL_MS);
  unwind.push(async () => clearInterval(renewTimer));

  onState("mounting-edge");
  let edge: Awaited<ReturnType<typeof mountEdge>>;
  try {
    edge = await mountEdge({
      key: init.key,
      serviceWorkerUrl: init.serviceWorkerUrl,
      dispatch: createEdgeDispatch({
        dispatch: peer.dispatch,
        key: init.key,
        token: () => selfToken,
        // `meshView: () => null` on purpose: the hub is not a member of its
        // own mesh and never appears in the view, so it has no per-peer
        // `addrs` to prefer. `createRouteEnsurer` then falls back to
        // composing `<relay>/p2p-circuit/webrtc/p2p/<peer>`, which is right
        // for every peer that reserved on the relay this deployment names --
        // all of them, in this deployment.
        ensureRoute: createRouteEnsurer({
          node,
          relayAddr,
          selfPeerId: peer.peerId,
          meshView: () => null,
        }),
      }),
    });
  } catch (err) {
    // By this point the hub is up and reachable; unwinding is the difference
    // between a failed page and a live hub nothing on the page can stop.
    await startFailed();
    throw err;
  }

  onState("ready");

  /**
   * `DELETE /admin/members/{peerId}`, against THIS hub's own mounted
   * handler -- `../hub/admin.ts`, reached through `Mounts.match`.
   *
   * NOT THROUGH THE SERVICEWORKER EDGE, AND NOT THROUGH `peer.dispatch`.
   * The hub page calling its own endpoints is a SELF-call, and this
   * codebase does not support one along either of those paths:
   * `edge-dispatch.ts` passes a locally-originated request (no binding)
   * straight to `peer.dispatch`, and `httpeers.core`'s `newPeerHandlers`
   * -- which every dispatched request goes through -- throws
   * `PeerBindingLostError` the moment `getPeerId` returns `undefined`,
   * which is exactly what a request that arrived from nowhere does. The
   * binding middleware exists to answer "which REMOTE peer is this, and
   * does it match the token"; a request from the hub's own page has no
   * remote peer for it to prove, so it is not a question that has an
   * answer. Going through the mount table is not a workaround for that --
   * it is the layer that was actually being asked for.
   *
   * WHAT THIS BYPASSES, SAID PLAINLY: the policy gate on `/admin/`
   * (`std:mesh.admin`). That gate authorises REMOTE callers, and this
   * caller is the hub itself -- the process holding the signing key that
   * would have minted any token it could present, and holding the
   * `MemberStore` the handler mutates. There is no privilege here to
   * escalate to. Nothing about this widens the network surface: no route
   * is added, and a remote `DELETE /admin/members/...` is gated exactly as
   * it always was.
   */
  const removeMember = async (peerId: PeerIdStr): Promise<RemoveMemberResult> => {
    const path = `/admin/members/${encodeURIComponent(peerId)}`;
    const handler = hubMounts?.match(path);
    if (handler == null) {
      throw new Error(
        `startBrowserHub: nothing is mounted at "${path}" -- cannot remove a member.`,
      );
    }
    // The origin is a placeholder: this request never reaches a network, and
    // the handler routes on the pathname alone.
    const res = await handler(new Request(`http://hub.invalid${path}`, { method: "DELETE" }));
    if (!res.ok) {
      throw new Error(
        `startBrowserHub: DELETE ${path} -> ${res.status} ${res.statusText} (${await res.text()})`,
      );
    }
    return (await res.json()) as RemoveMemberResult;
  };

  const setMemberRoles = (peerId: PeerIdStr, roles: string[]): { policyVersion: number } => {
    // Throws (via `assertValid`) if no rule knows the role -- caught here, at
    // the call, rather than as a silent denial three hops later.
    state.memberStore.setRoles(peerId, roles);
    revocations.changeRoles(peerId, roles);
    return { policyVersion: revocations.policyVersion() };
  };

  return {
    peerId: peer.peerId,
    relayAddr,
    circuitAddr,
    baseUrl: edge.baseUrl,
    invitations: state.invitations,
    spentInvitationIds: () => new Set(init.snapshotStore.read().spentInvitationIds),
    meshView: () =>
      meshView?.() ?? { version: 0, self: peer.peerId, members: [], advertisements: [] },
    removeMember,
    roleNames: () => roleNames(HUB_RULES),
    setMemberRoles,
    async stop() {
      clearInterval(sweepTimer);
      clearInterval(renewTimer);
      try {
        await edge.stop();
        await peer.stop();
      } finally {
        // `peer.stop()` does NOT stop `node` -- it was supplied, and
        // `httpeers.core` never stops a node it did not build. In `finally`
        // so a failure in any earlier teardown step still leaves the relay
        // connection closed rather than leaking every connection it holds.
        await node.stop();
        onState("stopped");
      }
    },
  };
}
