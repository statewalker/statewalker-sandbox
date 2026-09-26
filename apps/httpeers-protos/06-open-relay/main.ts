/**
 * 06 — The open relay, and closing it.
 *
 * A real defect found by review, not by tests. The router forwards requests
 * addressed to other peers. Access was enforced only on the *local* branch,
 * so any peer could ask any other peer to forward on its behalf — an open
 * relay. It stayed invisible because the far end still refused the request:
 * the caller saw a sensible 403 and never learned that a stranger's node had
 * done the dialling.
 *
 * Two nodes, real libp2p. Mallory asks the server to forward to a third peer.
 * The fix is deny-by-default forwarding with an explicit policy hook.
 */
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createPair, heading, short } from "../lib/nodes.ts";
import { createRouter } from "../lib/router.ts";

heading("06 — a peer refuses to be used as an open relay");

const { server, client, serverAddr, stop } = await createPair();
const selfId = server.peerId.toString();
const stranger = "12D3KooWSomeThirdPartyPeerThatWeShouldNotDialFor";

let forwardsAttempted = 0;

// Trusted peers may ask us to forward; nobody else may. In the broken version
// this hook did not exist and the forwarding branch ran unconditionally.
const trustedToForward = new Set<string>(); // deliberately empty

const stopServing = await serveConnections({ node: server }, (context) => {
  const route = createRouter({
    selfPeerId: selfId,
    mounts: [{ prefix: "/", handler: async () => Response.json({ served: "locally" }) }],
    allowForward: async (_req, _target, from) => trustedToForward.has(from),
    remote: async (peerId) => {
      // Reached only if policy allows. Counting proves whether it ever was.
      forwardsAttempted += 1;
      return Response.json({ forwardedTo: peerId });
    },
  });
  return serveFetchOverDuplex((request) => route(request, context.remotePeer.toString()));
});

const { call, close } = await connect({ node: client, peer: serverAddr });

console.log(`client (mallory) : ${short(client.peerId.toString())}`);
console.log(`server           : ${short(selfId)}`);
console.log(`trusted-to-forward set: ${trustedToForward.size === 0 ? "(empty)" : "…"}\n`);

// 1. A request addressed to the server itself — legitimate, should work.
const local = await fetchOverDuplex(call, new Request(`http://peer/${selfId}/anything`));
console.log(
  `GET /{server}/anything        -> ${local.status} ${JSON.stringify(await local.json())}`,
);

// 2. A request addressed to a third party — the open-relay attempt.
const relayed = await fetchOverDuplex(call, new Request(`http://peer/${stranger}/secret`));
const relayedBody = (await relayed.json()) as { error?: string; from?: string };
console.log(`GET /{stranger}/secret        -> ${relayed.status} ${JSON.stringify(relayedBody)}`);

const refused = relayed.status === 403;
const neverDialled = forwardsAttempted === 0;

console.log(`\nforward attempts reaching the dial path: ${forwardsAttempted}`);
console.log(
  refused && neverDialled
    ? "\n\x1b[32m✓ refused by policy, and the node never dialled on a stranger's behalf\x1b[0m"
    : "\n\x1b[31m✗ the node acted as an open relay\x1b[0m",
);

await close();
await stopServing();
await stop();
process.exit(refused && neverDialled ? 0 : 1);
