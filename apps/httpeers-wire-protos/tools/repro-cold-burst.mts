/**
 * REPRODUCTION for umbrella #28 — a wide burst of concurrent calls on a
 * connection on which NO REQUEST HAS YET COMPLETED fails wholesale.
 *
 * ============================================================================
 * WHAT THIS DEMONSTRATES
 * ============================================================================
 *
 * Against SHIPPED code — `packages/httpeers.core/src/transport-duplex.ts`, not a
 * prototype and not a copy — a dial-only client that fires 100 concurrent
 * `Remote` calls immediately after `dial()` resolves gets **0 of 100**. One
 * completed request on that same connection first, and the identical burst gets
 * 100 of 100.
 *
 *   cold#1 n=100: ok=0/100      <- 5 runs out of 5
 *   cold#2 n=100: ok=0/100      <- 5 runs out of 5
 *   warm   n=100: ok=100/100    <- 5 runs out of 5
 *   cold#3 n=100: VARIABLE      <- 0/100 in 2 runs, 100/100 in 3
 *
 * Measured over five runs of this script. The first three rows are deterministic
 * across all five; the fourth is NOT, and that is recorded rather than smoothed
 * over — see WHAT THIS DOES NOT CLAIM. The rejections come back as two kinds:
 *
 *   [stream-reset]  StreamResetError: The stream has been reset
 *   [unknown]       UnexpectedEOFError: Unexpected EOF - stream closed while
 *                   reading 0/1 bytes
 *
 * The second of those is filed separately as umbrella #29: `UnexpectedEOFError`
 * falls through `mapPeerCallError` to `UnknownPeerCallError`, i.e. `kind:
 * "unknown"`. See the OTHER OBSERVATIONS section at the bottom.
 *
 * ============================================================================
 * WHAT THIS DOES *NOT* CLAIM
 * ============================================================================
 *
 * **The mechanism is not established, and nothing here guesses at one.** What is
 * reliably known is exactly three things, five runs out of five:
 *
 *   1. The FIRST wide burst in a fresh process, on a connection where no request
 *      has completed, returns 0 of 100.
 *   2. So does the second, on its own fresh connection.
 *   3. A burst preceded by ONE completed request on the same connection returns
 *      100 of 100.
 *
 * And one thing that is explicitly NOT reliable, which is why `cold#3` is in this
 * script at all:
 *
 *   4. A cold burst that follows a SUCCESSFUL burst earlier in the same process
 *      is VARIABLE — 0/100 in 2 runs, 100/100 in 3. An earlier session saw the
 *      same after three smaller bursts (2, 10 and 40 concurrent, all passing)
 *      preceded a cold 100-burst that then passed.
 *
 * So the precondition is not purely per-connection: something process-wide
 * participates. WHAT that is has not been determined, and a speculative cause
 * attached to this would be worse than nothing, so there isn't one. Do not read
 * "cold" as a claim about JIT, about identify, about yamux window negotiation, or
 * about anything else; it names the observation ("no request has completed on
 * this connection yet"), not a theory.
 *
 * The verdict below therefore gates on (1)-(3) ONLY. `cold#3` is reported and
 * never asserted — gating on it would have produced a repro that "fails" three
 * runs in five for a reason that is not the bug.
 *
 * ============================================================================
 * VERSIONS
 * ============================================================================
 *
 * Measured 2026-09-09/10 on:
 *
 *   node                                 v24.8.0
 *   libp2p                               3.3.8
 *   @chainsafe/libp2p-noise              17.0.0
 *   @chainsafe/libp2p-yamux              8.0.1
 *   @libp2p/tcp                          11.0.26
 *   @libp2p/identify                     4.1.12
 *   @libp2p/interface                    3.2.5
 *   @statewalker/webrun-http-streams     0.2.1
 *   @statewalker/webrun-streams-libp2p   0.1.1
 *   pnpm                                 10.16.1
 *
 * Loopback TCP only; no relay, no WebRTC, no network.
 *
 * ============================================================================
 * HOW TO RUN IT
 * ============================================================================
 *
 * From the repository root:
 *
 *   pnpm install --filter @statewalker/httpeers.core...
 *   pnpm --filter @statewalker/httpeers.core exec tsx \
 *     ../../apps/httpeers-wire-protos/tools/repro-cold-burst.mts
 *
 * The `../../` is load-bearing: `pnpm --filter … exec` runs with the cwd set to
 * the FILTERED PACKAGE's directory, not the repo root, so a root-relative path
 * resolves inside `packages/httpeers.core/` and fails with ERR_MODULE_NOT_FOUND.
 * The filter is what puts `httpeers.core`'s own dependencies on the resolution
 * path — this app does not depend on it and must not be made to.
 *
 * It must be run through `tsx` (or vitest): `transport-duplex.ts` imports
 * `@statewalker/webrun-http-streams`, whose `exports` points at TypeScript
 * source inside `node_modules`, and Node refuses that with
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` — note 08 finding three of
 * `notes/drive/2026-09-07.Sandclaw-Httpeers/`, still true of the published
 * packages.
 *
 * Exits 0 if the deterministic part reproduced — both of the first two cold bursts
 * at 0/100 and the warm burst at 100/100 — and 1 if it did not, so a later run
 * that comes back clean is visible as a change rather than a quiet pass.
 * `cold#3`'s row is printed either way and is never part of the verdict.
 *
 * ============================================================================
 * WHY THE SUITE DOES NOT CATCH IT
 * ============================================================================
 *
 * `packages/httpeers.core/tests/` has 176 tests across 11 files and **nothing in
 * any of them fires more than 9 concurrent calls.** `concurrency.test.ts` is the
 * file that would: its widest case is 9 calls through a width-3 semaphore, so
 * only 3 are ever in flight. Every other file is sequential. The burst shape is
 * simply not exercised.
 *
 * This file is NOT a test and is not wired into any suite. It is a
 * reproduction, kept next to `mutate.mjs` because that is where this app's
 * investigative tooling lives. It does not modify `httpeers.core`.
 *
 * ============================================================================
 * OTHER OBSERVATIONS, same package, not modified
 * ============================================================================
 *
 * Both found while establishing the above. Recorded here so they travel with the
 * repro rather than living only in a report.
 *
 * **umbrella #29 — `UnexpectedEOFError` reaches `kind: "unknown"`.**
 * `mapPeerCallError`'s doc comment states the contract as "you get a
 * `PeerCallError`, never a raw transport exception". The class *is* wrapped, so
 * the letter holds — but `UnknownPeerCallError` / `kind: "unknown"` is not what
 * the taxonomy promises for a condition the taxonomy already knows about:
 * `errors.ts` carries a narrowed branch for the ADJACENT case, a `HttpParseError`
 * whose message includes "stream ended before any bytes arrived", mapped to
 * `PeerStreamResetError`. `UnexpectedEOFError` is a different class arriving at
 * the same place from the same cause and is unmapped. `errors.test.ts` cannot
 * catch it because nothing there bursts. Filed separately from #28 deliberately:
 * fixing the taxonomy does not fix the burst.
 *
 * **The config hazard (inside #28).** `DEFAULT_MAX_CONCURRENT_OUTBOUND` is
 * defined as `DEFAULT_MAX_STREAMS`, and the doc comment explains why the two are
 * deliberately equal. It does not say they must be CHANGED together, and nothing
 * enforces it — so **lower one and the semaphore stops protecting anything.** Set `maxOutboundStreams` below `maxConcurrentOutbound` and the
 * semaphore admits more than libp2p's per-connection cap allows, so the cliff
 * `DEFAULT_MAX_CONCURRENT_OUTBOUND` exists to remove is back. Measured, dial-only
 * client, 100 concurrent:
 *
 *   default                    → ok=100/100
 *   sem=200 cap=512            → ok=100/100
 *   sem=200 cap=64             → ok= 64/100   errs=["stream-reset"]
 *
 * The last line is the hazard: 36 calls rejected, by the exact mechanism the
 * semaphore was built to prevent.
 *
 * **And one thing that is NOT a defect, recorded because it was nearly filed as
 * one.** The blind spot found in `apps/httpeers-wire-protos` — where a node that
 * dials without REGISTERING the protocol is capped at libp2p's default 64
 * outbound streams rather than `DEFAULT_MAX_STREAMS` — does **not** apply here.
 * `createRemote` passes `maxOutboundStreams` as a PER-DIAL option into
 * `node.dialProtocol(peer, [proto], dialOptions)` by way of `connect()`
 * (`webrun-streams-libp2p@0.1.1`, `dist/index.js:270`), rather than relying on a
 * `node.handle` registration the way that prototype's `serveWire` did. And
 * `concurrency.test.ts` already covers exactly that configuration: its `clientA`
 * is `node(false)` and never calls `serveTransport`. That question is closed.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { tcp } from "@libp2p/tcp";
import { createLibp2p } from "libp2p";
import { createMounts } from "../../../packages/httpeers.core/src/router.js";
import {
  createRemote,
  serveTransport,
} from "../../../packages/httpeers.core/src/transport-duplex.js";
import { json } from "../../../packages/httpeers.core/src/types.js";

const CONCURRENCY = 100;
const HOLD_MS = 150;

const node = (listen: boolean) =>
  createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Outcome {
  label: string;
  ok: number;
  total: number;
  errors: string[];
}

/**
 * One probe: a fresh server, a fresh DIAL-ONLY client (it never calls
 * `serveTransport`, which is the shape a client-only edge peer has), and a burst
 * of `CONCURRENCY` calls. `warm` decides whether one request is allowed to
 * complete on the connection first — that single bit is the whole variable.
 */
async function probe(label: string, warm: boolean): Promise<Outcome> {
  const server = await node(true);
  const mounts = createMounts();
  mounts.provide("/slow", async () => {
    await sleep(HOLD_MS);
    return json({ ok: true });
  });
  const stopServing = await serveTransport({
    node: server,
    dispatch: async (req) => mounts.match(new URL(req.url).pathname)?.(req) ?? json({}, 404),
    // Generous on purpose: the server's INBOUND cap must not be what trips, so
    // that whatever this reproduces cannot be confused with the documented
    // per-connection stream cap.
    maxInboundStreams: 1000,
  });

  const client = await node(false);
  const addr = server.getMultiaddrs()[0];
  if (addr == null) throw new Error("server has no listen address");
  await client.dial(addr);

  // A long request timeout so a timeout cannot be mistaken for the failure —
  // the default 8s would otherwise be a competing explanation.
  const remote = createRemote({ node: client, requestTimeoutMs: 60_000 });
  const target = server.peerId.toString();

  if (warm) await remote(target, new Request("http://peer/slow"));

  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, () => remote(target, new Request("http://peer/slow"))),
  );
  const ok = settled.filter((r) => r.status === "fulfilled").length;
  const errors = [
    ...new Set(
      settled
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => {
          const reason = r.reason as { kind?: string; cause?: { name?: string; message?: string } };
          return `[${reason.kind ?? "?"}] ${reason.cause?.name}: ${reason.cause?.message}`;
        }),
    ),
  ];

  await stopServing();
  await client.stop();
  await server.stop();
  return { label, ok, total: CONCURRENCY, errors };
}

const results: Outcome[] = [];
console.log(`\numbrella #28 — ${CONCURRENCY} concurrent calls, shipped transport-duplex.ts\n`);

for (const [label, warm] of [
  ["cold#1", false],
  ["cold#2", false],
  ["warm  ", true],
  ["cold#3", false],
] as const) {
  const outcome = await probe(label, warm);
  results.push(outcome);
  console.log(`  ${label} n=${outcome.total}: ok=${outcome.ok}/${outcome.total}`);
  for (const e of outcome.errors) console.log(`          ${e}`);
}

// GATE ON THE DETERMINISTIC PART ONLY. cold#1, cold#2 and warm held across all
// five measured runs; cold#3 did not (0/100 twice, 100/100 three times), so it is
// reported and never asserted. See WHAT THIS DOES NOT CLAIM in the header.
const gated = results.filter((r) => r.label === "cold#1" || r.label === "cold#2");
const warms = results.filter((r) => r.label.startsWith("warm"));
const cold3 = results.find((r) => r.label === "cold#3");
const reproduced =
  gated.length === 2 &&
  gated.every((r) => r.ok === 0) &&
  warms.length === 1 &&
  warms.every((r) => r.ok === r.total);

console.log(
  reproduced
    ? `\nREPRODUCED: cold#1 and cold#2 returned 0/${CONCURRENCY}; warm returned ${CONCURRENCY}/${CONCURRENCY}.\n` +
        `  cold#3 returned ${cold3?.ok}/${CONCURRENCY} — EXPECTED TO VARY, and not part of the verdict.\n`
    : "\nNOT REPRODUCED on this run. That is a CHANGE, not a pass — record which of cold#1,\n" +
        "cold#2 or warm moved, because all three held across five measured runs. cold#3 is\n" +
        "not a gate and its value is irrelevant here (see this file's header).\n",
);
process.exit(reproduced ? 0 : 1);
