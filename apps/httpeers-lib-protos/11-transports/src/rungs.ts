/**
 * The three rungs. Each takes the site and returns a `Caller`; the site is
 * byte-identical between them, and so is every scenario.
 *
 * What is swapped, rung by rung, is exactly one thing:
 *
 *   1. DIRECT      — nothing. `serveFetchOverDuplex` and `fetchOverDuplex`
 *                    talk to each other with no transport at all. The
 *                    `Duplex` contract blesses `call === handler`.
 *   2. MESSAGEPORT — the `Duplex`, from `@statewalker/webrun-rpc`'s port
 *                    `connect`/`serve` over one `MessageChannel`. This is the
 *                    rung the directive asks for: HTTP tunnelled over a port.
 *   3. LIBP2P      — the same, with `@statewalker/webrun-streams-libp2p`'s
 *                    `connect`/`serve` pair. Only the Connect/Serve changes.
 *
 * Both packages are consumed UNPUBLISHED from the sibling webrun-wire
 * worktree, linked in, so a defect found here can be fixed at its source.
 */

import type { Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { fetchOverDuplex, serveFetchOverDuplex } from "@statewalker/webrun-http-streams";
import { connect as connectPort, serve as servePort } from "@statewalker/webrun-rpc";
import { connect as connectLibp2p, serveConnections } from "@statewalker/webrun-streams-libp2p";
import type { Caller } from "./scenarios.js";

export type Handler = (request: Request) => Promise<Response>;

export interface Rung {
  call: Caller;
  stop(): Promise<void>;
}

/** RUNG 1 — no transport. The serving duplex IS the calling duplex. */
export function directRung(handler: Handler): Rung {
  const duplex = serveFetchOverDuplex(handler);
  return {
    call: (request) => fetchOverDuplex(duplex, request),
    stop: async () => undefined,
  };
}

/** RUNG 2 — one `MessageChannel`: the server holds one end, the caller the other. */
export async function portRung(handler: Handler): Promise<Rung> {
  const channel = new MessageChannel();
  const stopServing = await servePort({ port: channel.port2 }, serveFetchOverDuplex(handler));
  const client = await connectPort({ port: channel.port1 });

  return {
    call: (request) => fetchOverDuplex(client.call, request),
    async stop() {
      await client.close();
      await stopServing();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

export const P2P_PROTOCOL = "/httpeers-site/1.0.0";

export interface Libp2pRungInit {
  server: Libp2p;
  client: Libp2p;
  /** Told which peer libp2p proved, per inbound stream — the one real identity seam. */
  onCaller?: (peerId: string) => void;
}

/** RUNG 3 — the same site over libp2p, with the proven peer available to the site. */
export async function libp2pRung(handler: Handler, init: Libp2pRungInit): Promise<Rung> {
  const stopServing = await serveConnections(
    { node: init.server, protocol: P2P_PROTOCOL, maxInboundStreams: 512, drainTimeoutMs: 15_000 },
    (context) => {
      // IDENTITY BY CLOSURE, once per inbound stream. This is the only place
      // in the whole ladder where the caller is PROVEN rather than claimed.
      init.onCaller?.(context.remotePeer.toString());
      return serveFetchOverDuplex(handler);
    },
  );

  const connection = await connectLibp2p({
    node: init.client,
    peer: peerIdFromString(init.server.peerId.toString()),
    protocol: P2P_PROTOCOL,
    maxOutboundStreams: 512,
  });

  return {
    call: (request) => fetchOverDuplex(connection.call, request),
    async stop() {
      await connection.close();
      await stopServing();
    },
  };
}
