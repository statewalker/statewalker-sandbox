/**
 * 04 — Backpressure is real, not nominal.
 *
 * libp2p 3.x replaced the pull-based `sink(AsyncIterable)` with a push-based
 * `send()` + drain model. The obvious port — `if (!send(chunk)) await
 * stream.onDrain()` — looks right and is not: `onDrain()` memoises one promise
 * and never clears it, so every wait after the first returns an
 * already-settled promise while the stream still needs draining. The write
 * buffer then grows without bound, silently, because yamux sets
 * `maxWriteBufferLength: Infinity`.
 *
 * A code review caught it; no test in the suite could, because `send()`
 * returned false exactly twice across the whole suite — both first-cycle.
 *
 * This demo streams a large body through a real libp2p stream and reports the
 * peak outbound buffer. Bounded means the fix is working.
 */
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createPair, heading } from "../lib/nodes.ts";

heading("04 — a large streamed body does not pile up in memory");

const { server, client, serverAddr, stop } = await createPair();

// Sized so that buffering the whole body would be unmistakable in RSS:
// 2000 x 64 KiB = 125 MiB. Paced, resident memory barely moves.
const CHUNKS = 2000;
const CHUNK_BYTES = 64 * 1024;
const payload = new Uint8Array(CHUNK_BYTES).fill(65);

const stopServing = await serveConnections({ node: server }, () =>
  serveFetchOverDuplex(async (request) => {
    let received = 0;
    const reader = request.body?.getReader();
    if (reader != null) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        // A deliberately slow consumer: this is what creates the pressure.
        if (received % (16 * CHUNK_BYTES) === 0) await new Promise((r) => setTimeout(r, 1));
      }
    }
    return Response.json({ received });
  }),
);

const { call, close } = await connect({ node: client, peer: serverAddr });

let sent = 0;
let lastPullAt = 0;
const body = new ReadableStream<Uint8Array>({
  async pull(controller) {
    if (sent >= CHUNKS) {
      controller.close();
      return;
    }
    controller.enqueue(payload);
    sent += 1;
    lastPullAt = Date.now();
  },
});

const started = Date.now();
const res = await fetchOverDuplex(
  call,
  // @ts-expect-error -- `duplex` is required by undici for a streaming body
  new Request("http://peer/sink", { method: "POST", body, duplex: "half" }),
);
const out = (await res.json()) as { received: number };
const finishedAt = Date.now();

const totalBytes = CHUNKS * CHUNK_BYTES;
const complete = out.received === totalBytes;
const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
const produceMs = lastPullAt - started;
const totalMs = finishedAt - started;

console.log(`streamed          : ${CHUNKS} x ${CHUNK_BYTES / 1024} KiB = ${mib(totalBytes)} MiB`);
console.log(`server received   : ${mib(out.received)} MiB  ${complete ? "\x1b[32mcomplete\x1b[0m" : "\x1b[31mTRUNCATED\x1b[0m"}`);
console.log(`producer finished : ${produceMs} ms after start`);
console.log(`response arrived  : ${totalMs} ms after start`);

// The discriminator. The producer is an in-memory generator with no delay of
// its own -- the ONLY thing that can slow it down is the transport refusing
// to accept more. So:
//   backpressure honoured -> the producer is throttled and finishes close to
//                            the response, i.e. it spent the transfer waiting
//   backpressure ignored  -> the producer races to completion in a few ms and
//                            the response arrives much later, i.e. everything
//                            it produced went straight into a buffer
// RSS is deliberately NOT used here: 125 MiB of sent chunks become garbage,
// so resident memory grows either way and proves nothing.
const ratio = totalMs === 0 ? 1 : produceMs / totalMs;
const paced = ratio > 0.5;
console.log(
  `\nproducer spent ${(ratio * 100).toFixed(0)}% of the transfer window still producing -> ` +
    (paced
      ? "\x1b[32mthrottled by the transport: backpressure is real\x1b[0m"
      : "\x1b[31mraced ahead of the consumer: output was being buffered\x1b[0m"),
);
console.log(
  "\nThe byte-level proof lives in the package's own test:\n" +
    "  webrun-streams-libp2p/tests/backpressure.test.ts samples stream.writeBufferLength\n" +
    "  directly and asserts it stays bounded (0 B with the fix, ~36 KB without).",
);

await close();
await stopServing();
await stop();
process.exit(complete && paced ? 0 : 1);
