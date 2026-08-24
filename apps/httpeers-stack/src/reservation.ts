/**
 * Dialing the relay, and waiting for the reservation it grants afterwards.
 *
 * TRANSPORT-NEUTRAL ON PURPOSE, AND THAT IS WHY IT LIVES HERE. Both halves
 * of this module touch nothing but `Libp2p.dial` and `Libp2p.getMultiaddrs`,
 * so they are identical for a browser node (`browser/node-profile.ts`), a
 * Node hub (`hub/node-profile.ts`) and a test peer (`tests/e2e/harness.ts`).
 * They used to live in `browser/node-profile.ts`, whose top-level imports
 * include `@libp2p/webrtc` -- which is why `tests/e2e/harness.ts` grew a
 * second, hand-copied poll loop rather than import them (Task 14 reported
 * that duplication as a finding). `@libp2p/webrtc` now loads under Node
 * (its `node-datachannel` binary is installed, Task 20 Step 1), so the
 * import would work today; the copy is still gone because ONE poll loop
 * with one timing contract is the point, not because importing was
 * impossible.
 *
 * READINESS IS POLLED, NOT AWAITED (design note 17 §4). `node.dial(relay)`
 * resolving means the connection to the relay opened -- it says nothing
 * about whether the relay has finished granting a reservation. That
 * reservation lands asynchronously afterwards, so `waitForCircuitReservation`
 * polls `getMultiaddrs()` until a `p2p-circuit` address actually appears, on
 * the same schedule (250 ms x 40 attempts = 10 s ceiling) the validated
 * relay test used (`prototypes/16-.../src/relay.test.ts`). Treating `dial`'s
 * resolution as "ready" is exactly the race that note documents this project
 * already got bitten by once.
 */
import type { PeerId } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "@statewalker/httpeers.core";
import { announceSubnetwork } from "@statewalker/httpeers-relay/subnetwork";

/**
 * One entry of `httpeers.json`'s `relayAddrs`: a relay's address AND the
 * subnetwork this deployment belongs to on it.
 *
 * THE NAME ATTACHES TO THE RELAY ENTRY, NOT TO THE MESH. A subnetwork is a
 * property of reachability through one relay, and a mesh may one day span
 * more than one -- so the name lives beside the address that it qualifies.
 * That is what makes a mesh spanning subnetworks possible later without a
 * second format migration, and it is why this is an object rather than the
 * bare string it used to be.
 */
export interface RelayEntry {
  /** The relay's dialable multiaddr, `/p2p/<relayPeerId>` suffix included. */
  addr: string;
  /** The subnetwork name this deployment announces on that relay. */
  subnetwork: string;
}

/**
 * Dial the relay named by `relay.addr` and announce `relay.subnetwork` to it.
 *
 * ANNOUNCING IS PART OF DIALING, NOT A STEP A CALLER MAY FORGET. The relay's
 * connection gater receives only a peer id, so it has to already know this
 * peer's subnetwork by the time the reservation request arrives -- and a peer
 * that never announced is refused with no reservation and, from libp2p's side,
 * no retry. Binding the two together here is what makes "every peer announces"
 * true by construction rather than by five call sites remembering.
 *
 * Resolving means the link is up and the relay accepted the name -- NOT that
 * a circuit reservation exists yet; see `waitForCircuitReservation`.
 *
 * A `SubnetworkRefusedError` from here carries the relay's own words
 * (`@statewalker/httpeers-relay/subnetwork`): it is a configuration a person
 * fixes, and it is otherwise indistinguishable from the relay being down.
 */
export async function dialRelay(node: Libp2p, relay: RelayEntry): Promise<void> {
  // `connection.remotePeer` rather than parsing `/p2p/...` out of the
  // address: this is the peer id Noise actually proved on this connection,
  // and there is no second place for the two to disagree.
  const connection = await node.dial(multiaddr(relay.addr));
  const relayPeerId = connection.remotePeer;
  await announceSubnetwork(node, relayPeerId, relay.subnetwork);
  keepSubnetworkAnnounced(node, relayPeerId, relay.subnetwork);
}

/**
 * Which `(relay, subnetwork)` pairs a node already re-announces for, so a
 * second `dialRelay` against the same relay does not stack a second listener.
 * Keyed weakly by node: a stopped node's entry goes with it.
 */
const reannouncing = new WeakMap<Libp2p, Set<string>>();

/**
 * Re-announce on every LATER connection to this relay.
 *
 * WITHOUT THIS, ONE DROPPED WEBSOCKET COSTS A PEER THE RELAY PERMANENTLY.
 * The relay's record of a peer's subnetwork dies with the connection it
 * arrived on -- it has to, or a peer that reconnected under a different name
 * would linger in the old subnetwork. libp2p re-dials a relay it has a
 * reservation on by itself, promptly and without telling anybody, and then
 * asks for the reservation again; the relay has no record by then, refuses,
 * and -- as `apps/httpeers-relay`'s own tests record -- does not get asked a
 * second time. The peer stays connected, holds no reservation, is dialable by
 * nobody, and nothing anywhere says so until the page is reloaded.
 *
 * So the announcement is maintained rather than performed once. Best effort
 * by construction: a failure here leaves exactly the state that would have
 * obtained anyway, and the next reconnection tries again.
 */
function keepSubnetworkAnnounced(node: Libp2p, relayPeerId: PeerId, subnetwork: string): void {
  const key = `${relayPeerId.toString()}/${subnetwork}`;
  const seen = reannouncing.get(node) ?? new Set<string>();
  if (seen.has(key)) return;
  seen.add(key);
  reannouncing.set(node, seen);

  // Added AFTER the first dial resolved, so the connection just announced on
  // does not fire this and announce itself twice.
  node.addEventListener("connection:open", (event) => {
    if (!event.detail.remotePeer.equals(relayPeerId)) return;
    void announceSubnetwork(node, relayPeerId, subnetwork).catch((err: unknown) => {
      console.warn(
        `reservation: reconnected to the relay ${relayPeerId.toString()} but could not ` +
          `re-announce subnetwork "${subnetwork}" -- this peer will hold no circuit ` +
          `reservation until it does. Cause: ${String(err)}`,
      );
    });
  });
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
    `reservation: no p2p-circuit reservation appeared within ${attempts * intervalMs}ms of dialing the relay -- ` +
      "the relay may be unreachable, or its reservation limits already exhausted.",
  );
}
