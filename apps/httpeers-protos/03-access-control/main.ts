/**
 * 03 — Deny by default, granted by role, bound to the proven peer.
 *
 * The design decision this demonstrates: the unit of access is not
 * "peerId X may reach resource Y" but "any member holding role R may reach
 * this resource". A provider therefore needs no per-peer table — only a
 * policy, and the identity the handshake proved.
 *
 * The load-bearing property is that the role lookup is keyed by
 * `context.remotePeer`, which the caller cannot influence. A request that
 * *claims* a role in a header gets nothing.
 */
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createNode, heading, short } from "../lib/nodes.ts";

heading("03 — access control keyed to the proven peer, deny by default");

const server = await createNode(true);
const alice = await createNode(false);
const mallory = await createNode(false);
const addr = server.getMultiaddrs()[0];
if (addr == null) throw new Error("server has no listen address");

// The provider's whole state: a policy, and who holds which role. No per-peer
// capability table, no session store.
const roles = new Map<string, string[]>([[alice.peerId.toString(), ["std:reader"]]]);
const policy: Record<string, string[]> = {
  "/public": [],                 // no role required
  "/reports": ["std:reader"],    // reader or better
  "/admin": ["std:admin"],       // nobody here holds this
};

const stopServing = await serveConnections({ node: server }, (context) =>
  serveFetchOverDuplex(async (request) => {
    const path = new URL(request.url).pathname;
    const required = policy[path];
    if (required === undefined) return new Response("not found", { status: 404 });

    // Roles come from the PROVEN id. The header below is attacker-controlled
    // and is read only to show that it is ignored.
    const held = roles.get(context.remotePeer.toString()) ?? [];
    const claimed = request.headers.get("x-i-am-admin");

    if (required.length > 0 && !required.some((r) => held.includes(r))) {
      return Response.json(
        { path, allowed: false, held, required, claimedHeader: claimed },
        { status: 403 },
      );
    }
    return Response.json({ path, allowed: true, held, required, claimedHeader: claimed });
  }),
);

async function attempt(who: string, node: Awaited<ReturnType<typeof createNode>>, path: string, forge = false) {
  const { call, close } = await connect({ node, peer: addr });
  const res = await fetchOverDuplex(
    call,
    new Request(`http://peer${path}`, { headers: forge ? { "x-i-am-admin": "true" } : {} }),
  );
  const body = (await res.json()) as { held: string[]; claimedHeader: string | null };
  const mark = res.status === 200 ? "\x1b[32mallow\x1b[0m" : "\x1b[31mdeny \x1b[0m";
  console.log(
    `  ${mark} ${res.status}  ${who.padEnd(8)} ${path.padEnd(9)} roles=${JSON.stringify(body.held).padEnd(14)}` +
      (forge ? ` forged-header=${body.claimedHeader}` : ""),
  );
  await close();
  return res.status;
}

console.log(`alice   = ${short(alice.peerId.toString())}  (holds std:reader)`);
console.log(`mallory = ${short(mallory.peerId.toString())}  (holds nothing)\n`);

const results = [
  await attempt("alice", alice, "/public"),
  await attempt("alice", alice, "/reports"),
  await attempt("alice", alice, "/admin"),
  await attempt("mallory", mallory, "/public"),
  await attempt("mallory", mallory, "/reports"),
  await attempt("mallory", mallory, "/admin", true),
];

const expected = [200, 200, 403, 200, 403, 403];
const ok = results.every((r, i) => r === expected[i]);
console.log(
  ok
    ? "\n\x1b[32m✓ deny-by-default held; the forged header changed nothing\x1b[0m"
    : `\n\x1b[31m✗ expected ${expected.join(",")} got ${results.join(",")}\x1b[0m`,
);

await stopServing();
await Promise.allSettled([server.stop(), alice.stop(), mallory.stop()]);
process.exit(ok ? 0 : 1);
