/**
 * 01 — Identity survives by closure.
 *
 * The serving side learns which peer libp2p's Noise handshake PROVED for the
 * connection, without the caller telling it anything. This is the gap that
 * blocked the whole identity model: the stock adapter destructured only
 * `{ stream }` from libp2p's handler and threw the connection away one line
 * before the handler ran, so nobody could know who was calling.
 *
 * `serveConnections` builds the handler per inbound stream, so the connection
 * lives in that handler's closure. `Duplex` stays bytes-only — it gains no
 * parameter (ADR-0004).
 */
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createPair, heading, short } from "../lib/nodes.ts";

heading("01 — the server learns who is calling, from the handshake");

const { server, client, serverAddr, stop } = await createPair();

const stopServing = await serveConnections({ node: server }, (context) =>
  serveFetchOverDuplex(async (request) => {
    // `context.remotePeer` is the id Noise proved. Nothing in the request can
    // change it: the caller never sends it.
    const claimed = new URL(request.url).searchParams.get("iam") ?? "(none)";
    return Response.json({
      proven: context.remotePeer.toString(),
      claimedByCaller: claimed,
      match: context.remotePeer.toString() === client.peerId.toString(),
    });
  }),
);

const { call, close } = await connect({ node: client, peer: serverAddr });

// The caller lies about who it is. The server ignores the claim entirely.
const res = await fetchOverDuplex(
  call,
  new Request("http://peer/whoami?iam=definitely-someone-else"),
);
const body = (await res.json()) as { proven: string; claimedByCaller: string; match: boolean };

console.log(`client's real peer id : ${short(client.peerId.toString())}`);
console.log(`caller claimed to be  : ${body.claimedByCaller}`);
console.log(`server proved         : ${short(body.proven)}`);
console.log(
  `\nHTTP ${res.status} · proven id matches the real client: ${body.match ? "YES" : "NO"}`,
);
console.log(
  body.match
    ? "\n\x1b[32m✓ the forged claim was ignored; identity came from the handshake\x1b[0m"
    : "\n\x1b[31m✗ identity did not match\x1b[0m",
);

await close();
await stopServing();
await stop();
process.exit(body.match ? 0 : 1);
