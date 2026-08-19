/**
 * Task 18 (T-3) investigation script -- NOT a test, deliberately not under
 * the tests directory and not matched by vitest.config.ts's include. This is a
 * sweep, not an assertion: it exists so the "did not reproduce" result in
 * `PROVENANCE.md` / the Task 18 report can be RE-RUN, varied, and read,
 * rather than taken on narrative alone. An earlier task deleted its own
 * repro scripts after use; that precedent produced a negative result
 * nobody else could verify or extend, which is exactly the gap this file
 * closes by staying in the repo.
 *
 * WHAT IT LOOKS FOR
 * ------------------
 * While building Task 6a's stream-limit test, a naive "fire 40 concurrent
 * calls in one tick" harness once crashed the whole Node process with an
 * uncaught `StreamResetError` thrown SYNCHRONOUSLY out of
 * `YamuxStream.onRemoteReset` (`@libp2p/utils`) -- not a promise rejection,
 * so nothing in user code (a `.catch`, a `try`/`finally`) could have caught
 * it. `serveConnections`' own `onStream` (`webrun-streams-libp2p`) already
 * wraps its async work in `try`/`finally` plus an outer `.catch`; the crash
 * fires from a genuinely synchronous `dispatchEvent` call inside
 * `onRemoteReset`, BEFORE any of that runs. A reviewer established the
 * trigger is a DIAL BURST -- many real TCP/Noise/Yamux handshakes
 * negotiated in one synchronous tick -- not cap exhaustion; raising
 * `maxInboundStreams`/`maxOutboundStreams` actually REDUCES the chance of
 * hitting it (fewer streams get reset when more are admitted instead).
 *
 * This script tries to reproduce that condition, repeated across many
 * rounds (the original crash was itself flaky -- one hit out of an
 * unspecified small number of attempts), and counts how many times an
 * uncaught synchronous exception actually reaches the top of the stack.
 *
 * THE TWO VARIANTS, AND WHY BOTH
 * -------------------------------
 * - Variant A: N genuinely SEPARATE, freshly-created client nodes, each
 *   independently dialing the SAME server, all fired via `Promise.all`
 *   with ZERO stagger. This is the most literal reading of "many real
 *   TCP/Noise/Yamux handshakes negotiated in one synchronous tick" --
 *   every one of the N is a first-time connection to a distinct peer
 *   identity, so N genuine handshakes really do race in the same tick.
 * - Variant B: ONE client, ONE `connect()` call (which does not itself
 *   dial -- see webrun-streams-libp2p's connect-serve.ts), then N
 *   conn.call() calls fired with zero stagger against a connection that does
 *   not exist yet. This is the shape of Task 6a's very first, replaced
 *   draft -- the one that originally produced the crash -- and drives N
 *   concurrent first-time `dialProtocol` calls to the same peer, which may
 *   or may not dedupe into fewer underlying TCP connections depending on
 *   how fast libp2p's own dial-queue registers the in-flight dial.
 *
 * Both matter because it was not obvious in advance which reading of "dial
 * burst" the original crash actually needed; trying only one risks a false
 * negative from having reproduced the wrong condition.
 *
 * AN uncaughtException HANDLER IS INSTALLED so a synchronous throw that
 * would otherwise kill this process is instead recorded and the run
 * continues -- this still proves the fact under investigation (an
 * uncaught exception reached process-top, uncatchable by any promise-based
 * `try`/`catch`), it just lets counting continue across many rounds
 * instead of losing the process on the very first hit. Each round also
 * runs under a watchdog timeout so a hang in one round cannot stall the
 * whole sweep.
 *
 * HOW TO RUN
 * ----------
 *   cd packages/httpeers.core
 *   pnpm exec tsx scripts/dial-burst-repro.mjs [rounds] [N]
 *
 * `rounds` (default 15) is how many times EACH variant repeats; `N`
 * (default 40) is how many concurrent clients/calls each round fires. The
 * runs cited in `PROVENANCE.md` / the Task 18 report used:
 *   pnpm exec tsx scripts/dial-burst-repro.mjs 80 40
 *   pnpm exec tsx scripts/dial-burst-repro.mjs 120 60
 *   pnpm exec tsx scripts/dial-burst-repro.mjs 100 80
 * (the third run additionally had `identify()` wired into `node()` below --
 * matching `createNode` in `transport-duplex.ts` exactly -- to check
 * whether identify's own extra protocol negotiation right after connection
 * establishment changed anything; toggle the `WITH_IDENTIFY` constant below
 * to switch between the two).
 *
 * PARAMETERS WORTH VARYING if re-opening this investigation:
 * - `rounds` / `N` above -- larger N stresses the OS accept queue and
 *   libp2p's own dial-queue harder; Variant A at N=40 already produces real
 *   `ECONNRESET` promise rejections on a meaningful fraction of clients
 *   under contention, proving the burst condition is genuinely exercised.
 * - `WITH_IDENTIFY` -- toggles the `identify()` service (see above).
 * - The watchdog timeout (`WATCHDOG_MS` below) -- raise it if a slower
 *   machine makes rounds spuriously time out.
 * - Node.js version / machine load -- the original crash was observed once
 *   under conditions this script's sweeps have not exactly reproduced;
 *   different hardware or a busier machine may change the odds.
 *
 * Exit code is 1 if any uncaught synchronous exception was observed, 0
 * otherwise (2 if the script's own driver logic threw).
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";

const WITH_IDENTIFY = true;
const WATCHDOG_MS = 8000;

const encoder = new TextEncoder();

function singleChunkSource(payload) {
  return (async function* () {
    yield encoder.encode(payload);
  })();
}

async function drain(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks.length;
}

async function node(listen) {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    ...(WITH_IDENTIFY ? { services: { identify: identify() } } : {}),
  });
}

// Global counters -- see the header above for why this handler exists
// rather than letting a genuine crash end the sweep on the first hit.
let uncaughtCount = 0;
const uncaughtSamples = [];
process.on("uncaughtException", (err) => {
  uncaughtCount++;
  if (uncaughtSamples.length < 5) {
    uncaughtSamples.push({
      name: err?.name,
      message: err?.message,
      stack: err?.stack?.split("\n").slice(0, 6).join("\n"),
    });
  }
});

async function fastServer() {
  const server = await node(true);
  const handler = async function* (input) {
    for await (const chunk of input) yield chunk;
  };
  const stop = await serveConnections({ node: server }, () => handler);
  return { server, stop };
}

async function variantA(n) {
  const { server, stop } = await fastServer();
  const addr = server.getMultiaddrs()[0];
  const clients = await Promise.all(Array.from({ length: n }, () => node(false)));
  try {
    return await Promise.allSettled(
      clients.map(async (client) => {
        const conn = await connect({ node: client, peer: addr });
        try {
          return await drain(conn.call(singleChunkSource("x")));
        } finally {
          await conn.close();
        }
      }),
    );
  } finally {
    await Promise.allSettled(clients.map((c) => c.stop()));
    await stop();
    await server.stop();
  }
}

async function variantB(n) {
  const { server, stop } = await fastServer();
  const addr = server.getMultiaddrs()[0];
  const client = await node(false);
  try {
    const conn = await connect({ node: client, peer: addr });
    try {
      const promises = Array.from({ length: n }, (_, i) => drain(conn.call(singleChunkSource(`m${i}`))));
      return await Promise.allSettled(promises);
    } finally {
      await conn.close();
    }
  } finally {
    await client.stop();
    await stop();
    await server.stop();
  }
}

function withWatchdog(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} watchdog: exceeded ${ms}ms`)), ms)),
  ]);
}

async function runVariant(label, fn, rounds, n) {
  console.log(`[dial-burst-repro] ${label}: ${rounds} rounds x ${n} concurrent, zero stagger, identify=${WITH_IDENTIFY}`);
  for (let round = 0; round < rounds; round++) {
    const before = uncaughtCount;
    try {
      await withWatchdog(fn(n), WATCHDOG_MS, `${label} round ${round}`);
    } catch (err) {
      console.log(`  round ${round}: ${label} threw (caught, promise-level): ${err?.message}`);
    }
    if (uncaughtCount > before) {
      console.log(`  round ${round}: *** uncaught exception fired (count now ${uncaughtCount}) ***`);
    }
  }
}

async function main() {
  const ROUNDS = Number(process.argv[2] ?? 15);
  const N = Number(process.argv[3] ?? 40);

  await runVariant("Variant A (separate fresh clients)", variantA, ROUNDS, N);
  await runVariant("Variant B (one connection, N conn.call())", variantB, ROUNDS, N);

  console.log(`\n[dial-burst-repro] TOTAL uncaught synchronous exceptions observed: ${uncaughtCount}`);
  for (const s of uncaughtSamples) {
    console.log("--- sample ---");
    console.log(s.name, s.message);
    console.log(s.stack);
  }
  process.exit(uncaughtCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[dial-burst-repro] main() itself rejected:", err);
  process.exit(2);
});
