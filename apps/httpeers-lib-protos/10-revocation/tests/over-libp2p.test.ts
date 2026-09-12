/**
 * The same guard, in the real proto: two libp2p peers, rung 09's duplex mount.
 *
 * A guard that only worked over in-process streams would be a guard for a test
 * suite. This mounts it where an application would — wrapping the handler given
 * to `createDuplexMounts().provide(...)` — and revokes a member whose stream is
 * already open over a real Noise-authenticated connection. Nothing about the
 * guard changes between the two rungs, which is the point: enforcement needs no
 * libp2p.
 *
 * IT ALSO MEASURES WHAT THE CLIENT DOES NOT LEARN, which is the more important
 * half. Enforcement is server-side and works; notification does not arrive.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import type { Libp2p } from "@statewalker/httpeers.core";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDuplexMounts, openDuplex, serveDuplex } from "../../09-duplex/src/duplex-mount.js";
import { createRevocations, guardStream, StreamRevoked } from "../src/revocation-guard.js";

const te = new TextEncoder();
const td = new TextDecoder();

describe("10 — the guard, over a real libp2p duplex", () => {
  let server: Libp2p;
  let client: Libp2p;
  let stop: () => Promise<void>;
  // A HOLDER, so each test gets a fresh registry: claim 5 revokes this
  // client, and a shared registry would leave claim 6 refused before it began.
  const holder = { current: createRevocations() };
  /** What the serving side observed, so enforcement is asserted rather than inferred. */
  const serverSaw: string[] = [];

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
    mounts.provide("/chat", (input, ctx) => {
      const chat = async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          serverSaw.push(`served:${td.decode(chunk)}`);
          yield te.encode(`re:${td.decode(chunk)}`);
        }
      };
      // THE WHOLE INTEGRATION, one line at the mount site: the handler is
      // wrapped with the guard, keyed to the peer libp2p proved.
      const guarded = guardStream(chat, {
        peerId: ctx.peerId,
        revocations: holder.current,
        pollMs: 50,
      });
      return (async function* (source: AsyncIterable<Uint8Array>) {
        try {
          yield* guarded(source);
        } catch (error) {
          if (error instanceof StreamRevoked) serverSaw.push("revoked");
          throw error;
        }
      })(input);
    });

    stop = await serveDuplex({ node: server, mounts });
  }, 120_000);

  afterAll(async () => {
    await stop?.();
    await client?.stop();
    await server?.stop();
  });

  it("CLAIM 5 — the server stops serving a revoked member mid-stream, over a real connection", async () => {
    holder.current = createRevocations();
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/chat",
    });

    const outbound = openInput();
    const replies = duplex.call(outbound.iter())[Symbol.asyncIterator]();

    outbound.push("before");
    const first = await withBudget(replies.next(), 15_000);
    expect(first).not.toBe("pending");
    expect(td.decode((first as IteratorResult<Uint8Array>).value)).toBe("re:before");
    expect(serverSaw).toContain("served:before");

    // The hub removes this member. The registry is the same live object the
    // mount reads — no restart, no reconnect, no second request.
    holder.current.revoke(client.peerId.toString());
    outbound.push("after");

    // ENFORCEMENT: the guard fires, and the handler never serves that chunk.
    await waitFor(() => serverSaw.includes("revoked"), 15_000, "the guard never fired");
    expect(serverSaw).not.toContain("served:after");

    await duplex.close();
  }, 60_000);

  it("CLAIM 6 — the client IS told, with the reason, across the wire", async () => {
    // THIS CLAIM USED TO BE A HAZARD. It recorded that a revoked peer's client
    // learned nothing: the stream either stalled or ended with no reason, and a
    // UI could not tell "you were removed" from "the peer finished".
    //
    // Rung 13's fix changed that. `duplexOverStream` now aborts the stream on
    // cancellation, and the framing layer serialises the error — so the
    // guard's `StreamRevoked`, thrown server-side, arrives at the client as a
    // rejection carrying its message.
    holder.current = createRevocations();
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/chat",
    });

    const outbound = openInput();
    const replies = duplex.call(outbound.iter())[Symbol.asyncIterator]();
    outbound.push("hello");
    await withBudget(replies.next(), 15_000);

    holder.current.revoke(client.peerId.toString());
    outbound.push("ignored");

    // The reason reaches the caller. A stream is still not a substitute for
    // the membership heartbeat — that is where a peer learns it was removed
    // when it holds no open stream at all — but it no longer fails silently.
    await expect(replies.next()).rejects.toThrow(/revoked/i);

    await duplex.close();
  }, 90_000);
});

/** The promise's value, or the string `"pending"` if it does not settle in time. */
async function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      const timer = setTimeout(() => resolve("pending"), budgetMs);
      timer.unref?.();
    }),
  ]);
}

async function waitFor(probe: () => boolean, budgetMs: number, what: string): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`${what}: still not true after ${budgetMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function openInput() {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(value: string) {
      queue.push(te.encode(value));
      const w = wake;
      wake = null;
      w?.();
    },
    close() {
      closed = true;
      const w = wake;
      wake = null;
      w?.();
    },
    async *iter(): AsyncGenerator<Uint8Array> {
      for (;;) {
        const next = queue.shift();
        if (next != null) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
