/**
 * The browser libp2p profile.
 *
 * A browser cannot listen for inbound TCP the way `../hub/main.ts` /
 * `../relay/main.ts` do (`transport-duplex.ts`'s `createNode`, TCP-only,
 * is Node-side and stays Node-side). Instead this node reserves a relayed
 * address on the deployment's relay and accepts a WebRTC upgrade brokered
 * over it -- WebSockets to dial the relay in the first place,
 * Circuit-Relay-v2 for the reservation and for dialling other peers'
 * relayed addresses, WebRTC for the peer-to-peer upgrade once a relayed
 * connection exists. `addresses.listen: ['/p2p-circuit', '/webrtc']` and
 * this transport list are the exact configuration design note 17 §4 (the
 * relay prototype) and the validated browser-WebRTC prototype (repo notes,
 * `httpeers-plan/prototypes/21-browser-webrtc-prototype-validated/app.ts`)
 * both landed on -- not a guess assembled from the libp2p docs.
 *
 * READINESS IS POLLED, NOT AWAITED (design note 17 §4). `node.dial(relay)`
 * resolving means the WebSocket connection to the relay opened -- it says
 * nothing about whether the relay has finished granting a reservation.
 * That reservation lands asynchronously afterwards, so `waitForCircuitReservation`
 * below polls `getMultiaddrs()` until a `p2p-circuit` address actually
 * appears, on the same schedule (250 ms x 40 attempts = 10 s ceiling) the
 * validated relay test used (`prototypes/16-.../src/relay.test.ts`).
 * Treating `dial`'s resolution as "ready" is exactly the race that note
 * documents this project already got bitten by once.
 *
 * IDENTITY PERSISTS PER ORIGIN, IN INDEXEDDB. Each page (the main app, the
 * image peer) is its own origin (`../static-server/main.ts`'s "TWO PORTS
 * IS A CORRECTNESS REQUIREMENT" note) and therefore its own IndexedDB, so
 * each gets its OWN signing key and therefore its own peerId. That is
 * deliberate, not an oversight: two pages sharing one identity would be
 * two independent libp2p nodes racing to be "the" peer for that identity,
 * which is a different and worse problem than two distinct mesh members.
 * The key is round-tripped through `@libp2p/crypto`'s protobuf encoding --
 * the exact same format `../hub/main.ts` / `../relay/main.ts` use for
 * their own on-disk key files, just written to IndexedDB instead of a
 * file, because a browser has no filesystem to write one to.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import type { Ed25519PrivateKey, Libp2p } from "@statewalker/httpeers.core";
import { generateMeshKey } from "@statewalker/httpeers.core";
import { get, set } from "idb-keyval";
import { createLibp2p } from "libp2p";

/** Where this origin's identity key lives in IndexedDB (via `idb-keyval`, the same store `@statewalker/webrun-http-browser` already uses). */
export const IDENTITY_STORAGE_KEY = "httpeers:identity-key";

/**
 * Load this origin's persisted identity, or generate and persist one on
 * first run. Reuses `httpeers.core`'s own `generateMeshKey` rather than
 * calling `@libp2p/crypto`'s `generateKeyPair` directly a second time --
 * one call site for "how this mesh mints a fresh identity," matching the
 * lesson note 22 §5/§6 draws about reading this workspace's own source
 * before re-deriving something already sitting in it.
 */
async function loadOrCreateIdentity(): Promise<Ed25519PrivateKey> {
  const stored = await get<Uint8Array>(IDENTITY_STORAGE_KEY);
  if (stored != null) {
    const key = privateKeyFromProtobuf(stored);
    if (key.type !== "Ed25519") {
      throw new Error(
        `node-profile: identity key stored at "${IDENTITY_STORAGE_KEY}" is a ${key.type} key -- ` +
          "only Ed25519 is supported (design note 05 §2).",
      );
    }
    return key;
  }
  const key = await generateMeshKey();
  await set(IDENTITY_STORAGE_KEY, privateKeyToProtobuf(key));
  return key;
}

export interface CreateBrowserNodeInit {
  /**
   * Relaxes the libp2p connection gater to allow insecure (`ws://`) and
   * private/loopback dials. libp2p 3.x's browser-only default gater denies
   * BOTH on its own (`libp2p/dist/src/config/connection-gater.browser.js`)
   * -- fine in production, where a real deployment's relay is `wss://` on
   * a real DNS name (`../setup/main.ts`'s `relayAddrFamily`), but fatal in
   * local development, where the relay is `ws://127.0.0.1:<port>/ws`: with
   * the default gater EVERY dial this node makes -- to the relay itself,
   * and to every derived `/p2p-circuit/webrtc/p2p/...` peer address -- is
   * denied before any handshake even starts. Precedent:
   * `workspaces/webrun-wire/apps/p2p-demo/lib/browser-node.ts`, which
   * applies exactly this relaxation gated on `import.meta.env.DEV`.
   * Required here (no default), rather than silently inferred from
   * `import.meta.env.DEV`, because THIS file has no bundler-injected `env`
   * of its own to read -- inferring it here would mean guessing at a value
   * only the caller (a Vite-built page, see `../static-server/main.ts`'s
   * "DIST DIRECTORY LAYOUT" note) actually knows.
   */
  dev: boolean;
}

/**
 * Build this origin's browser libp2p node -- identity loaded/generated,
 * transports and encryption wired, NOT yet dialled anywhere. See
 * `dialRelay` / `waitForCircuitReservation` for the next two steps, kept
 * separate so a caller (`peer-runtime.ts`) can report distinct lifecycle
 * states for "connecting to the relay" and "waiting for the reservation"
 * rather than one opaque await.
 */
export async function createBrowserNode(init: CreateBrowserNodeInit): Promise<Libp2p> {
  const privateKey = await loadOrCreateIdentity();

  return createLibp2p({
    privateKey,
    addresses: { listen: ["/p2p-circuit", "/webrtc"] },
    transports: [webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: init.dev ? { denyDialMultiaddr: async () => false } : undefined,
    services: { identify: identify() },
  });
}

/** Dial the relay named by `relayAddr` (`httpeers.json`'s `relayAddrs[0]`). Resolving means the WebSocket link is up -- NOT that a circuit reservation exists yet; see `waitForCircuitReservation`. */
export async function dialRelay(node: Libp2p, relayAddr: string): Promise<void> {
  await node.dial(multiaddr(relayAddr));
}

/** How often `waitForCircuitReservation` re-checks `getMultiaddrs()`. */
export const RESERVATION_POLL_INTERVAL_MS = 250;
/** How many times it checks before giving up -- 40 x 250 ms = 10 s, the ceiling the validated relay test (`relay.test.ts`) used. */
export const RESERVATION_POLL_ATTEMPTS = 40;

export interface WaitForCircuitReservationInit {
  intervalMs?: number;
  attempts?: number;
}

/**
 * Poll `node.getMultiaddrs()` until a `p2p-circuit` address appears,
 * returning it as a string. See this module's own "READINESS IS POLLED,
 * NOT AWAITED" note for why this exists instead of trusting `dialRelay`'s
 * resolution: the reservation is granted by the relay asynchronously,
 * after the dial itself has already resolved.
 */
export async function waitForCircuitReservation(
  node: Libp2p,
  init: WaitForCircuitReservationInit = {},
): Promise<string> {
  const intervalMs = init.intervalMs ?? RESERVATION_POLL_INTERVAL_MS;
  const attempts = init.attempts ?? RESERVATION_POLL_ATTEMPTS;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = node.getMultiaddrs().find((addr) => addr.toString().includes("p2p-circuit"));
    if (found != null) return found.toString();
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `node-profile: no p2p-circuit reservation appeared within ${attempts * intervalMs}ms of dialing the relay -- ` +
      "the relay may be unreachable, or its reservation limits already exhausted.",
  );
}
