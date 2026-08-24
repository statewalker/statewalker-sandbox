/**
 * T4: subnetworks, proved against real nodes over loopback.
 *
 * THE ASSERTION THAT MATTERS IS THE NEGATIVE ONE, and a negative assertion is
 * exactly where a test can pass because everything failed. So every refusal
 * here is checked for WHY it failed: circuit relay v2 answers a gated HOP
 * CONNECT with `Status.PERMISSION_DENIED`, which the dialing side surfaces as
 * "failed to connect via relay with status PERMISSION_DENIED". A timeout, an
 * unreachable relay, or a destination that simply lost its reservation
 * (`NO_RESERVATION`) all read differently -- see `describeFailure` and
 * `PERMISSION_DENIED`. Asserting only "the dial rejected" would pass against
 * a relay that was never running.
 *
 * The positive control sits next to every negative one: the same two peers,
 * the same relay, the same dial -- differing only in the subnetwork name --
 * reach each other.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { type Relay, startRelay } from "../src/relay.js";
import { announceSubnetwork, SubnetworkRefusedError } from "../src/subnetwork.js";

/**
 * `Status.PERMISSION_DENIED` from circuit relay v2's own status enum -- what
 * the relay answers when the connection gater refuses, and the one code that
 * distinguishes "this relay decided against you" from every other way a
 * relayed dial can fail.
 */
const PERMISSION_DENIED = "status PERMISSION_DENIED";

const running: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  while (running.length > 0) {
    const item = running.pop();
    try {
      await item?.stop();
    } catch {
      // A node that failed to start has nothing to stop.
    }
  }
});

function track<T extends { stop: () => Promise<void> }>(item: T): T {
  running.push(item);
  return item;
}

/** A peer that can dial a `ws` relay, announce a subnetwork, and hold the reservation it is granted. */
async function startPeer(): Promise<Libp2p> {
  const node = await createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    // `/p2p-circuit` is what makes libp2p seek a reservation at all.
    addresses: { listen: ["/p2p-circuit"] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  running.push({ stop: async () => void (await node.stop()) });
  return node;
}

/** The relay's own loopback `/ws` address, as a peer would be told it. */
function relayAddrOf(relay: Relay): string {
  const addr = relay.node
    .getMultiaddrs()
    .map((a) => a.toString())
    .find((a) => a.startsWith("/ip4/127.0.0.1/"));
  if (addr == null) throw new Error("the relay reported no loopback address");
  return addr;
}

/**
 * What every peer does in a real deployment: dial the relay, then announce
 * which subnetwork it belongs to before the reservation lands.
 */
async function dialAndAnnounce(node: Libp2p, relay: Relay, subnetwork: string): Promise<void> {
  await node.dial(multiaddr(relayAddrOf(relay)));
  await announceSubnetwork(node, relay.node.peerId, subnetwork);
}

/** Poll until a `/p2p-circuit` address appears -- the only proof the relay granted a reservation. */
async function waitForReservation(node: Libp2p, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = node.getMultiaddrs().find((addr) => addr.toString().includes("p2p-circuit"));
    if (found != null) return found.toString();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no p2p-circuit reservation appeared within ${timeoutMs}ms`);
}

/**
 * Poll until the relay has forgotten `peer`'s subnetwork.
 *
 * POLLED, NOT ASSERTED OUTRIGHT. Closing a connection from the dialing side
 * drops that side's reservation immediately, while the relay learns of it one
 * `connection:close` event later. The two are not simultaneous, and a test
 * that asserted the record was gone the instant the client's own address
 * disappeared would be asserting an ordering nothing promises.
 */
async function waitForRecordDropped(relay: Relay, node: Libp2p, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (relay.subnetworks.subnetworkOf(node.peerId) === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the relay still held a subnetwork record after ${timeoutMs}ms`);
}

/**
 * Everything a failed dial actually said, `AggregateError` and `cause` chains
 * included. libp2p wraps a transport's error in a dial error carrying the
 * per-address failures, so the relay's status code is one or two levels down
 * -- and a test that only read `err.message` would be asserting on the
 * wrapper, which says the same thing for every kind of failure.
 */
function describeFailure(err: unknown, depth = 0): string {
  if (depth > 6 || err == null) return String(err);
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(`${err.name}: ${err.message}`);
    const aggregate = (err as { errors?: unknown[] }).errors;
    if (Array.isArray(aggregate)) {
      for (const inner of aggregate) parts.push(describeFailure(inner, depth + 1));
    }
    if (err.cause != null) parts.push(describeFailure(err.cause, depth + 1));
  } else {
    parts.push(String(err));
  }
  return parts.join(" | ");
}

/** Dial `addr` and return what went wrong, or `null` when the dial succeeded. */
async function dialFailure(node: Libp2p, addr: string): Promise<string | null> {
  try {
    await node.dial(multiaddr(addr), { signal: AbortSignal.timeout(15_000) });
    return null;
  } catch (err) {
    return describeFailure(err);
  }
}

describe("T4: a subnetwork partitions who can reach whom", () => {
  it("two peers announcing the SAME name reach each other through the relay", async () => {
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );

    const listener = await startPeer();
    await dialAndAnnounce(listener, relay, "shared-name");
    const circuit = await waitForReservation(listener);

    const dialer = await startPeer();
    await dialAndAnnounce(dialer, relay, "shared-name");

    const connection = await dialer.dial(multiaddr(circuit));
    expect(connection.remotePeer.toString()).toBe(listener.peerId.toString());
  }, 45_000);

  it("two peers announcing DIFFERENT names do not, and the relay is what refused them", async () => {
    // The positive control above differs from this test in one string. If
    // this refusal were coming from a timeout, an unreachable relay or a
    // missing reservation, that one would fail too.
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );

    const listener = await startPeer();
    await dialAndAnnounce(listener, relay, "subnetwork-one");
    const circuit = await waitForReservation(listener);

    const dialer = await startPeer();
    await dialAndAnnounce(dialer, relay, "subnetwork-two");

    const failure = await dialFailure(dialer, circuit);
    expect(failure).not.toBeNull();
    // The relay decided this, and said so in the hop response. Not a timeout
    // (which carries no status at all), and not NO_RESERVATION (204) -- the
    // listener's reservation is live, as the positive control proves.
    expect(failure).toContain(PERMISSION_DENIED);
    expect(dialer.getConnections(listener.peerId)).toHaveLength(0);
  }, 45_000);

  it("a peer that announces nothing cannot reserve, even on an open relay", async () => {
    // Decision 7: there is no default subnetwork. `open` means "any name is
    // accepted", not "no name is fine".
    const relay = track(
      await startRelay({
        port: 0,
        privateKey: await generateKeyPair("Ed25519"),
        // Short, so the test does not sit through the production grace for a
        // peer that is never going to announce. The grace is what the timing
        // is about; the refusal is not.
        admissionGraceMs: 250,
        log: () => {},
      }),
    );

    const silent = await startPeer();
    await silent.dial(multiaddr(relayAddrOf(relay)));

    await expect(waitForReservation(silent, 4_000)).rejects.toThrow(/no p2p-circuit reservation/);
    expect(relay.subnetworks.subnetworkOf(silent.peerId)).toBeUndefined();

    // The control: an otherwise identical peer that DID announce reserves
    // against the same relay, so the refusal above was about the missing name
    // and not about anything else in this setup.
    const announced = await startPeer();
    await dialAndAnnounce(announced, relay, "now-announced");
    expect(await waitForReservation(announced)).toContain("p2p-circuit");

    // A FRESH PEER, NOT `silent` ANNOUNCING LATE, AND THE REASON IS WORTH
    // KNOWING: libp2p does not promptly retry a reservation the relay
    // refused. `ReservationStore.addRelay`'s catch re-adds a peer to its
    // filter only for dial and unsupported-protocol failures, so a
    // PERMISSION_DENIED leaves the peer connected, un-reserved, and not
    // trying again -- `silent` announcing here would sit without a
    // reservation until something else provoked one. That is exactly why the
    // relay's gater WAITS for an announcement instead of refusing the instant
    // it finds no record (`src/subnetwork-registry.ts`'s admission grace):
    // losing that race once is not a retry, it is a stall.
  }, 45_000);

  it("a peer with no record cannot dial a reserved peer either", async () => {
    // The other half of the partition: admission is not the only gate. A peer
    // that never announced has no subnetwork, so there is no subnetwork it
    // shares with anybody.
    const relay = track(
      await startRelay({
        port: 0,
        privateKey: await generateKeyPair("Ed25519"),
        admissionGraceMs: 250,
        log: () => {},
      }),
    );

    const listener = await startPeer();
    await dialAndAnnounce(listener, relay, "subnetwork-one");
    const circuit = await waitForReservation(listener);

    const stranger = await startPeer();
    await stranger.dial(multiaddr(relayAddrOf(relay)));

    const failure = await dialFailure(stranger, circuit);
    expect(failure).toContain(PERMISSION_DENIED);
  }, 45_000);
});

describe("T4: the protocol explains what the gater can only refuse", () => {
  it('announcing nothing is answered with "no subnetwork name announced"', async () => {
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );
    const peer = await startPeer();
    await peer.dial(multiaddr(relayAddrOf(relay)));

    // `announceSubnetwork` refuses an empty name before it opens a stream, so
    // the wire case is reached by sending the announcement by hand -- which
    // is also what an older peer, or another implementation, would do.
    const stream = await peer.dialProtocol(relay.node.peerId, "/httpeers/relay-net/1.0.0");
    stream.send(new TextEncoder().encode(JSON.stringify({})));
    await stream.close();
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk.subarray());

    const reply = JSON.parse(text) as { ok: boolean; reason: string; message: string };
    expect(reply.ok).toBe(false);
    expect(reply.reason).toBe("no-subnetwork-name");
    expect(reply.message).toContain("no subnetwork name announced");
    // The remedy names the file and the shape it takes there.
    expect(reply.message).toContain("relayAddrs");
  }, 30_000);

  it("a name that is not a name is answered as such, not recorded", async () => {
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );
    const peer = await startPeer();
    await peer.dial(multiaddr(relayAddrOf(relay)));

    await expect(announceSubnetwork(peer, relay.node.peerId, "not a name")).rejects.toThrow(
      SubnetworkRefusedError,
    );
    expect(relay.subnetworks.subnetworkOf(peer.peerId)).toBeUndefined();
  }, 30_000);

  it("registered mode names the mode in its refusal, and accepts a listed name", async () => {
    const relay = track(
      await startRelay({
        port: 0,
        privateKey: await generateKeyPair("Ed25519"),
        mode: "registered",
        networks: [{ name: "listed-one" }],
      }),
    );

    const stranger = await startPeer();
    await stranger.dial(multiaddr(relayAddrOf(relay)));
    const refusal = await announceSubnetwork(stranger, relay.node.peerId, "not-listed").catch(
      (err: unknown) => err as SubnetworkRefusedError,
    );
    expect(refusal).toBeInstanceOf(SubnetworkRefusedError);
    expect((refusal as SubnetworkRefusedError).reason).toBe("not-registered");
    expect((refusal as SubnetworkRefusedError).message).toContain("RELAY_MODE=registered");
    expect(relay.subnetworks.subnetworkOf(stranger.peerId)).toBeUndefined();

    const member = await startPeer();
    await dialAndAnnounce(member, relay, "listed-one");
    expect(relay.subnetworks.subnetworkOf(member.peerId)).toBe("listed-one");
    expect(await waitForReservation(member)).toContain("p2p-circuit");
  }, 45_000);

  it("open mode accepts a name nobody configured", async () => {
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );
    const peer = await startPeer();
    await dialAndAnnounce(peer, relay, "invented-just-now");
    expect(relay.subnetworks.subnetworkOf(peer.peerId)).toBe("invented-just-now");
    expect(await waitForReservation(peer)).toContain("p2p-circuit");
  }, 45_000);
});

describe("T4: a record lives and dies with the connection that made it", () => {
  it("the record is dropped when the connection closes", async () => {
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );
    const peer = await startPeer();
    await dialAndAnnounce(peer, relay, "before");
    expect(relay.subnetworks.subnetworkOf(peer.peerId)).toBe("before");

    for (const connection of peer.getConnections(relay.node.peerId)) await connection.close();
    await waitForRecordDropped(relay, peer);
    expect(relay.subnetworks.subnetworkOf(peer.peerId)).toBeUndefined();
  }, 45_000);

  it("a reconnecting peer that announces a DIFFERENT name is not still in the old one", async () => {
    // The failure this rules out: a stale record would leave a peer
    // partitioned by a name it no longer claims -- reachable by the
    // subnetwork it left and unreachable by the one it joined, with nothing
    // on either side to explain it.
    const relay = track(
      await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }),
    );

    const mover = await startPeer();
    await dialAndAnnounce(mover, relay, "old-subnetwork");
    await waitForReservation(mover);

    for (const connection of mover.getConnections(relay.node.peerId)) await connection.close();
    await waitForRecordDropped(relay, mover);

    await dialAndAnnounce(mover, relay, "new-subnetwork");
    expect(relay.subnetworks.subnetworkOf(mover.peerId)).toBe("new-subnetwork");
    const circuit = await waitForReservation(mover);

    // And behaviourally, which is the claim that matters: the old subnetwork
    // can no longer reach it, and the new one can.
    const old = await startPeer();
    await dialAndAnnounce(old, relay, "old-subnetwork");
    expect(await dialFailure(old, circuit)).toContain(PERMISSION_DENIED);

    const current = await startPeer();
    await dialAndAnnounce(current, relay, "new-subnetwork");
    const connection = await current.dial(multiaddr(circuit));
    expect(connection.remotePeer.toString()).toBe(mover.peerId.toString());
  }, 60_000);
});
