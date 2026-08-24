/**
 * `dialRelay` against a real relay: the announcement is part of dialing, and
 * it SURVIVES the relay connection dropping.
 *
 * WHY THE SECOND HALF EXISTS. The relay's record of a peer's subnetwork dies
 * with the connection it arrived on -- it has to, or a peer reconnecting under
 * a different name would linger in the old subnetwork. libp2p re-dials a relay
 * it holds a reservation on by itself, promptly and silently, and then asks
 * for the reservation again. Without a re-announcement the relay has no record
 * by then, refuses, and does not get asked a second time: the peer stays
 * connected, holds no reservation, is dialable by nobody, and nothing says so.
 * That failure is invisible from inside the peer, which is exactly the kind
 * this suite is for.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import type { Libp2p } from "@statewalker/httpeers.core";
import { type Relay, startRelay } from "@statewalker/httpeers-relay";
import { createLibp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { dialRelay, waitForCircuitReservation } from "../src/reservation.js";

const SUBNETWORK = "reservation-test";

let relay: Relay | undefined;
let node: Libp2p | undefined;

afterEach(async () => {
  await Promise.resolve(node?.stop()).catch(() => {});
  await relay?.stop().catch(() => {});
  node = undefined;
  relay = undefined;
});

/** The peer profile a Node member uses: WebSockets to the relay, circuit for the reservation. */
async function startNode(): Promise<Libp2p> {
  return createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    addresses: { listen: ["/p2p-circuit"] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

function loopbackAddrOf(started: Relay): string {
  const addr = started.node
    .getMultiaddrs()
    .map((a) => a.toString())
    .find((a) => a.startsWith("/ip4/127.0.0.1/"));
  if (addr == null) throw new Error("the relay reported no loopback address");
  return addr;
}

async function until(label: string, ok: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ok()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: still not true after ${timeoutMs}ms`);
}

describe("dialRelay announces, and keeps announcing", () => {
  it("a dialled peer is recorded in its subnetwork and gets its reservation", async () => {
    relay = await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") });
    node = await startNode();

    await dialRelay(node, { addr: loopbackAddrOf(relay), subnetwork: SUBNETWORK });
    expect(relay.subnetworks.subnetworkOf(node.peerId)).toBe(SUBNETWORK);
    expect(await waitForCircuitReservation(node)).toContain("p2p-circuit");
  }, 45_000);

  it("a dropped relay connection is re-announced, so the reservation comes back", async () => {
    relay = await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") });
    node = await startNode();
    const relayPeerId = relay.node.peerId;

    await dialRelay(node, { addr: loopbackAddrOf(relay), subnetwork: SUBNETWORK });
    await waitForCircuitReservation(node);
    const before = node.getConnections(relayPeerId).map((c) => c.id);
    expect(before.length).toBeGreaterThan(0);

    for (const connection of node.getConnections(relayPeerId)) await connection.close();

    // A DIFFERENT connection, not merely "a connection": libp2p re-dialing on
    // its own is the whole premise, and asserting on the id is what
    // distinguishes "it reconnected and re-announced" from "the close never
    // took effect".
    const peer = node;
    await until("the peer reconnected to the relay", () =>
      peer.getConnections(relayPeerId).some((c) => !before.includes(c.id)),
    );
    await until(
      "the relay recorded the subnetwork again",
      () => relay?.subnetworks.subnetworkOf(peer.peerId) === SUBNETWORK,
    );
    // And the thing that record exists for: the reservation is granted again.
    expect(await waitForCircuitReservation(peer)).toContain("p2p-circuit");
  }, 60_000);
});
