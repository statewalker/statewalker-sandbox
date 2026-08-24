/**
 * The hub's libp2p profile -- the Node-side mirror of
 * `../browser/node-profile.ts`.
 *
 * WHY THE HUB NEEDS A PROFILE OF ITS OWN AT ALL. `httpeers.core`'s
 * `createNode` (`transport-duplex.ts`) configures `tcp()` and nothing else.
 * That is right for the library's own tests and for a peer whose callers
 * are all Node processes on a reachable network, and it is exactly wrong
 * for this hub: a browser page has no TCP, so a TCP-only hub is a hub no
 * page can reach. Task 14 proved that at runtime -- the hub's transports
 * were `['@libp2p/tcp']`, its only address `/ip4/127.0.0.1/tcp/<ephemeral>`,
 * and it could not so much as dial the relay's `/ws` address ("The dial
 * request has no valid addresses for peer"). `createPeer` takes a supplied
 * node precisely so a deployment can answer this question for itself, so
 * this module answers it and `main.ts` hands the result over.
 *
 * FOUR TRANSPORTS, EACH LOAD-BEARING:
 *   - `webSockets()` -- how the hub DIALS the relay. The relay listens on
 *     `/ws` only (`@statewalker/httpeers-relay`), so without this the hub cannot reach
 *     the one process that makes it reachable.
 *   - `circuitRelayTransport()` -- how the hub HOLDS the reservation the
 *     relay grants, and therefore how it acquires a `/p2p-circuit` address
 *     a page can dial.
 *   - `webRTC()` -- how an inbound relayed dial gets UPGRADED. A bare
 *     `/p2p-circuit` connection is a LIMITED connection and libp2p refuses
 *     to open `/httpeers/1.0.0` over one; `tests/e2e/node-consumer.test.ts`
 *     pins that refusal. The browser's `../browser/join.ts` `preDialPeer`
 *     therefore dials `<relay>/p2p-circuit/webrtc/p2p/<hub>`, and the hub
 *     can only answer that dial if it carries this transport and listens on
 *     `/webrtc`.
 *   - `tcp()` -- KEPT, not vestigial. Node peers on the same host still
 *     reach the hub this way (`tests/e2e/harness.ts`'s member peers do), and
 *     it costs a browser nothing to have an address it will never pick.
 *
 * `addresses.listen` is `[...listen, "/p2p-circuit", "/webrtc"]`: the same
 * pair `../browser/node-profile.ts` uses, plus whatever direct address the
 * caller asked for. `/p2p-circuit` is what makes libp2p seek a reservation
 * in the first place; `/webrtc` is what makes the upgraded address appear
 * in `getMultiaddrs()` once it has one.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import type { Ed25519PrivateKey, Libp2p } from "@statewalker/httpeers.core";
import { createLibp2p } from "libp2p";

export interface CreateHubNodeInit {
  /** The hub's signing key -- `main.ts`'s `loadHubKey`. Its peerId IS the mesh identity, so this is never optional here. */
  privateKey: Ed25519PrivateKey;
  /**
   * Direct addresses to listen on, in ADDITION to `/p2p-circuit` and
   * `/webrtc`, which this profile always adds. Typically one TCP address
   * for same-host Node peers. Omit for a hub reachable only through the
   * relay.
   */
  listen?: string[];
  /**
   * Relaxes the connection gater so the hub may dial an insecure (`ws://`)
   * loopback relay. Node's default gater permits this already -- unlike the
   * browser's (`../browser/node-profile.ts`'s `CreateBrowserNodeInit.dev`) --
   * so this exists for symmetry and for an explicit deployment that wants to
   * pin the behaviour, not because Node needs it today.
   */
  dev?: boolean;
}

/**
 * Build the hub's libp2p node -- transports wired, NOT yet dialled anywhere.
 * `main.ts` dials the relay and waits for the reservation itself
 * (`../reservation.ts`), kept separate so a hub that cannot reserve fails
 * with a message about the RELAY rather than about node construction.
 */
export async function createHubNode(init: CreateHubNodeInit): Promise<Libp2p> {
  return createLibp2p({
    privateKey: init.privateKey,
    addresses: { listen: [...(init.listen ?? []), "/p2p-circuit", "/webrtc"] },
    transports: [tcp(), webSockets(), webRTC(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: init.dev === true ? { denyDialMultiaddr: async () => false } : undefined,
    services: { identify: identify() },
  });
}
