/**
 * The same cycle the browser test performs, driven by two Node peers over a
 * relay this script starts itself.
 *
 * WHY THIS EXISTS ALONGSIDE THE BROWSER TEST. `src/mesh.ts` and
 * `src/hub.ts` are the same files in both, so this run answers "is the
 * hub/join/resource logic correct" without a browser, a public relay or
 * WebRTC in the picture. When the browser test then fails, the difference
 * is narrowed to the browser runtime, the relay, or ICE — which is the
 * whole reason to have two harnesses rather than one.
 *
 * It runs entirely on loopback and needs no network access:
 *
 *   npm run verify:node
 *
 * STATUS 7 September 2026: all thirteen claims pass.
 */

import { createServer } from "node:http";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";

import { guestHandler, hubHandler, joinMesh, mintInvitation, newHubState } from "../dist-node/hub.js";
import { startPeer } from "../dist-node/mesh.js";
import { resolveRelayAddrs } from "../dist-node/relay-discovery.js";

const RELAY_PORT = 9590;
const BOOTSTRAP_PORT = 9592;

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function startLocalRelay() {
  const node = await createLibp2p({
    addresses: { listen: [`/ip4/127.0.0.1/tcp/${RELAY_PORT}/ws`] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      // The library's per-connection defaults are 2 minutes and 128 KiB, and
      // when either is reached the relay CLOSES the relayed connection. These
      // limits match what the deployed relay sets in `apps/relay/src/limits.ts`.
      // NOTE: raising them does NOT eliminate the five-call ceiling — that was
      // reproduced with 50 MB and 10 minutes and plenty of budget remaining.
      relay: circuitRelayServer({
        reservations: {
          maxReservations: 512,
          defaultDurationLimit: 5 * 60 * 1000,
          defaultDataLimit: BigInt(1024 * 1024),
        },
      }),
    },
  });
  const addr = node.getMultiaddrs().map(String).find((a) => a.includes("/ws"));
  return { node, addr };
}

/**
 * Serves the same bootstrap document the deployed relay publishes, so the
 * discovery path is exercised for real rather than merely typechecked.
 *
 * `/.well-known/httpeers-relay.json` with `{ relayAddrs: [...] }`, and the
 * `Access-Control-Allow-Origin: *` the real deployment sets — without which
 * curl keeps working and every browser peer stops.
 *
 * ONE PORT PER FIXTURE, NOT ONE PATH PER FIXTURE. The document path is
 * absolute, so `new URL("/.well-known/…", base)` resolves from the ORIGIN and
 * discards any path prefix in the configured URL. A first attempt at these
 * fixtures used `${url}/unpinnable/` and all three silently hit the happy
 * path. That is correct behaviour — the real relay serves the document at its
 * origin root — but it means a prefix cannot distinguish fixtures, and it is
 * worth knowing that configuring a relay URL with a path silently ignores it.
 */
function startBootstrapServer(port, body) {
  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    if (req.url !== "/.well-known/httpeers-relay.json") {
      res.writeHead(404).end(JSON.stringify({ error: "not-found" }));
      return;
    }
    if (body == null) {
      // The relay clears its document rather than leaving a stale one, so a
      // 404 here means "the relay is down", not "wrong URL".
      res.writeHead(404).end(JSON.stringify({ error: "not-found" }));
      return;
    }
    res.end(JSON.stringify(body, null, 2));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function main() {
  console.log("\nhttpeers browser-mesh logic, verified with Node peers\n");

  const relay = await startLocalRelay();
  const relayUrl = `http://127.0.0.1:${BOOTSTRAP_PORT}`;
  const servers = [
    await startBootstrapServer(BOOTSTRAP_PORT, { relayAddrs: [relay.addr] }),
    // The same address with its /p2p/ stripped: dialable, and authenticating
    // nothing.
    await startBootstrapServer(BOOTSTRAP_PORT + 1, {
      relayAddrs: [relay.addr.split("/p2p/")[0]],
    }),
    await startBootstrapServer(BOOTSTRAP_PORT + 2, { relayAddrs: [] }),
    await startBootstrapServer(BOOTSTRAP_PORT + 3, null),
  ];
  console.log(`  relay: ${relay.addr}`);
  console.log(`  bootstrap document: ${relayUrl}/.well-known/httpeers-relay.json\n`);

  // --- the relay is found from its URL alone ---------------------------
  const discovered = await resolveRelayAddrs(relayUrl);
  check(
    "the relay's addresses are discovered from its URL",
    discovered.length === 1 && discovered[0] === relay.addr,
    discovered.join(", "),
  );

  let unpinnable = "no error";
  try {
    await resolveRelayAddrs(`http://127.0.0.1:${BOOTSTRAP_PORT + 1}`);
  } catch (err) {
    unpinnable = err.message;
  }
  check(
    "a published address with no peer id is refused",
    unpinnable.includes("exactly one is required"),
    unpinnable.slice(0, 70),
  );

  let empty = "no error";
  try {
    await resolveRelayAddrs(`http://127.0.0.1:${BOOTSTRAP_PORT + 2}`);
  } catch (err) {
    empty = err.message;
  }
  check("a document listing no addresses is refused", empty.includes("lists no addresses"));

  let missing = "no error";
  try {
    await resolveRelayAddrs(`http://127.0.0.1:${BOOTSTRAP_PORT + 3}`);
  } catch (err) {
    missing = err.message;
  }
  check("a missing document reports the relay is down", missing.includes("404"));

  // --- one peer declares itself a hub ---------------------------------
  const hubState = newHubState();
  const hub = await startPeer({
    relay: relayUrl,
    transports: [webSockets()],
    handler: hubHandler(hubState, "hub-tab"),
  });
  check("hub peer obtained a reservation", hub.address.includes("/p2p-circuit"), hub.address);

  const invitationId = mintInvitation(hubState);

  // --- another peer joins ----------------------------------------------
  const guest = await startPeer({
    relay: relayUrl,
    transports: [webSockets()],
    handler: guestHandler("guest-tab"),
  });
  check("guest peer obtained a reservation", guest.address.includes("/p2p-circuit"), guest.address);

  // Refusal BEFORE joining, using the guest itself rather than a third
  // peer: it tests the same gate (membership, keyed on the proven peer id)
  // while reusing a connection that already exists, and it establishes the
  // "before" half of a before/after pair rather than a standalone claim.
  //
  // A third peer was tried first and made the run flaky — every extra node
  // is another circuit through the same relay, which is how the five-call
  // ceiling was found.
  const beforeJoin = await guest.fetch(hub.address, new Request("http://hub/hello"));
  check("a peer that has not joined is refused", beforeJoin.status === 403, `status ${beforeJoin.status}`);

  const blob = { relay: relayUrl, hubAddress: hub.address, invitationId };
  const joined = await joinMesh(guest, blob, { kind: "echo", path: "/echo" });
  check("guest redeemed the invitation", joined.hub === "hub-tab");
  check(
    "membership recorded against the PROVEN peer id",
    hubState.members.has(guest.peerId),
    guest.peerId,
  );

  // --- the invitation is single-use ------------------------------------
  let secondUse = "no error";
  try {
    await joinMesh(guest, blob, { kind: "echo", path: "/echo" });
  } catch (err) {
    secondUse = err.message;
  }
  check("a redeemed invitation cannot be reused", secondUse.includes("already-redeemed"), secondUse);

  // --- the guest USES a resource the hub provides ----------------------
  const helloRes = await guest.fetch(hub.address, new Request("http://hub/hello"));
  const hello = await helloRes.json();
  check("guest consumed the hub's resource", hello.from === "hub-tab", JSON.stringify(hello));

  // --- the hub discovers what the guest PROVIDES, and uses it ----------
  const meshRes = await guest.fetch(hub.address, new Request("http://hub/.well-known/mesh"));
  const mesh = await meshRes.json();
  const ad = mesh.advertisements.find((a) => a.peerId === guest.peerId);
  check("guest's advertisement is visible in the mesh view", ad != null && ad.kind === "echo");

  // The reverse direction, and the claim that matters most: a guest that
  // could only consume would be a client, and this architecture has none.
  const echoRes = await hub.fetch(
    ad.address,
    new Request("http://guest/echo", {
      method: "POST",
      body: JSON.stringify({ message: "resources flow both ways" }),
    }),
  );
  const echo = await echoRes.json();
  check(
    "hub consumed the guest's resource",
    echo.echoed === "resources flow both ways" && echo.caller === hub.peerId,
    JSON.stringify(echo),
  );

  await guest.stop();
  await hub.stop();
  await relay.node.stop();
  for (const server of servers) await new Promise((r) => server.close(() => r()));
}

main()
  .catch((err) => {
    console.error("\n  ERROR:", err.stack ?? err.message);
    failures++;
  })
  .finally(() => {
    console.log(`\n${failures === 0 ? "all claims hold" : `${failures} claim(s) failed`}\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
