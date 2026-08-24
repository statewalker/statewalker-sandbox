/**
 * The relay booted for real, on real ports, dialled by a real peer.
 *
 * Everything here goes through `startRelay` -- the same entry point
 * `src/main.ts` and `apps/httpeers-stack` use -- rather than re-assembling a
 * libp2p node that resembles it. A relay that boots in a test and not in the
 * process is the failure this arrangement exists to make impossible.
 */

import { createServer } from "node:net";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRelayConfig } from "../src/config.js";
import { type Relay, startRelay, startRelayFromConfig } from "../src/relay.js";

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

/**
 * A port nothing is listening on, released immediately.
 *
 * Port 0 is what every other test here uses, but T2 needs the port BEFORE the
 * relay starts: an announce address has to name a concrete port, and there is
 * no way to append one after boot. The window between closing this listener
 * and the relay binding is a race in principle; in practice the kernel does
 * not hand the same ephemeral port out twice in that interval, and a
 * collision would fail loudly (EADDRINUSE) rather than silently.
 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address == null || typeof address === "string") {
        reject(new Error("could not read the probe listener's port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

/** A peer that can dial a `ws` relay and hold the reservation it grants. */
async function startClient(): Promise<Libp2p> {
  const node = await createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    // `/p2p-circuit` is what makes libp2p seek a reservation at all; without
    // it the dial succeeds and no reservation is ever requested.
    addresses: { listen: ["/p2p-circuit"] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
  return node;
}

/**
 * Polls until a `/p2p-circuit` address appears, which is the only proof the
 * relay actually granted a reservation -- `dial` resolving means the link
 * opened and says nothing about the reservation, which lands afterwards.
 * Same 250 ms x 40 schedule `apps/httpeers-stack/src/reservation.ts` uses.
 */
async function waitForReservation(node: Libp2p): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const found = node.getMultiaddrs().find((addr) => addr.toString().includes("p2p-circuit"));
    if (found != null) return found.toString();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no p2p-circuit reservation appeared within 10s");
}

describe("T1: the identity a secret carries is the identity the relay boots with", () => {
  it("the same RELAY_KEY yields the same peerId across restarts -- a redeploy, in miniature", async () => {
    // This is the whole reason RELAY_KEY exists. A container host's
    // filesystem does not survive a deploy; if a restart from the same secret
    // produced a different peerId, every published multiaddr would break and
    // the symptom -- peers cannot connect -- would point nowhere near here.
    const key = await generateKeyPair("Ed25519");
    const relayKey = Buffer.from(privateKeyToProtobuf(key)).toString("base64");
    const expected = peerIdFromPrivateKey(key).toString();

    const peerIds: string[] = [];
    for (let restart = 0; restart < 3; restart++) {
      const config = resolveRelayConfig({ RELAY_KEY: relayKey, RELAY_PORT: "0" });
      const relay = await startRelayFromConfig(config);
      peerIds.push(relay.node.peerId.toString());
      // Fully stopped before the next boot -- this is a restart, not a
      // second relay standing beside the first.
      await relay.stop();
    }
    expect(peerIds).toEqual([expected, expected, expected]);
  });

  it("a key file and the base64 of that same file boot the same relay", async () => {
    const key = await generateKeyPair("Ed25519");
    const expected = peerIdFromPrivateKey(key).toString();
    const relay = track(
      await startRelay({
        port: 0,
        key: Buffer.from(privateKeyToProtobuf(key)).toString("base64"),
      }),
    );
    expect(relay.node.peerId.toString()).toBe(expected);
  });
});

describe("T2: announce independent of listen", () => {
  it("by default the relay announces what it binds -- unchanged behaviour", async () => {
    const relay = track(await startRelay({ port: 0, privateKey: await generateKeyPair("Ed25519") }));
    const addrs = relay.node.getMultiaddrs().map((a) => a.toString());
    expect(addrs.length).toBeGreaterThan(0);
    for (const addr of addrs) expect(addr).toContain("/ip4/");
  });

  it("with RELAY_ANNOUNCE set, a peer dialling the ANNOUNCED address reserves through the relay", async () => {
    // The deployment this unblocks: the relay binds plain ws inside a
    // container while peers must dial a different, public name. libp2p
    // supports that only if announce can differ from listen -- which it could
    // not before T2.
    const port = await freePort();
    const key = await generateKeyPair("Ed25519");
    const relayPeerId = peerIdFromPrivateKey(key).toString();

    const config = resolveRelayConfig({
      RELAY_KEY: Buffer.from(privateKeyToProtobuf(key)).toString("base64"),
      RELAY_PORT: String(port),
      // A DIFFERENT spelling of the same endpoint: dns4/localhost rather than
      // the ip4/0.0.0.0 it binds. If announce were being ignored, the address
      // below would come back as /ip4/... and the assertions would fail.
      RELAY_ANNOUNCE: `/dns4/localhost/tcp/${port}/ws`,
    });
    expect(config.listen).toEqual([`/ip4/0.0.0.0/tcp/${port}/ws`]);

    const relay = track(await startRelayFromConfig(config));
    const announced = relay.node.getMultiaddrs().map((a) => a.toString());

    // What the relay tells peers is the announce address, and ONLY that.
    expect(announced).toEqual([`/dns4/localhost/tcp/${port}/ws/p2p/${relayPeerId}`]);
    expect(announced.some((a) => a.startsWith("/ip4/0.0.0.0"))).toBe(false);

    // And it is dialable: a real peer reaches the relay at the announced
    // address and holds a real reservation through it.
    const client = await startClient();
    running.push({ stop: async () => void (await client.stop()) });
    await client.dial(multiaddr(announced[0]));
    const circuit = await waitForReservation(client);
    expect(circuit).toContain(relayPeerId);
    expect(circuit).toContain("p2p-circuit");
  }, 30_000);

  it("two peers reach each other through a relay reached at its announced address", async () => {
    // Reserving proves the relay accepted the peer. This proves it does the
    // job it exists for: forwarding a connection between two peers that have
    // no other way to reach one another.
    const port = await freePort();
    const key = await generateKeyPair("Ed25519");
    const relay = track(
      await startRelayFromConfig(
        resolveRelayConfig({
          RELAY_KEY: Buffer.from(privateKeyToProtobuf(key)).toString("base64"),
          RELAY_PORT: String(port),
          RELAY_ANNOUNCE: `/dns4/localhost/tcp/${port}/ws`,
        }),
      ),
    );
    const relayAddr = relay.node.getMultiaddrs()[0]?.toString() as string;
    // Both peers below reach the relay only through what it announces, which
    // is not what it binds.
    expect(relayAddr).toContain("/dns4/localhost/");

    const listener = await startClient();
    running.push({ stop: async () => void (await listener.stop()) });
    await listener.dial(multiaddr(relayAddr));
    const circuit = await waitForReservation(listener);

    const dialer = await startClient();
    running.push({ stop: async () => void (await dialer.stop()) });
    const connection = await dialer.dial(multiaddr(circuit));

    expect(connection.remotePeer.toString()).toBe(listener.peerId.toString());
  }, 45_000);
});

describe("T3: the TLS mode decides the scheme the relay binds", () => {
  it("edge listens plain ws", async () => {
    const config = resolveRelayConfig({
      RELAY_KEY: Buffer.from(privateKeyToProtobuf(await generateKeyPair("Ed25519"))).toString(
        "base64",
      ),
      RELAY_TLS: "edge",
      RELAY_PORT: "0",
    });
    const relay: Relay = track(await startRelayFromConfig(config));
    for (const addr of relay.node.getMultiaddrs()) {
      expect(addr.toString()).toContain("/ws");
      expect(addr.toString()).not.toContain("/wss");
    }
  });
});
