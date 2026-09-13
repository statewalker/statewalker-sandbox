/**
 * 15 — Can a libp2p connection hand out MessagePorts?
 *
 * The requirements document describes the mesh as a connection that yields
 * ports. Nothing in the repo did that: `webrun-rpc` has
 * `byteChannelFromMessagePort` (a port, seen as bytes) and nothing going the
 * other way. This rung builds the missing direction and then refuses to prove
 * it with a bespoke test — the claims that matter run CONSUMERS THAT ALREADY
 * EXIST, unmodified, over a libp2p port:
 *
 *   - webrun-rpc's own port stack (`connect`/`serve`), which is rung 11's
 *     MessagePort column — it runs, and gives a fifth parity column;
 *   - the browser's ServiceWorker HTTP transport
 *     (`handleHttpRequests`/`sendHttpRequest`), which is rung 14's — it does
 *     NOT, and claim 4 is the measurement of why: it transfers a real
 *     `MessagePort` per call, and transfer has no meaning between machines.
 *
 * So "written against a `MessageTarget`" is not by itself enough to cross a
 * mesh. The dividing line is transfer, and claim 5 shows the repo's own way
 * across it.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import { generateMeshKey, mintToken } from "@statewalker/httpeers.core/tokens";
import { peerIdOf } from "@statewalker/httpeers-stack/src/setup/keys.js";
import { handleHttpRequests, sendHttpRequest } from "@statewalker/webrun-http-browser";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import {
  connect as connectPort,
  type MessageTarget,
  multiplexPort,
  serve as servePort,
  structuredCodec,
} from "@statewalker/webrun-rpc";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScenarios } from "../../11-transports/src/scenarios.js";
import { createSite } from "../../11-transports/src/site.js";
import { openPort, servePorts } from "../src/libp2p-ports.js";
import { type DuplexPort, portOverDuplex } from "../src/port-over-duplex.js";

async function newNode(listen: boolean): Promise<Libp2p> {
  return await createLibp2p({
    ...(listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] } } : {}),
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });
}

async function waitFor<T>(probe: () => T | undefined, budgetMs: number, what: string): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what}: still nothing after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("15 — a libp2p connection that hands out ports", () => {
  let server: Libp2p;
  let client: Libp2p;
  let goodToken: string;
  let foreignToken: string;
  let issuer: string;

  beforeAll(async () => {
    server = await newNode(true);
    client = await newNode(false);
    await client.dial(server.getMultiaddrs()[0]!);

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

  it("CLAIM 1 — a message posted on one side arrives on the other, in order", async () => {
    const received: unknown[] = [];
    let servedPort: DuplexPort | undefined;
    const stop = await servePorts({ node: server, protocol: "/t1/1.0.0" }, (port) => {
      servedPort = port;
      port.addEventListener("message", (event) => {
        received.push((event as MessageEvent).data);
      });
    });

    const opened = await openPort({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t1/1.0.0",
    });
    opened.port.postMessage({ n: 1, note: "line\nbreak" });
    opened.port.postMessage({ n: 2 });
    // BINARY, and this is a regression pin, not a flourish. The first framing
    // here was JSONL, which turns a `Uint8Array` into `{"0":1,"1":2,…}` — and
    // every byte-oriented consumer then ignored it and HUNG with no error.
    // A real `MessagePort` carries bytes; so must this one.
    opened.port.postMessage({ n: 3, bytes: new Uint8Array([0, 1, 250, 255]) });

    await waitFor(() => (received.length >= 3 ? true : undefined), 15_000, "no messages arrived");
    expect(received[0]).toEqual({ n: 1, note: "line\nbreak" });
    expect(received[1]).toEqual({ n: 2 });
    const third = received[2] as { n: number; bytes: Uint8Array };
    expect(third.n).toBe(3);
    expect(third.bytes).toBeInstanceOf(Uint8Array);
    expect([...third.bytes]).toEqual([0, 1, 250, 255]);

    // And back the other way, on the same port.
    const back: unknown[] = [];
    opened.port.addEventListener("message", (event) => {
      back.push((event as MessageEvent).data);
    });
    servedPort?.postMessage({ reply: true });
    await waitFor(() => (back.length >= 1 ? true : undefined), 15_000, "no reply arrived");
    expect(back).toEqual([{ reply: true }]);

    await opened.close();
    await stop();
  }, 60_000);

  it("CLAIM 2 — the port carries the PROVEN remote peer", async () => {
    let seen: DuplexPort | undefined;
    const stop = await servePorts({ node: server, protocol: "/t2/1.0.0" }, (port) => {
      seen = port;
    });
    const opened = await openPort({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t2/1.0.0",
    });
    opened.port.postMessage({ hello: true });

    const port = await waitFor(() => seen, 15_000, "the server never saw a port");
    // Noise proved this, not the caller. A claim on a port rung; a proof here.
    expect(port.peerId).toBe(client.peerId.toString());

    await opened.close();
    await stop();
  }, 60_000);

  it("CLAIM 3 — webrun-rpc's port stack runs over it UNCHANGED (a fifth parity column)", async () => {
    // Rung 11's MessagePort column, with the `MessageChannel` replaced by two
    // libp2p-backed ports and NOTHING else changed: same site, same scenarios,
    // same `connect`/`serve` from webrun-rpc.
    const site = createSite({
      issuer,
      selfPeer: server.peerId.toString(),
      callerOf: () => client.peerId.toString(),
    });

    let stopServingRpc: (() => Promise<void>) | undefined;
    const stop = await servePorts({ node: server, protocol: "/t3/1.0.0" }, (port) => {
      void (async () => {
        stopServingRpc = await servePort({ port }, serveFetchOverDuplex(site));
      })();
    });

    const opened = await openPort({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t3/1.0.0",
    });
    const rpc = await connectPort({ port: opened.port });

    const outcomes = await runScenarios((request) => fetchOverDuplex(rpc.call, request), {
      goodToken,
      foreignToken,
    });
    const rows = outcomes.map((o) => `  ${o.pass ? "✓" : "✗"}  ${o.name} — ${o.detail}`);
    console.log(`\nPort-over-libp2p column:\n${rows.join("\n")}\n`);

    expect(outcomes.length).toBe(8);
    expect(outcomes.filter((o) => !o.pass).map((o) => `${o.name}: ${o.detail}`)).toEqual([]);

    await rpc.close();
    await stopServingRpc?.();
    await opened.close();
    await stop();
  }, 120_000);

  it("CLAIM 4 — a transport that TRANSFERS ports cannot cross the mesh", async () => {
    // THIS CLAIM ASSERTED THE OPPOSITE when it was written. The reasoning was
    // that `handleHttpRequests`/`sendHttpRequest` are typed against a
    // `MessageTarget` and never mention a browser, so they should run over a
    // mesh port unchanged. Running it said otherwise, on the first call:
    // `sendStream`'s very first move is
    //
    //     communicationPort.postMessage({type:"START_CALL"}, [channel.port2])
    //
    // — it TRANSFERS a real `MessagePort` per call. Transfer moves ownership
    // between two agents in one process. A mesh stream copies bytes between
    // machines; there is no ownership to move, and no amount of framing
    // invents one. So the limit is a property of that transport, not of the
    // mesh, and claim 5 shows the repo's own answer to it.
    const site = createSite({
      issuer,
      selfPeer: server.peerId.toString(),
      callerOf: () => client.peerId.toString(),
    });

    let stopHandling: (() => void) | undefined;
    const stop = await servePorts({ node: server, protocol: "/t4/1.0.0" }, (port) => {
      stopHandling = handleHttpRequests(port, site);
    });

    const opened = await openPort({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t4/1.0.0",
    });

    // Refused loudly, at the point of the attempt — not a hang, and not a
    // silent copy that would leave the sender holding a port it gave away.
    await expect(
      sendHttpRequest(opened.port, new Request("http://peer.local/hello")),
    ).rejects.toThrow(/transferable/);

    stopHandling?.();
    await opened.close();
    await stop();
  }, 120_000);

  it("CLAIM 5 — the remedy: multiplexPort gives virtual ports that DO cross", async () => {
    // `transferPortMux`'s own docstring names the rule: "use `multiplexPort`
    // where the transport is one pipe of bytes". A mesh stream is one pipe of
    // bytes. So a consumer that wants many ports gets them by emulation over
    // the single mesh port — ids in an envelope rather than handles moved by
    // the platform — and that is how the connection model in the requirements
    // document is actually satisfied.
    let servedPort: DuplexPort | undefined;
    const stop = await servePorts({ node: server, protocol: "/t5/1.0.0" }, (port) => {
      servedPort = port;
    });
    const opened = await openPort({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t5/1.0.0",
    });
    // A first message so the server side materialises its port.
    opened.port.postMessage({ hello: true });
    const remote = await waitFor(() => servedPort, 15_000, "the server never saw a port");

    const accepted: MessageTarget[] = [];
    const serverMux = multiplexPort(remote, {
      codec: structuredCodec,
      side: "responder",
      onPort: (port) => {
        accepted.push(port);
        port.addEventListener("message", (event) => {
          port.postMessage({ echo: (event as MessageEvent).data });
        });
        port.start?.();
      },
    });
    const clientMux = multiplexPort(opened.port, {
      codec: structuredCodec,
      side: "initiator",
    });

    const virtual = await clientMux.openPort();
    const replies: unknown[] = [];
    virtual.addEventListener("message", (event) => {
      replies.push((event as MessageEvent).data);
    });
    virtual.start?.();
    virtual.postMessage({ over: "a virtual port" });

    await waitFor(() => (replies.length > 0 ? true : undefined), 20_000, "no reply on the port");
    expect(replies).toEqual([{ echo: { over: "a virtual port" } }]);
    expect(accepted.length).toBe(1);

    await clientMux.close();
    await serverMux.close();
    await opened.close();
    await stop();
  }, 120_000);

  it("CLAIM 6 — transferables are REFUSED, not silently copied", () => {
    // The honest limit, asserted rather than documented. A real `MessagePort`
    // moves ownership between two agents in one process; a mesh stream copies
    // bytes between machines and there is no ownership to move. Copying
    // silently would leave the sender using a handle it believes it gave away.
    const port = portOverDuplex(async function* () {});
    expect(() => port.postMessage({ x: 1 }, [new MessageChannel().port1])).toThrow(/transferable/);
  });

  it("CLAIM 7 — closing one side is observable to the other", async () => {
    let servedPort: DuplexPort | undefined;
    const stop = await servePorts({ node: server, protocol: "/t6/1.0.0" }, (port) => {
      servedPort = port;
    });
    const opened = await openPort({
      node: client,
      peerId: server.peerId.toString(),
      protocol: "/t6/1.0.0",
    });
    opened.port.postMessage({ hello: true });
    const port = await waitFor(() => servedPort, 15_000, "the server never saw a port");

    // A REAL `MessagePort` gives the peer no close event at all — this is a
    // capability the mesh port ADDS, because a stream end is observable where
    // a port close is not. Anything built on it must not assume the reverse.
    await opened.close();
    await expect(
      Promise.race([
        port.closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("never closed")), 15_000)),
      ]),
    ).resolves.toBeUndefined();

    await stop();
  }, 60_000);
});
