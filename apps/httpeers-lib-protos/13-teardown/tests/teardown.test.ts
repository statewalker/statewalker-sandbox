/**
 * 13 — WHY must an open-input duplex be torn down with `close()` rather than
 * `.return()`? And does a plain MessagePort do the same thing?
 *
 * Rungs 09 and 10 both hit this and both worked around it. Twice is a defect
 * report, so this rung diagnoses it, reproduces it on a MessagePort with no
 * libp2p anywhere, fixes it at the source, and then states the one part that
 * CANNOT be fixed because it is a property of the language.
 *
 * WHAT WAS WRONG, in two different ways:
 *
 *   - libp2p (`duplexOverStream`): the inbound generator's `finally` did
 *     `await outboundSource.return?.(undefined)` and then `await outbound`.
 *     Neither settles while the producer is parked, so `.return()` HUNG.
 *   - MessagePort (`emulateMux`): the outbound pump is fire-and-forget, so
 *     `.return()` returned — but nothing ever cancelled the producer, so the
 *     pump stayed parked on it and the producer was never told to stop.
 *
 * Both fixed in the sibling `webrun-wire` worktree:
 *   · `duplexOverStream` cancels without awaiting, and aborts the stream so
 *     the peer is told rather than left guessing.
 *   · `emulateMux` gained `Stream.cancelInput`, so teardown reaches the
 *     producer instead of waiting for it.
 *   · both now acquire the producer's iterator ONCE, because `.return()` on a
 *     wrapper generator is queued behind the wrapper's own pending `next()`.
 *
 * WHAT CANNOT BE FIXED (claim 5): `.return()` on an async generator parked on
 * an unresolvable `await` is queued for ever — no caller, no transport, no
 * library can unwind it. That is why a long-lived producer needs a
 * cancellation signal, and claim 6 shows the pattern that works.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { peerIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { connect as connectPort, serve as servePort } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { connect as connectLibp2p, serve as serveLibp2p } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const te = new TextEncoder();
const PROTOCOL = "/httpeers-teardown/1.0.0";

/** Echoes, and never ends on its own. */
const echo: Duplex = async function* (input) {
  for await (const chunk of input) yield chunk;
};

/**
 * A producer that ticks — yields, waits a little, yields again. The shape of
 * every real long-lived session (a heartbeat, a poll, a subscription), and the
 * one `.return()` can reach: its wait settles, so the queued return lands.
 *
 * NOT an unthrottled `for(;;) yield` loop. That floods rather than parks — the
 * port mux grants an 8 MiB credit window, so an eager producer spends 20
 * seconds filling it and the test measures buffering instead of teardown.
 */
function tickingInput(everyMs = 50) {
  const state = { unwound: false };
  const iterable = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        yield te.encode("tick");
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    } finally {
      state.unwound = true;
    }
  })();
  return { state, iterable };
}

/**
 * A producer parked on an `await` that never settles — a session waiting for
 * data that never comes. Nothing can unwind this; claim 5 measures it.
 */
function awaitParkedInput() {
  const state = { unwound: false };
  const iterable = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      yield te.encode("hello");
      await new Promise<void>(() => {});
    } finally {
      state.unwound = true;
    }
  })();
  return { state, iterable };
}

/**
 * The pattern an API must offer instead: the producer races its wait against
 * a signal, so a caller CAN stop it.
 */
function cancellableInput(signal: AbortSignal) {
  const state = { unwound: false };
  const iterable = (async function* (): AsyncGenerator<Uint8Array> {
    try {
      yield te.encode("hello");
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      state.unwound = true;
    }
  })();
  return { state, iterable };
}

async function settledWithin(work: Promise<unknown>, budgetMs: number): Promise<string> {
  return await Promise.race([
    work.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("pending"), budgetMs);
      timer.unref?.();
    }),
  ]);
}

async function waitFor(probe: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!probe()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

describe("13 — tearing down a duplex whose input is still open", () => {
  describe("over a plain MessagePort — no libp2p anywhere", () => {
    let channel: MessageChannel;
    let stopServing: () => Promise<void>;
    let connection: Awaited<ReturnType<typeof connectPort>>;

    beforeAll(async () => {
      channel = new MessageChannel();
      stopServing = await servePort({ port: channel.port2 }, echo);
      connection = await connectPort({ port: channel.port1 });
    });

    afterAll(async () => {
      await connection?.close();
      await stopServing?.();
      channel?.port1.close();
      channel?.port2.close();
    });

    it("CLAIM 1 — `.return()` settles promptly", async () => {
      const input = tickingInput();
      const output = connection.call(input.iterable)[Symbol.asyncIterator]();
      await output.next();
      const outcome = await settledWithin(
        (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
        3_000,
      );
      expect(outcome).toBe("settled");
    }, 30_000);

    it("CLAIM 2 — the producer is cancelled, so its `finally` runs", async () => {
      const input = tickingInput();
      const output = connection.call(input.iterable)[Symbol.asyncIterator]();
      await output.next();
      await settledWithin(
        (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
        3_000,
      );
      // Before the fix nothing reached the producer at all: the pump was
      // fire-and-forget and teardown had no handle on the input.
      expect(await waitFor(() => input.state.unwound, 3_000)).toBe(true);
    }, 30_000);
  });

  describe("over libp2p", () => {
    let server: Awaited<ReturnType<typeof createLibp2p>>;
    let client: Awaited<ReturnType<typeof createLibp2p>>;
    let stopServing: () => Promise<void>;

    const dial = async () =>
      await connectLibp2p({
        node: client,
        peer: peerIdFromString(server.peerId.toString()),
        protocol: PROTOCOL,
      });

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
      stopServing = await serveLibp2p({ node: server, protocol: PROTOCOL }, echo);
    }, 120_000);

    afterAll(async () => {
      await stopServing?.();
      await client?.stop();
      await server?.stop();
    });

    it("CLAIM 3 — `.return()` settles promptly (it used to hang for ever)", async () => {
      const connection = await dial();
      const input = tickingInput();
      const output = connection.call(input.iterable)[Symbol.asyncIterator]();
      await output.next();

      const outcome = await settledWithin(
        (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
        5_000,
      );
      expect(outcome).toBe("settled");
      await connection.close();
    }, 60_000);

    it("CLAIM 4 — the producer is cancelled, so its `finally` runs", async () => {
      const connection = await dial();
      const input = tickingInput();
      const output = connection.call(input.iterable)[Symbol.asyncIterator]();
      await output.next();

      await settledWithin(
        (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
        5_000,
      );
      expect(await waitFor(() => input.state.unwound, 5_000)).toBe(true);
      await connection.close();
    }, 60_000);

    it("CLAIM 5 — LANGUAGE LIMIT: a producer parked on an unresolvable await cannot be unwound", async () => {
      // Not a transport defect, and not fixable by one. `.return()` on an
      // async generator suspended at an `await` is QUEUED behind that await;
      // if it never settles, the `finally` never runs. Measured directly:
      let unwound = false;
      const gen = (async function* () {
        try {
          yield 1;
          await new Promise<void>(() => {});
        } finally {
          unwound = true;
        }
      })();
      await gen.next();
      void gen.next(); // drive it into the eternal await
      const outcome = await settledWithin(gen.return(undefined), 500);
      expect(outcome).toBe("pending");
      expect(unwound).toBe(false);

      // And the same through the transport, so nobody mistakes it for one:
      const connection = await dial();
      const input = awaitParkedInput();
      const output = connection.call(input.iterable)[Symbol.asyncIterator]();
      await output.next();
      // Teardown itself still settles — that is claim 3's fix — but the
      // producer stays parked, because nothing in JavaScript can wake it.
      expect(
        await settledWithin(
          (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
          5_000,
        ),
      ).toBe("settled");
      expect(await waitFor(() => input.state.unwound, 1_500)).toBe(false);
      await connection.close();
    }, 60_000);

    it("CLAIM 6 — THE REMEDY: a producer that races a signal does unwind", async () => {
      // Which is why a long-lived producer must be handed a cancellation
      // signal. The iterator protocol cannot cancel a waiting producer, so
      // the API has to, and this is the shape that works.
      const controller = new AbortController();
      const connection = await dial();
      const input = cancellableInput(controller.signal);
      const output = connection.call(input.iterable)[Symbol.asyncIterator]();
      await output.next();

      controller.abort();
      await settledWithin(
        (output.return?.(undefined) ?? Promise.resolve()) as Promise<unknown>,
        5_000,
      );
      expect(await waitFor(() => input.state.unwound, 5_000)).toBe(true);
      await connection.close();
    }, 60_000);
  });
});
