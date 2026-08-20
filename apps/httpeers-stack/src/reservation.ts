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
import { multiaddr } from "@multiformats/multiaddr";
import type { Libp2p } from "@statewalker/httpeers.core";

/** Dial the relay named by `relayAddr` (`httpeers.json`'s `relayAddrs[0]`). Resolving means the link is up -- NOT that a circuit reservation exists yet; see `waitForCircuitReservation`. */
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
    `reservation: no p2p-circuit reservation appeared within ${attempts * intervalMs}ms of dialing the relay -- ` +
      "the relay may be unreachable, or its reservation limits already exhausted.",
  );
}
