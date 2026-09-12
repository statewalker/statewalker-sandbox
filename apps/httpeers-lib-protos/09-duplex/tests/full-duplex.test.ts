/**
 * Is the mesh duplex FULL duplex, or only half?
 *
 * Every other claim in this rung sends an input that ENDS. A WebSocket does
 * not: both sides keep talking with neither input closed. That difference is
 * the whole question for the A2UI shell and for anything WebSocket-shaped, so
 * it gets its own test with nothing else in the way — no JSONL, no adapter,
 * just bytes and a hand-driven input that stays open.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import type { Libp2p } from "@statewalker/httpeers.core";
import { newAsyncGenerator } from "@statewalker/webrun-streams";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDuplexMounts, openDuplex, serveDuplex } from "../src/duplex-mount.js";

const td = new TextDecoder();
const te = new TextEncoder();

describe("09 — full duplex, with the caller's input still open", () => {
  let server: Libp2p;
  let client: Libp2p;
  let stop: () => Promise<void>;

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

    const mounts = createDuplexMounts();
    // Replies to each chunk as it arrives, and never closes its own output.
    mounts.provide("/chat", async function* (input) {
      for await (const chunk of input) {
        yield te.encode(`re:${td.decode(chunk)}`);
      }
    });
    stop = await serveDuplex({ node: server, mounts });
  }, 120_000);

  afterAll(async () => {
    await stop?.();
    await client?.stop();
    await server?.stop();
  });

  it("CLAIM 9 — a reply arrives while the caller's input is STILL OPEN", async () => {
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/chat",
    });

    // A hand-driven outbound stream that we deliberately never end.
    let push!: (value: Uint8Array) => Promise<boolean>;
    const ready = new Promise<void>((resolve) => {
      // `newAsyncGenerator`'s init runs on FIRST PULL, not at construction —
      // so nothing may be pushed until this resolves.
      void resolve;
    });
    const outbound = newAsyncGenerator<Uint8Array>((next) => {
      push = next;
    });
    void ready;

    const replies = duplex.call(outbound)[Symbol.asyncIterator]();

    // Start the machinery, then speak. The first `next()` is what runs the
    // generator's init and therefore assigns `push`.
    const firstReply = replies.next();
    await waitFor(() => push !== undefined, 10_000, "the outbound generator never initialised");

    await push(te.encode("one"));
    const got = await withTimeout(firstReply, 15_000, "no reply while the input was still open");
    expect(td.decode(got.value)).toBe("re:one");

    // And again, proving it is a conversation rather than one exchange.
    const second = replies.next();
    await push(te.encode("two"));
    const got2 = await withTimeout(second, 15_000, "no second reply");
    expect(td.decode(got2.value)).toBe("re:two");

    // TEARDOWN IS `close()`, NOT `return()` — see claim 10, which measures why.
    await duplex.close();
  }, 60_000);

  it("CLAIM 10 — HAZARD: `.return()` on a duplex whose input is still open never completes; `close()` does", async () => {
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/chat",
    });

    let push!: (value: Uint8Array) => Promise<boolean>;
    const outbound = newAsyncGenerator<Uint8Array>((next) => {
      push = next;
    });
    const replies = duplex.call(outbound)[Symbol.asyncIterator]();
    const first = replies.next();
    await waitFor(() => push !== undefined, 10_000, "the outbound generator never initialised");
    await push(te.encode("one"));
    await withTimeout(first, 15_000, "no reply");

    // The documented escape for an async generator is `.return()`, and the
    // consumer's obligation to call it is what `duplex.ts` says prevents a
    // leaked stream slot on both peers. With the INPUT STILL OPEN it does not
    // resolve: the outbound pump is parked awaiting the next value, so nothing
    // unwinds. Measured, not asserted from the source.
    const returned = await settledWithin(
      (replies.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
      3_000,
    );
    expect(returned).toBe("pending");

    // `close()` aborts the underlying stream and does complete. This is the
    // teardown an application must use, and the reason `PeerDuplex.close()`
    // exists rather than leaving callers to the generator protocol.
    const closed = await settledWithin(duplex.close(), 10_000);
    expect(closed).toBe("settled");
  }, 60_000);
});

/** `"settled"` if the promise finishes (either way) inside the budget, `"pending"` if not. */
async function settledWithin(promise: Promise<unknown>, budgetMs: number): Promise<string> {
  return await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), budgetMs)),
  ]);
}

async function waitFor(probe: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withTimeout<T>(promise: Promise<T>, budgetMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} (after ${budgetMs}ms)`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}
