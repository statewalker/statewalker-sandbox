/**
 * 17 — Does a PORT FACTORY let one consumer run over every kind of transport?
 *
 * The proposal: `connect`/`serve` should not take a `MessageTarget` and build
 * an id table inside themselves. They should take a SOURCE OF PORTS, and let
 * whoever builds that source decide how ports are made:
 *
 *   one pipe of bytes  -> multiplexPort   (an id table)
 *   a libp2p conn      -> a stream per port (yamux already multiplexed)
 *
 * Today's shape forces the id table on everyone, so running the port stack
 * over libp2p stacks two multiplexers — rung 15 does exactly that, and its own
 * comments warn against it.
 *
 * The scenarios are rung 11's, imported unchanged, so the columns here are
 * produced by the same assertions as every other transport in the ladder.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { generateMeshKey, mintToken } from "@statewalker/httpeers.core/tokens";
import { peerIdOf } from "@statewalker/httpeers-stack/src/setup/keys.js";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { multiplexPort, structuredCodec } from "@statewalker/webrun-rpc";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenarios } from "../../11-transports/src/scenarios.js";
import { createSite } from "../../11-transports/src/site.js";
import { libp2pPortMux } from "../src/libp2p-port-mux.js";
import { callOverPortMux, serveOverPortMux } from "../src/over-port-mux.js";

async function newNode(listen: boolean): Promise<Libp2p> {
  return await createLibp2p({
    ...(listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } } : {}),
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

describe("17 — one consumer, two kinds of port source", () => {
  let server: Libp2p;
  let client: Libp2p;
  let issuer: string;
  let goodToken: string;
  let foreignToken: string;

  beforeAll(async () => {
    server = await newNode(true);
    client = await newNode(false);
    const addr = server.getMultiaddrs()[0];
    if (addr == null) throw new Error("the server is not listening");
    await client.dial(addr);

    const meshKey = await generateMeshKey();
    issuer = peerIdOf(meshKey);
    const sub = client.peerId.toString();
    goodToken = await mintToken({ privateKey: meshKey, sub, roles: ["member"], ttlMs: 600_000 });
    foreignToken = await mintToken({
      privateKey: await generateMeshKey(),
      sub,
      roles: ["member"],
      ttlMs: 600_000,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.stop();
    await server?.stop();
  });

  function site(selfPeer: string, caller: string) {
    return createSite({ issuer, selfPeer, callerOf: () => caller });
  }

  it("CLAIM 1 — over a MessagePort, the factory is multiplexPort (an id table)", async () => {
    const channel = new MessageChannel();
    channel.port1.start();
    channel.port2.start();

    // The SAME subject the token was minted for. An earlier version used
    // invented peer names here, and `/secret` answered 403 — correctly: the
    // binding check compares the token's subject against what the transport
    // proved, and "peer-a" is not who the token is about. The failure was the
    // test's, and it is the check working.
    const serving = serveOverPortMux(
      serveFetchOverDuplex(site("peer-b", client.peerId.toString())),
    );
    const responder = multiplexPort(channel.port2, {
      codec: structuredCodec,
      side: "responder",
      onPort: (port) => {
        serving.onPort(port);
      },
    });
    const initiator = multiplexPort(channel.port1, {
      codec: structuredCodec,
      side: "initiator",
    });

    const call = callOverPortMux(initiator);
    const outcomes = await runScenarios((request) => fetchOverDuplex(call, request), {
      goodToken,
      foreignToken,
    });

    expect(outcomes.length).toBe(8);
    expect(outcomes.filter((o) => !o.pass).map((o) => `${o.name}: ${o.detail}`)).toEqual([]);

    serving.stop();
    await initiator.close();
    await responder.close();
    channel.port1.close();
    channel.port2.close();
  }, 60_000);

  it("CLAIM 2 — over libp2p, the SAME consumer runs with NO id table", async () => {
    // Byte for byte the same `callOverPortMux` / `serveOverPortMux` as claim 1.
    // Only the mux differs, which is the entire proposal.
    const serving = serveOverPortMux(
      serveFetchOverDuplex(site(server.peerId.toString(), client.peerId.toString())),
    );
    const listening = await libp2pPortMux({
      node: server,
      protocol: "/t17/1.0.0",
      onPort: (port) => {
        serving.onPort(port);
      },
    });
    const dialling = await libp2pPortMux({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t17/1.0.0",
    });

    const call = callOverPortMux(dialling);
    const outcomes = await runScenarios((request) => fetchOverDuplex(call, request), {
      goodToken,
      foreignToken,
    });

    const rows = outcomes.map((o) => `  ${o.pass ? "✓" : "✗"}  ${o.name}`);
    console.log(`\nPort-factory over libp2p (no id table):\n${rows.join("\n")}\n`);

    expect(outcomes.length).toBe(8);
    expect(outcomes.filter((o) => !o.pass).map((o) => `${o.name}: ${o.detail}`)).toEqual([]);

    serving.stop();
    await dialling.stop();
    await listening.stop();
  }, 120_000);

  it("CLAIM 3 — one call is one libp2p stream, so yamux is the only multiplexer", async () => {
    // The measurement the proposal rests on. Today's `connect`/`serve` would
    // open ONE stream and run an id table inside it; here each call is its own
    // stream and there is no id table anywhere in the path.
    const serving = serveOverPortMux(
      serveFetchOverDuplex(site(server.peerId.toString(), client.peerId.toString())),
    );
    const listening = await libp2pPortMux({
      node: server,
      protocol: "/t17b/1.0.0",
      onPort: (port) => {
        serving.onPort(port);
      },
    });
    const dialling = await libp2pPortMux({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t17b/1.0.0",
    });

    const call = callOverPortMux(dialling);
    const CALLS = 5;
    for (let i = 0; i < CALLS; i++) {
      const response = await fetchOverDuplex(call, new Request("http://peer.local/hello"));
      expect(response.status).toBe(200);
    }

    expect(dialling.streamsOpened).toBe(CALLS);

    serving.stop();
    await dialling.stop();
    await listening.stop();
  }, 120_000);

  it("CLAIM 4 — a stream built and never iterated opens no port at all", async () => {
    // Lazy opening matters more here than over a MessagePort: an eagerly
    // opened port is a whole libp2p stream, and a caller that changes its mind
    // would leave one open on the peer for a call that never arrives.
    const serving = serveOverPortMux(
      serveFetchOverDuplex(site(server.peerId.toString(), client.peerId.toString())),
    );
    const listening = await libp2pPortMux({
      node: server,
      protocol: "/t17c/1.0.0",
      onPort: (port) => {
        serving.onPort(port);
      },
    });
    const dialling = await libp2pPortMux({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t17c/1.0.0",
    });

    const call = callOverPortMux(dialling);
    for (let i = 0; i < 10; i++) {
      void call((async function* (): AsyncGenerator<Uint8Array> {})());
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(dialling.streamsOpened).toBe(0);

    serving.stop();
    await dialling.stop();
    await listening.stop();
  }, 120_000);
});
