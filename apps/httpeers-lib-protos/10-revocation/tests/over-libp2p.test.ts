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
  const revocations = createRevocations();
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
      const guarded = guardStream(chat, { peerId: ctx.peerId, revocations, pollMs: 50 });
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
    revocations.revoke(client.peerId.toString());
    outbound.push("after");

    // ENFORCEMENT: the guard fires, and the handler never serves that chunk.
    await waitFor(() => serverSaw.includes("revoked"), 15_000, "the guard never fired");
    expect(serverSaw).not.toContain("served:after");

    await duplex.close();
  }, 60_000);

  it("CLAIM 6 — HAZARD: the client is NOT told; an open outbound half masks the termination", async () => {
    // Measured, not assumed: with the caller's input still open, a server-side
    // abort does not surface on the client's inbound half — for 20 s here, and
    // for as long as you care to wait. The client simply stops receiving,
    // which a chat UI renders as silence rather than as "you were removed".
    //
    // Same shape as rung 09's teardown hazard: while the outbound half is
    // open, the stream does not report the other end's state.
    //
    // THE REMEDY IS NOT AT THIS ALTITUDE. A member learns it was removed from
    // the membership heartbeat's typed refusal, which is a fetch on its own
    // schedule. A long-lived stream must never be a peer's only liveness
    // signal, and an API that implies otherwise is lying.
    const duplex = await openDuplex({
      node: client,
      peerId: server.peerId.toString(),
      path: "/chat",
    });

    const outbound = openInput();
    const replies = duplex.call(outbound.iter())[Symbol.asyncIterator]();
    outbound.push("hello");
    await withBudget(replies.next(), 15_000);

    revocations.revoke(client.peerId.toString());
    outbound.push("ignored");

    // MEASURED: the stream ENDS, cleanly, with no reason attached. The client
    // cannot tell "you were removed" from "the peer finished" — and an earlier
    // arrangement of the guard produced no notification at all for 20 s. Both
    // outcomes are silence as far as a UI is concerned.
    const outcome = await withBudget(replies.next(), 20_000);
    const ended =
      outcome === "pending" ||
      (typeof outcome === "object" && outcome !== null && outcome.done === true);
    expect(ended).toBe(true);
    // The point of the claim: whatever arrives, it carries no reason.
    if (outcome !== "pending") expect(outcome.value).toBeUndefined();

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
