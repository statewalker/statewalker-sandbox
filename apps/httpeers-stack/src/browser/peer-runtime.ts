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
 *   6. mount the ServiceWorker edge (`edge.ts`'s `mountEdge`).
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
import type { AdvertisementInput } from "./join.js";
import { preDialPeer, REVOCATION_MAX_STALENESS_MS, redeemInvitation, startJoin } from "./join.js";
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
  /** The mesh view as of the last heartbeat that reported a moved `versions.mesh` -- `null` before the first heartbeat lands. See the module comment's "A PEER'S ADDRS COME FROM THE MESH VIEW" note before dialing anything discovered through this. */
  meshView(): MeshView | null;
  stop(): Promise<void>;
}

async function fetchHttpeersConfig(url: string): Promise<HttpeersConfig> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `startBrowserPeer: GET ${url} -> ${res.status} ${res.statusText} -- ` +
        'has the server been through "pnpm setup" yet?',
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
  await dialRelay(node, relayAddr);

  onState("awaiting-reservation");
  await waitForCircuitReservation(node);

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

  onState("dialing-hub");
  // See `join.ts`'s `preDialPeer` doc comment: this applies to the hub
  // exactly as it would to any other peer -- libp2p's auto-dial may
  // already hold a relay-only limited connection to it from address
  // exchange alone, and a limited connection silently refuses the
  // `/httpeers/1.0.0` protocol `redeemInvitation` is about to open.
  await preDialPeer(node, relayAddr, config.hubPeerId);

  onState("joining");
  const redemption = await redeemInvitation(peer, config.hubPeerId, init.invitationId);
  const join = startJoin({
    peer,
    node,
    hubPeerId: config.hubPeerId,
    relayAddr,
    initialToken: redemption.token,
    revocationCache,
    advertisements: init.advertisements,
  });

  onState("mounting-edge");
  const edge = await mountEdge({
    key: init.key,
    serviceWorkerUrl: init.serviceWorkerUrl,
    dispatch: peer.dispatch,
  });

  onState("ready");

  return {
    peerId: peer.peerId,
    meshView: () => join.meshView(),
    async stop() {
      join.stop();
      await edge.stop();
      await peer.stop();
      onState("stopped");
    },
  };
}
