/**
 * 09 — Does the second altitude work, over the same mesh?
 *
 * Two real libp2p nodes over loopback TCP, a real Noise handshake, and the
 * duplex protocol registered beside the fetch one. The questions are the ones
 * a fetch-only contract cannot answer: does the stream stay open both ways,
 * is the handler told who is calling, does cancellation reach the producer —
 * and does the A2UI adapter survive a `send()` before anything has pulled.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import type { Libp2p } from "@statewalker/httpeers.core";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDuplexMounts,
  type DuplexContext,
  openDuplex,
  serveDuplex,
} from "../src/duplex-mount.js";
import { peerTransportOverDuplex } from "../src/peer-transport.js";

const text = new TextDecoder();
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

async function collect(stream: AsyncIterable<Uint8Array>, limit = Number.POSITIVE_INFINITY) {
  const out: string[] = [];
  for await (const chunk of stream) {
    out.push(text.decode(chunk));
    if (out.length >= limit) break;
  }
  return out;
}

async function* once(value: string): AsyncGenerator<Uint8Array> {
  yield bytes(value);
}

/** Never ends on its own: the caller must be able to walk away. */
async function* nothing(): AsyncGenerator<Uint8Array> {}

describe("09 — duplex over the mesh", () => {
  let server: Libp2p;
  let client: Libp2p;
  let stopServing: () => Promise<void>;
  const mounts = createDuplexMounts();
  const seen: DuplexContext[] = [];
  let producerUnwound = false;

  beforeAll(async () => {
    server = await createLibp2p({
      addresses: { listen: ["/ip4/127.0.0.1/tcp/0"] },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    client = await createLibp2p({
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });
    await client.dial(server.getMultiaddrs()[0]!);

    // ECHO, but half-closed: it reads the caller's input to exhaustion and
    // keeps yielding afterwards. That is the WebSocket-shaped property.
    mounts.provide("/echo", async function* (input, ctx) {
      seen.push(ctx);
      for await (const chunk of input) yield bytes(`echo:${text.decode(chunk)}`);
      yield bytes("after-input-closed");
    });

    // A producer that never stops, so cancellation is observable.
    mounts.provide("/forever", async function* () {
      try {
        for (let n = 0; ; n++) {
          yield bytes(`tick-${n}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        producerUnwound = true;
      }
    });

    // The A2UI side: JSONL in, JSONL out.
    mounts.provide("/a2ui", async function* (input) {
      for await (const chunk of input) {
        const line = text.decode(chunk).trim();
        if (line === "") continue;
        const message = JSON.parse(line) as { hello?: string };
        yield bytes(`${JSON.stringify({ reply: message.hello ?? "?" })}\n`);
      }
    });

    stopServing = await serveDuplex({ node: server, mounts });
  }, 120_000);

  afterAll(async () => {
    await stopServing?.();
    await client?.stop();
    await server?.stop();
  });

  it("CLAIM 1 — bytes cross both ways over a real handshake", async () => {
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/echo",
    });
    const out = await collect(duplex.call(once("hi")));
    expect(out).toEqual(["echo:hi", "after-input-closed"]);
    await duplex.close();
  }, 60_000);

  it("CLAIM 2 — HALF-CLOSE: the handler keeps yielding after the caller's input ends", async () => {
    // Covered by claim 1's second chunk, asserted separately because it is the
    // property that distinguishes a duplex from a request/response.
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/echo",
    });
    const out = await collect(duplex.call(nothing()));
    expect(out).toEqual(["after-input-closed"]);
    await duplex.close();
  }, 60_000);

  it("CLAIM 3 — the handler is told the PROVEN peer, as an argument", async () => {
    const before = seen.length;
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/echo/deep/path",
      token: "a-claim-not-a-proof",
    });
    await collect(duplex.call(once("x")));
    const ctx = seen[before];
    expect(ctx?.peerId).toBe(client.peerId.toString());
    // The path travels in the open frame; the mount matched on a prefix.
    expect(ctx?.path).toBe("/echo/deep/path");
    // A token is whatever the caller wrote. The peer id is not.
    expect(ctx?.token).toBe("a-claim-not-a-proof");
    await duplex.close();
  }, 60_000);

  it("CLAIM 4 — an unmounted path fails the stream rather than hanging", async () => {
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/nothing-here",
    });
    await expect(collect(duplex.call(once("x")))).rejects.toThrow(/no mount/i);
    await duplex.close();
  }, 60_000);

  it("CLAIM 5 — CANCELLATION reaches the producer: breaking the loop unwinds it", async () => {
    producerUnwound = false;
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/forever",
    });
    const first = await collect(duplex.call(nothing()), 3);
    expect(first).toEqual(["tick-0", "tick-1", "tick-2"]);
    await duplex.close();
    await waitFor(() => producerUnwound, 30_000, "the producer's finally never ran");
    expect(producerUnwound).toBe(true);
  }, 60_000);

  it("CLAIM 6 — the A2UI adapter survives a send() BEFORE anything pulls", async () => {
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/a2ui",
    });
    const transport = peerTransportOverDuplex<{ hello?: string; reply?: string }>(duplex);

    // THE BUG THIS CLAIM EXISTS FOR. An earlier sketch of this adapter threw
    // here — `newAsyncGenerator`'s init runs on first pull, so `push` was
    // undefined — and `let push!:` hid it from the compiler. Nothing has
    // iterated `messages()` yet at this point, deliberately.
    const sent = transport.send({ hello: "world" });
    expect(sent).toBeInstanceOf(Promise);

    const iterator = transport.messages()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.reply).toBe("world");

    // The shell's own shape, checked field for field.
    expect(transport.peerId).toBe(server.peerId.toString());
    expect(transport.origin).toBe(`/peer/${server.peerId.toString()}/`);

    // `close()`, never `return()` — claim 10 in `full-duplex.test.ts` measures
    // why: with the outbound stream still open, `.return()` never resolves.
    await duplex.close();
  }, 60_000);

  it("CLAIM 7 — several streams run concurrently and do not mix", async () => {
    const opened = await Promise.all(
      ["a", "b", "c", "d"].map((label) =>
        openDuplex({ node: client, peerId: server.peerId.toString(), path: "/echo" }).then(
          async (duplex) => {
            const out = await collect(duplex.call(once(label)));
            await duplex.close();
            return out[0];
          },
        ),
      ),
    );
    expect(opened.sort()).toEqual(["echo:a", "echo:b", "echo:c", "echo:d"]);
  }, 60_000);
});

async function waitFor(probe: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
