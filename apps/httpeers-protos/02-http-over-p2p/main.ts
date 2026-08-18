/**
 * 02 — Ordinary HTTP semantics over a libp2p stream.
 *
 * This is the layer `@libp2p/http` was supposed to provide and could not: it
 * never concatenated the query string, and a `return source` instead of
 * `yield*` made streamed request bodies arrive empty. Both defects were
 * silent — the request "succeeded" and simply lost data.
 *
 * The two checks below are exactly those two defects.
 */
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createPair, heading } from "../lib/nodes.ts";

heading("02 — HTTP over libp2p: query strings and streamed bodies");

const { serverAddr, client, server, stop } = await createPair();

const stopServing = await serveConnections({ node: server }, () =>
  serveFetchOverDuplex(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/echo-query") {
      return Response.json({ query: Object.fromEntries(url.searchParams) });
    }
    if (url.pathname === "/echo-body") {
      const chunks: string[] = [];
      const reader = request.body?.getReader();
      if (reader != null) {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(dec.decode(value, { stream: true }));
        }
      }
      return Response.json({ received: chunks, count: chunks.length });
    }
    return new Response("not found", { status: 404 });
  }),
);

const { call, close } = await connect({ node: client, peer: serverAddr });

// --- defect 1: the query string used to be dropped entirely -----------------
const q = await fetchOverDuplex(
  call,
  new Request("http://peer/echo-query?group=alpha&limit=7"),
);
const qBody = (await q.json()) as { query: Record<string, string> };
const queryOk = qBody.query.group === "alpha" && qBody.query.limit === "7";
console.log(`GET  /echo-query?group=alpha&limit=7`);
console.log(`  server saw: ${JSON.stringify(qBody.query)}  ${queryOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ dropped\x1b[0m"}`);

// --- defect 2: streamed request bodies used to arrive empty -----------------
const stream = new ReadableStream<Uint8Array>({
  async start(controller) {
    const enc = new TextEncoder();
    for (const part of ["alpha ", "beta ", "gamma"]) {
      controller.enqueue(enc.encode(part));
      await new Promise((r) => setTimeout(r, 40));
    }
    controller.close();
  },
});
const b = await fetchOverDuplex(
  call,
  new Request("http://peer/echo-body", {
    method: "POST",
    body: stream,
    // @ts-expect-error -- `duplex` is required by undici for a streaming body
    duplex: "half",
  }),
);
const bBody = (await b.json()) as { received: string[]; count: number };
const joined = bBody.received.join("");
const bodyOk = joined === "alpha beta gamma";
console.log(`\nPOST /echo-body  (3 chunks, 40ms apart, streamed)`);
console.log(`  server received: ${JSON.stringify(joined)} in ${bBody.count} chunk(s)  ${bodyOk ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗ empty\x1b[0m"}`);

const ok = queryOk && bodyOk;
console.log(
  ok
    ? "\n\x1b[32m✓ both @libp2p/http defects are absent from this stack\x1b[0m"
    : "\n\x1b[31m✗ a defect reproduced\x1b[0m",
);

await close();
await stopServing();
await stop();
process.exit(ok ? 0 : 1);
