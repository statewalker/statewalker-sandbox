/**
 * `startBrowserPeer`: the shared machinery both browser pages (Task 12's
 * main app, Task 13's image peer) use to join the httpeers mesh and serve
 * through a ServiceWorker. Orchestrates, in order:
 *
 *   1. fetch `httpeers.json` -- `../static-server/main.ts` already serves
 *      it at `/httpeers.json` on both origins, because a browser cannot
 *      read the file `../setup/main.ts` wrote.
 *   2. build the browser libp2p node, dial the relay, wait for the
 *      circuit reservation to actually land (`node-profile.ts`).
 *   3. wire `httpeers.core`'s `createPeer` over that node, against THIS
 *      APPLICATION'S OWN vocabulary (`../policy.ts`'s `VOCABULARY`) paired
 *      with the caller's own `accessTree` -- never `httpeers.core`'s
 *      generic `DEFAULT_VOCABULARY`: tokens this peer verifies were minted
 *      by `../hub/main.ts`, which mints against `../policy.ts`'s
 *      vocabulary, and `createPeer` requires the two supplied together
 *      (`peer.ts`'s own construction-time check) for exactly the reason
 *      that a tree evaluated against the wrong role->capability mapping is
 *      a fail-open.
 *   4. pre-dial the hub over `/webrtc` BEFORE any protocol call reaches it
 *      -- `join.ts`'s `preDialPeer`, see its own doc comment for why this
 *      is not optional (applies to the hub exactly as it would to any
 *      other peer: the hub declares no listen address of its own).
 *   5. redeem the invitation, mint the first token, start the heartbeat +
 *      keepalive timers (`join.ts`'s `startJoin`).
 *   6. mount the ServiceWorker edge (`edge.ts`'s `mountEdge`), with
 *      `edge-dispatch.ts` wrapped around `peer.dispatch` -- the module that
 *      makes a page's plain `fetch()` reach the mesh without the page
 *      holding a token, knowing the mount prefix, or parsing an error
 *      message. See its own comment.
 *
 * A PEER'S ADDRS COME FROM THE MESH VIEW, NEVER FROM THE PEERSTORE. This
 * is the flip side of `join.ts`'s heartbeat sending THIS peer's own
 * `getMultiaddrs()` on every beat: a peer's own addresses are usually
 * local-only (unreserved, or reserved on a DIFFERENT relay hop) until its
 * OWN circuit reservation has landed, so libp2p's `peerStore` entry for
 * some OTHER peer can easily be stale or simply absent. The hub's
 * `/.well-known/mesh` view is built entirely from what each peer reported
 * on its OWN most recent heartbeat (`../hub/endpoints.ts`'s
 * `addrsByPeer`), which is the freshest source available by construction.
 * Any later task that wants to dial a peer discovered through
 * `BrowserPeerHandle.meshView()` must read that peer's `addrs` from the
 * returned `MeshViewMember`, not from `libp2p.peerStore`.
 */
import type { AccessTree, Mounts } from "@statewalker/httpeers.core";
import { createPeer, RevocationCache } from "@statewalker/httpeers.core";
import type { MeshView } from "../hub/mesh-view.js";
import { VOCABULARY } from "../policy.js";
import { mountEdge } from "./edge.js";
import { createEdgeDispatch } from "./edge-dispatch.js";
import type { AdvertisementInput } from "./join.js";
import {
  createRouteEnsurer,
  preDialPeer,
  REVOCATION_MAX_STALENESS_MS,
  redeemInvitation,
  startJoin,
} from "./join.js";
import { createBrowserNode, dialRelay, waitForCircuitReservation } from "./node-profile.js";

/**
 * The invitation payload's shape -- mirrors `../setup/main.ts`'s own
 * `HttpeersConfig` (`{ relayAddrs, hubPeerId }`), redeclared here rather
 * than imported from it: that module pulls in `node:fs`/`node:path` for
 * writing the file, and importing it here for the sake of one interface
 * would drag Node-only code into every page's browser bundle. See that
 * module's own "ONE SHAPE, TWO DELIVERY CHANNELS" comment -- this is the
 * browser side's half of that split, reading the same shape back over
 * HTTP instead of off disk.
 */
export interface HttpeersConfig {
  relayAddrs: string[];
  hubPeerId: string;
}

/** Where both origins serve `httpeers.json` -- `../static-server/main.ts`'s `serveHttpeersConfig`. */
export const DEFAULT_HTTPEERS_CONFIG_URL = "/httpeers.json";

/**
 * Coarse lifecycle states a page can render progress against. Ordered:
 * every successful join passes through each of these exactly once, in
 * this order, before reaching `"ready"`.
 */
export type BrowserPeerState =
  | "loading-config"
  | "connecting-relay"
  | "awaiting-reservation"
  | "starting-peer"
  | "dialing-hub"
  | "joining"
  | "mounting-edge"
  | "ready"
  | "stopped";

export interface StartBrowserPeerInit {
  /** The ServiceWorker adapter key -- also the mount prefix's required first segment; see `edge.ts`'s `assertKeyMatchesPrefix`. */
  key: string;
  /** This peer's own mount table -- served both to other mesh peers (over libp2p) and, mounted unchanged, through the ServiceWorker edge. */
  mounts: Mounts;
  /** This peer's own `.access` tree, evaluated against `../policy.ts`'s `VOCABULARY` -- see the module comment. */
  accessTree: AccessTree;
  /** The invitation id this page redeems on first join -- `../hub/persist.ts`'s `InvitationStore.redeem`. */
  invitationId: string;
  onState?: (state: BrowserPeerState) => void;
  /** Defaults to `DEFAULT_HTTPEERS_CONFIG_URL`. */
  httpeersConfigUrl?: string;
  serviceWorkerUrl?: string;
  /** This peer's own advertisements, read fresh on every heartbeat. Defaults to none. */
  advertisements?: () => AdvertisementInput[];
  /** Relaxes the libp2p connection gater for insecure/loopback relay dials -- local dev only. See `node-profile.ts`'s `CreateBrowserNodeInit.dev`. Required, no default: this module has no bundler-injected `env` of its own to infer it from. */
  dev: boolean;
}

export interface BrowserPeerHandle {
  peerId: string;
  /**
   * The same-origin URL prefix a plain `fetch()` reaches the mesh through --
   * always ending in a slash, so a call composes as
   * `${baseUrl}${peerId}/some/path`.
   *
   * NOT OPTIONAL, AND NOT COSMETIC. The ServiceWorker keys its channel
   * lookup on the URL's FIRST path segment, so this edge is necessarily
   * mounted under `/${key}/` and can never live at `/`
   * (`edge-guard.ts`'s `assertKeyMatchesPrefix`). A page composing a
   * root-relative `/${peerId}/search` would therefore miss the edge
   * entirely and fall through to the static server as a 404 -- the request
   * never reaches the mesh, and nothing says so. Every page-originated mesh
   * call must be composed from this value.
   */
  baseUrl: string;
  /**
   * The mesh's own identity -- `httpeers.json`'s `hubPeerId`, fetched at
   * runtime, echoed here so a page never has to configure it.
   *
   * This is the ONE peer id a page may legitimately hold without
   * discovering it, and only because it is not a discovery at all: it is
   * the mesh identity every token's `mesh` claim restates, and the address
   * of the hub-owned surfaces (`/admin/*`, `/.well-known/*`) that are not
   * services on the bulletin board and are therefore not advertised. Every
   * actual SERVICE -- search included -- is still resolved by `kind` out of
   * `meshView()`.
   */
  hubPeerId: string;
  /** The mesh view as of the last heartbeat that reported a moved `versions.mesh` -- `null` before the first heartbeat lands. See the module comment's "A PEER'S ADDRS COME FROM THE MESH VIEW" note before dialing anything discovered through this. */
  meshView(): MeshView | null;
  stop(): Promise<void>;
}

async function fetchHttpeersConfig(url: string): Promise<HttpeersConfig> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `startBrowserPeer: GET ${url} -> ${res.status} ${res.statusText} -- ` +
        'has the server been through "pnpm bootstrap" yet?',
    );
  }
  return (await res.json()) as HttpeersConfig;
}

export async function startBrowserPeer(init: StartBrowserPeerInit): Promise<BrowserPeerHandle> {
  const configUrl = init.httpeersConfigUrl ?? DEFAULT_HTTPEERS_CONFIG_URL;
  const onState = init.onState ?? ((): void => {});

  onState("loading-config");
  const config = await fetchHttpeersConfig(configUrl);
  const relayAddr = config.relayAddrs[0];
  if (relayAddr == null) {
    throw new Error("startBrowserPeer: httpeers.json's relayAddrs is empty -- nothing to dial.");
  }

  onState("connecting-relay");
  const node = await createBrowserNode({ dev: init.dev });

  // EVERYTHING FROM HERE ON IS UNWOUND IF IT FAILS. `node` is running the
  // moment `createBrowserNode` returns, and a `startBrowserPeer` that threw
  // partway used to leave it running -- holding the relay WebSocket open,
  // keeping its reservation, and (in a page that retries) accumulating one
  // more on every attempt. The page's own `catch` (see
  // `../pages/app/main.ts`) can render the error but has no handle to close.
  // Same rule as `stop()`'s `finally` below, applied to the failure path.
  const unwind: Array<() => Promise<void>> = [async () => await node.stop()];
  const startFailed = async (): Promise<void> => {
    // A COPY, so `startFailed` is idempotent in order. `reverse()` mutates in
    // place, so unwinding twice off the same array would run the steps
    // forwards the second time -- harmless today (every catch below rethrows,
    // so this runs at most once) and silently wrong the moment someone adds a
    // path that does not.
    for (const step of [...unwind].reverse()) await step().catch(() => {});
  };

  try {
    await dialRelay(node, relayAddr);

    onState("awaiting-reservation");
    await waitForCircuitReservation(node);
  } catch (err) {
    await startFailed();
    throw new Error(
      `startBrowserPeer: could not reserve a circuit slot through the relay at "${relayAddr}" -- ` +
        "this page cannot join the mesh without one. Is the relay running, and is httpeers.json's " +
        `relayAddrs[0] the address it is actually listening on? Cause: ${String(err)}`,
      { cause: err },
    );
  }

  onState("starting-peer");
  const revocationCache = new RevocationCache({ maxStalenessMs: REVOCATION_MAX_STALENESS_MS });
  const peer = await createPeer({
    node,
    mounts: init.mounts,
    accessTree: init.accessTree,
    vocabulary: VOCABULARY,
    hubPeerId: config.hubPeerId,
    revocationCache,
  });
  unwind.push(async () => await peer.stop());

  onState("dialing-hub");
  // See `join.ts`'s `preDialPeer` doc comment: this applies to the hub
  // exactly as it would to any other peer -- libp2p's auto-dial may
  // already hold a relay-only limited connection to it from address
  // exchange alone, and a limited connection silently refuses the
  // `/httpeers/1.0.0` protocol `redeemInvitation` is about to open.
  //
  // CAUGHT, AND NOT BECAUSE THE PAGE CAN CARRY ON WITHOUT IT -- it cannot;
  // `redeemInvitation` on the very next line rides this connection. It is
  // caught because of what libp2p says when the hub holds no reservation:
  // "The dial request has no valid addresses for peer", a sentence that
  // names neither the hub, nor the relay, nor the reservation, and sent two
  // separate investigations down the wrong path (Task 14). The remedy is
  // the same one every time, so it belongs in the message.
  try {
    await preDialPeer(node, relayAddr, config.hubPeerId);
  } catch (err) {
    await startFailed();
    throw new Error(
      `startBrowserPeer: could not reach the hub (${config.hubPeerId}) over the relay at ` +
        `"${relayAddr}". A page reaches the hub at <relay>/p2p-circuit/webrtc/p2p/<hub>, which ` +
        "requires the hub to hold its OWN circuit reservation -- check that the hub process is " +
        `running and reported a relayed address at startup. Cause: ${String(err)}`,
      { cause: err },
    );
  }

  onState("joining");
  let redemption: Awaited<ReturnType<typeof redeemInvitation>>;
  let join: ReturnType<typeof startJoin>;
  try {
    redemption = await redeemInvitation(peer, config.hubPeerId, init.invitationId);
    join = startJoin({
      peer,
      node,
      hubPeerId: config.hubPeerId,
      relayAddr,
      initialToken: redemption.token,
      revocationCache,
      advertisements: init.advertisements,
    });
  } catch (err) {
    await startFailed();
    throw err;
  }
  unwind.push(async () => join.stop());

  onState("mounting-edge");
  // `peer.dispatch` is NOT mounted raw. `edge-dispatch.ts` is the one place
  // that knows what a request originating at this peer's own edge needs --
  // the mount prefix stripped, the current membership token attached, and a
  // thrown `PeerCallError` turned into a Response the page can read a
  // `kind` off. See that module's comment; in particular, it is what keeps
  // a page an ordinary `fetch()` client with no token of its own, and it
  // leaves inbound traffic from other peers untouched.
  let edge: Awaited<ReturnType<typeof mountEdge>>;
  try {
    edge = await mountEdge({
      key: init.key,
      serviceWorkerUrl: init.serviceWorkerUrl,
      dispatch: createEdgeDispatch({
        dispatch: peer.dispatch,
        key: init.key,
        token: () => join.token(),
        // The one thing that makes a page's `fetch()` of ANOTHER PAGE work
        // at all -- see `edge-dispatch.ts`'s job 4 and `join.ts`'s
        // `createRouteEnsurer`. Supplied here rather than inside
        // `createEdgeDispatch` because it is the libp2p half, and that
        // module is deliberately libp2p-free.
        ensureRoute: createRouteEnsurer({
          node,
          relayAddr,
          selfPeerId: peer.peerId,
          meshView: () => join.meshView(),
        }),
      }),
    });
  } catch (err) {
    // A ServiceWorker that will not register is the last thing that can go
    // wrong, and by this point this page is a joined, heartbeating member of
    // the mesh -- unwinding is not tidiness, it is the difference between a
    // failed page and a phantom member the hub keeps listing as online.
    await startFailed();
    throw err;
  }

  onState("ready");

  return {
    peerId: peer.peerId,
    baseUrl: edge.baseUrl,
    hubPeerId: config.hubPeerId,
    meshView: () => join.meshView(),
    async stop() {
      try {
        join.stop();
        await edge.stop();
        await peer.stop();
      } finally {
        // `peer.stop()` does NOT stop `node`: `node` was handed to
        // `createPeer` as an already-constructed, SUPPLIED node
        // (`CreatePeerInit.node`), and `httpeers.core`'s `Peer.stop()`
        // only ever stops a node it built itself (`ownsNode =
        // suppliedNode == null`, `peer.ts`) -- a caller-supplied node was
        // never `createPeer`'s to tear down. `peer-runtime.ts` is the one
        // place that built `node` (via `createBrowserNode`), so it is the
        // one place positioned to close it; skipping this leaves the
        // relay WebSocket and every WebRTC connection open past `stop()`
        // returning (found on review -- a page that stops and restarts
        // would accumulate connections, worse in the multi-tab case).
        // Run in `finally`, not after the block above, so a failure in
        // ANY earlier teardown step still leaves the node closed rather
        // than leaking every connection it holds.
        await node.stop();
        onState("stopped");
      }
    },
  };
}
