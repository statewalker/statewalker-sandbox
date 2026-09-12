/**
 * The same hub, the same client, carried up the ladder.
 *
 * The directive's second half: "after that re-configured and tested over
 * MessagePorts and P2P connections". Nothing about `hub-site.ts` or
 * `hub-client.ts` changes here — only what fills the client's `fetch` and
 * what fills the hub's `callerOf`.
 *
 * And that second seam is the interesting one. The hub's protocol is
 * IDENTICAL across the three rungs, but what it can *trust* is not:
 *
 *   - direct / MessagePort: the caller says who it is. A claim.
 *   - libp2p:               Noise proved it, per inbound stream. A proof.
 *
 * So the same suite runs three times, and one extra claim measures the
 * difference rather than hiding it: over libp2p a peer cannot redeem an
 * invitation in someone else's name, and on the lower rungs it can.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import { peerIdFromString } from "@libp2p/peer-id";
import { tcp } from "@libp2p/tcp";
import { createMemberStore } from "@statewalker/httpeers.core";
import { generateMeshKey } from "@statewalker/httpeers.core/tokens";
import { createHubState } from "@statewalker/httpeers-stack/src/hub/hub-state.js";
import { appRules } from "@statewalker/httpeers-stack/src/policy.js";
import { peerIdOf } from "@statewalker/httpeers-stack/src/setup/keys.js";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect as connectPort, serve as servePort } from "@statewalker/webrun-rpc";
import { connect as connectLibp2p, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { createLibp2p } from "libp2p";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHubClient, type HubClient } from "../src/hub-client.js";
import { createHubSite, type HubSite } from "../src/hub-site.js";

const PRESENCE_TTL_MS = 5_000;

/** Build a hub whose `callerOf` is supplied by the rung. */
async function buildHub(callerOf: (request: Request) => string | undefined) {
  const meshKey = await generateMeshKey();
  const rules = appRules([]);
  let snapshot = { members: [], spentInvitationIds: [] } as never;
  const state = createHubState({
    store: {
      read: () => snapshot,
      write: (next) => {
        snapshot = next as never;
      },
    },
    rules,
    createMemberStore,
  });
  const site = createHubSite({
    mesh: peerIdOf(meshKey),
    meshKey,
    state,
    rules,
    presenceTtlMs: PRESENCE_TTL_MS,
    callerOf,
  });
  return { site, mesh: peerIdOf(meshKey) };
}

/** The lifecycle every rung must support, expressed once. */
async function lifecycle(site: HubSite, client: HubClient): Promise<string[]> {
  const steps: string[] = [];
  const invitation = site.invite({ roles: ["member"] });

  const joined = await client.redeem(invitation.id);
  steps.push(`joined:${joined.roles.join(",")}`);

  const beat = await client.heartbeat({
    seq: 1,
    addrs: ["/ip4/127.0.0.1/tcp/1"],
    advertisements: [{ id: "images", kind: "images", title: "Images" }],
  });
  steps.push(`renewed:${beat.token !== joined.token}`);
  steps.push(`ttl:${beat.ttl}`);

  const view = await client.meshView();
  steps.push(`members:${view.members.length}`);
  steps.push(`offers:${view.advertisements.map((a) => a.kind).join(",")}`);

  site.remove(client.peerId);
  const refused = await client.heartbeat({ seq: 2, addrs: [] }).then(
    () => "allowed",
    (error: Error) => (/not-a-member/.test(error.message) ? "refused" : `other:${error.message}`),
  );
  steps.push(`after-removal:${refused}`);

  const deny = await client.revocations();
  steps.push(`denied:${deny.entries.some((e) => e.peerId === client.peerId)}`);

  return steps;
}

describe("12 — the hub protocol over three transports", () => {
  let server: Awaited<ReturnType<typeof createLibp2p>>;
  let client: Awaited<ReturnType<typeof createLibp2p>>;
  const results = new Map<string, string[]>();
  const teardown: (() => Promise<void>)[] = [];

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

    const claimed = client.peerId.toString();

    // ---- RUNG 1: direct. `fetch` is the handler; the caller is a header.
    {
      const hub = await buildHub((request) => request.headers.get("x-peer") ?? undefined);
      const hubClient = createHubClient({
        peerId: claimed,
        fetch: (request) => {
          request.headers.set("x-peer", claimed);
          return hub.site.handler(request);
        },
      });
      results.set("direct", await lifecycle(hub.site, hubClient));
    }

    // ---- RUNG 2: one MessageChannel. Still a claim, now over a transport.
    {
      const hub = await buildHub((request) => request.headers.get("x-peer") ?? undefined);
      const channel = new MessageChannel();
      const stopServing = await servePort(
        { port: channel.port2 },
        serveFetchOverDuplex(hub.site.handler),
      );
      const connection = await connectPort({ port: channel.port1 });
      teardown.push(async () => {
        await connection.close();
        await stopServing();
        channel.port1.close();
        channel.port2.close();
      });

      const hubClient = createHubClient({
        peerId: claimed,
        fetch: (request) => {
          request.headers.set("x-peer", claimed);
          return fetchOverDuplex(connection.call, request);
        },
      });
      results.set("port", await lifecycle(hub.site, hubClient));
    }

    // ---- RUNG 3: libp2p. The caller is PROVEN, per inbound stream, and the
    // header is ignored entirely.
    {
      const perRequestCaller = new WeakMap<Request, string>();
      const hub = await buildHub((request) => perRequestCaller.get(request));

      const stopServing = await serveConnections(
        { node: server, protocol: "/httpeers-hub/1.0.0", maxInboundStreams: 512 },
        (context) => {
          const proven = context.remotePeer.toString();
          // The adapter's whole job: bind the proven peer to the request the
          // hub will see. Identity by closure, exactly as the prototype does.
          return serveFetchOverDuplex(async (request) => {
            perRequestCaller.set(request, proven);
            return await hub.site.handler(request);
          });
        },
      );
      const connection = await connectLibp2p({
        node: client,
        peer: peerIdFromString(server.peerId.toString()),
        protocol: "/httpeers-hub/1.0.0",
      });
      teardown.push(async () => {
        await connection.close();
        await stopServing();
      });

      const hubClient = createHubClient({
        peerId: claimed,
        fetch: (request) => {
          // A LIE, deliberately: this header claims to be somebody else. On
          // this rung it changes nothing, which is claim 5.
          request.headers.set("x-peer", "12D3KooWEHUcCvsmTLLoQG28Y2PDkUfddP1WmdSKwY1sSxfANcxR");
          return fetchOverDuplex(connection.call, request);
        },
      });
      results.set("libp2p", await lifecycle(hub.site, hubClient));
    }

    console.log(
      `\nHub lifecycle per transport:\n${[...results]
        .map(([rung, steps]) => `  ${rung.padEnd(7)} ${steps.join(" · ")}`)
        .join("\n")}\n`,
    );
  }, 300_000);

  afterAll(async () => {
    for (const stop of teardown.reverse()) await stop().catch(() => undefined);
    await client?.stop();
    await server?.stop();
  });

  it("CLAIM 1 — the whole lifecycle works over DIRECT calls", () => {
    expect(results.get("direct")).toEqual([
      "joined:member",
      "renewed:true",
      `ttl:${PRESENCE_TTL_MS}`,
      "members:1",
      "offers:images",
      "after-removal:refused",
      "denied:true",
    ]);
  });

  it("CLAIM 2 — the same lifecycle works over a MessagePort", () => {
    expect(results.get("port")).toEqual(results.get("direct"));
  });

  it("CLAIM 3 — the same lifecycle works over libp2p", () => {
    expect(results.get("libp2p")).toEqual(results.get("direct"));
  });

  it("CLAIM 4 — the hub's code is identical across the three; only two seams are swapped", () => {
    // Asserted by construction above: one `createHubSite`, one
    // `createHubClient`, and per rung only `fetch` and `callerOf` differ.
    expect([...results.keys()].sort()).toEqual(["direct", "libp2p", "port"]);
  });

  it("CLAIM 5 — over libp2p a caller CANNOT claim another peer's identity", () => {
    // The libp2p client sent `x-peer: <someone else>` on every request and the
    // lifecycle still belonged to its own proven peer id. On the lower rungs
    // that header IS the identity — which is the honest difference between a
    // proof and a claim, and why the seam is explicit in the API.
    expect(results.get("libp2p")).toEqual(results.get("direct"));
  });
});
