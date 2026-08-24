/**
 * The post-deploy smoke test: dial a relay, reserve through it, and check its
 * identity is the one that was published.
 *
 * "THE CONTAINER STARTED" IS NOT EVIDENCE. A relay that comes back with a fresh
 * key starts perfectly, logs nothing unusual, holds reservations -- and no peer
 * in the world can reach it, because its peerId is embedded in every multiaddr
 * anybody was ever given. So the assertion that matters is not "it answered"
 * but "it is still the SAME relay", and that is why `expectPeerId` is required
 * rather than optional.
 *
 * IT TAKES A MULTIADDR, WHICH IS WHAT MAKES IT PORTABLE. Against a container on
 * this laptop that is `/ip4/127.0.0.1/tcp/9090/ws/p2p/<id>`; against the
 * deployed relay it is `/dns4/relay.httpeers.net/tcp/443/wss/p2p/<id>`. The
 * transport, the TLS and the host all live in that one string, so pointing this
 * at production is a different argument rather than different code -- which is
 * the only reason to trust it there, having only ever run it here.
 *
 * IT RESERVES, IT DOES NOT ONLY CONNECT. Dialling proves the port is open and
 * the key matches; it says nothing about whether the relay will actually carry
 * anybody. A reservation is the first thing every real peer needs and the first
 * thing that breaks when the relay is misconfigured -- limits exhausted, a
 * subnetwork it will not accept -- so it is what gets checked.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { isProcessEntry } from "./entry.js";
import { announceSubnetwork } from "./subnetwork.js";

/** The subnetwork the smoke peer announces. Any name works on an `open` relay; a `registered` one must list it. */
export const SMOKE_SUBNETWORK = "httpeers-smoke";

export interface SmokeInit {
  /** The relay's full dialable multiaddr, `/p2p/<peerId>` suffix included. */
  addr: string;
  /**
   * The peerId this relay is expected to have. REQUIRED, and the point of the
   * whole exercise -- see the module comment.
   */
  expectPeerId: string;
  /** Defaults to `SMOKE_SUBNETWORK`. */
  subnetwork?: string;
  /** How long to wait for the reservation to land. Defaults to 30s. */
  timeoutMs?: number;
}

export interface SmokeResult {
  peerId: string;
  circuitAddr: string;
  elapsedMs: number;
}

/**
 * Run the smoke test. Throws with an operator-facing message on any failure --
 * this runs in a pipeline, and the message is what somebody reads at the point
 * a deploy is rolled back.
 */
export async function smokeTest(init: SmokeInit): Promise<SmokeResult> {
  const timeoutMs = init.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  const node = await createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    // `/p2p-circuit` is what makes libp2p seek a reservation at all.
    addresses: { listen: ["/p2p-circuit"] },
    transports: [webSockets(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });

  try {
    let connection: Awaited<ReturnType<typeof node.dial>>;
    try {
      connection = await node.dial(multiaddr(init.addr));
    } catch (err) {
      // THE MISMATCH USUALLY LANDS HERE, NOT ON THE CHECK BELOW. A relay
      // multiaddr ends in `/p2p/<id>`, so Noise refuses the handshake before
      // this code sees a connection at all -- and it says "Payload identity key
      // … does not match expected remote identity key", which names neither the
      // cause nor what to do. That sentence is the one an operator would read
      // at 3am while a deploy is broken, so it gets translated rather than
      // passed through. The check below still matters for an address that does
      // NOT pin the id.
      const text = err instanceof Error ? err.message : String(err);
      if (/does not match expected remote identity/i.test(text)) {
        throw new Error(
          `smoke: the relay answering at ${init.addr}\n` +
            `smoke: proved a DIFFERENT identity than the ${init.expectPeerId} it was expected to have.\n` +
            "smoke: libp2p refused the handshake before this test could ask it anything.\n" +
            "smoke: A relay's peerId is embedded in every multiaddr peers dial, so a\n" +
            "smoke: changed identity breaks every published address, every httpeers.json and\n" +
            "smoke: every invitation at once. The usual cause is a host that was given the\n" +
            "smoke: wrong RELAY_KEY, or a name now pointing at a different relay. ROLL BACK.\n" +
            `smoke: libp2p said: ${text}`,
          { cause: err },
        );
      }
      throw new Error(
        `smoke: could not reach the relay at ${init.addr}: ${text}\n` +
          "smoke: the relay is unreachable rather than wrong -- check the host is up, the port\n" +
          "smoke: is published, and (for a wss address) that the certificate is valid.",
        { cause: err },
      );
    }
    const actual = connection.remotePeer.toString();

    // FIRST, BEFORE ANYTHING ELSE. Noise proved this id during the handshake,
    // so a mismatch here means the relay at that address is a different relay
    // -- which is exactly the redeploy failure this test exists to catch, and
    // there is no point testing anything else about a stranger.
    if (actual !== init.expectPeerId) {
      throw new Error(
        `smoke: the relay at ${init.addr} identified as ${actual}, not ${init.expectPeerId}.\n` +
          "smoke: this relay's peerId is embedded in every multiaddr peers dial, so a changed\n" +
          "smoke: identity breaks every published address, every httpeers.json and every\n" +
          "smoke: invitation at once. The usual cause is a deploy that did not receive\n" +
          "smoke: RELAY_KEY and generated a fresh identity instead. ROLL BACK.",
      );
    }

    await announceSubnetwork(node, connection.remotePeer, init.subnetwork ?? SMOKE_SUBNETWORK);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const circuit = node
        .getMultiaddrs()
        .map((a) => a.toString())
        .find((a) => a.includes("p2p-circuit"));
      if (circuit != null) {
        return { peerId: actual, circuitAddr: circuit, elapsedMs: Date.now() - startedAt };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `smoke: the relay at ${init.addr} is the right relay (${actual}) and answered the\n` +
            `smoke: dial, but granted no circuit reservation within ${timeoutMs}ms. It is\n` +
            "smoke: reachable and not usable: check RELAY_MAX_RESERVATIONS against how many\n" +
            "smoke: peers are already holding one, and RELAY_MODE -- a registered relay\n" +
            `smoke: refuses a subnetwork it does not list, and this peer announced\n` +
            `smoke: "${init.subnetwork ?? SMOKE_SUBNETWORK}".`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await Promise.resolve(node.stop()).catch(() => {});
  }
}

/**
 * The process entry. Both values come from the environment rather than
 * arguments so a CI step reads the same as a shell one, and neither has a
 * default: a smoke test that invented the peerId it was checking against would
 * pass against anything.
 */
if (isProcessEntry(import.meta.url)) {
  const addr = process.env.SMOKE_RELAY_ADDR;
  const expectPeerId = process.env.SMOKE_EXPECT_PEER_ID;

  if (addr == null || expectPeerId == null) {
    console.error("smoke: SMOKE_RELAY_ADDR and SMOKE_EXPECT_PEER_ID are both required.");
    console.error("smoke:");
    console.error(
      "smoke:   SMOKE_RELAY_ADDR       the relay's full multiaddr, /p2p/<id> included.",
    );
    console.error("smoke:                          local:  /ip4/127.0.0.1/tcp/9090/ws/p2p/<id>");
    console.error("smoke:                          public: /dns4/<name>/tcp/443/wss/p2p/<id>");
    console.error("smoke:   SMOKE_EXPECT_PEER_ID   the peerId that address is supposed to have.");
    process.exit(2);
  }

  try {
    const result = await smokeTest({ addr, expectPeerId });
    console.log(`smoke: OK -- ${result.peerId} granted a reservation in ${result.elapsedMs}ms`);
    console.log(`smoke: ${result.circuitAddr}`);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
