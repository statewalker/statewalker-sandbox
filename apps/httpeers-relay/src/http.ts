/**
 * The relay's two-route HTTP surface: a liveness probe, and the address a
 * downstream milestone reads instead of copying one that goes stale.
 *
 * ON A SECOND PORT, WHICH IS SETTLED RATHER THAN PREFERRED. Sharing the
 * WebSocket listener's port is not available in this stack:
 * `WebSocketListenerInit` declares `server?: Server`, but the public
 * `webSockets()` options expose only `http`/`https` *ServerOptions* and the
 * listener calls `net.createServer` itself. Behind the reverse proxy this
 * deployment already uses (decision 3) it costs nothing publicly -- two
 * container ports, one public port, routed by path.
 *
 * WHY THE DOCUMENT IS A CALLBACK AND NOT A VALUE. Its whole purpose is that
 * CI and the acceptance check read the relay's real address rather than a
 * string somebody pasted; a snapshot taken at boot would be a second copy with
 * the same failure mode one layer down. `startRelay` passes a closure over the
 * live node, so every request reports what libp2p advertises at that moment.
 *
 * NO APPLICATION CODE HERE EITHER. This serves two fixed routes and 404s
 * everything else. It is not a place to add an admin API, a metrics scrape or
 * a peer list -- a relay holds no directory (see `./relay.ts`), and an HTTP
 * surface is exactly where someone would be tempted to invent one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { RelayMode } from "./config.js";

/** The path a container platform probes. */
export const HEALTH_PATH = "/health";

/**
 * Where the relay publishes itself. A `.well-known` path because that is what
 * the convention is for: a location a client can construct from an origin
 * alone, with nothing to configure.
 */
export const DISCOVERY_PATH = "/.well-known/httpeers-relay.json";

/**
 * What a peer needs to dial this relay, generated from what it actually
 * loaded and bound.
 *
 * THE POINT IS THAT IT CANNOT GO STALE. A hand-maintained file goes wrong
 * exactly when the key changes, which is the moment it matters most; this is
 * derived from the running node every time it is asked.
 */
export interface RelayDiscoveryDocument {
  /** The relay's peerId -- the value an operator checks did not change across a deploy. */
  peerId: string;
  /** What libp2p advertises right now: the announce addresses when there are any, the listen addresses otherwise. */
  addrs: string[];
  /** `open` or `registered` -- see `./config.ts`. Published so a peer can tell why it might be refused. */
  mode: RelayMode;
}

export interface RelayHttpInit {
  /** `0` binds an arbitrary free port. See `./config.ts`'s `RELAY_HTTP_PORT`. */
  port: number;
  /** Defaults to `0.0.0.0` -- a container platform probes from outside the process. */
  host?: string;
  /** Read per request, never snapshotted. See the module comment. */
  document: () => RelayDiscoveryDocument;
}

export interface RelayHttp {
  /** The port actually bound, which is what a caller passing `0` needs to learn. */
  port: number;
  stop: () => Promise<void>;
}

/**
 * `HEAD` GETS THE SAME STATUS AND HEADERS AND NO BODY (RFC 9110). A resource
 * that answers GET answers HEAD, and probes and load balancers use it -- an
 * earlier version of this file answered 405, which reads to such a probe as a
 * failing health check. `content-length` still describes the body a GET would
 * have returned, which is what makes the two responses comparable.
 */
function sendJson(res: ServerResponse, status: number, body: unknown, method?: string): void {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // Nothing here may be cached: the discovery document exists to be current,
    // and a proxy holding yesterday's copy would reintroduce the stale address
    // this endpoint was built to remove.
    "cache-control": "no-store",
  });
  res.end(method === "HEAD" ? undefined : text);
}

function handle(req: IncomingMessage, res: ServerResponse, init: RelayHttpInit): void {
  // Path only. A query string is not part of either route, and `new URL`
  // against a fixed base is how the path is extracted without a dependency.
  const path = new URL(req.url ?? "/", "http://relay.invalid").pathname;
  const method = req.method ?? "GET";

  if (path !== HEALTH_PATH && path !== DISCOVERY_PATH) {
    sendJson(res, 404, { error: "not found", paths: [HEALTH_PATH, DISCOVERY_PATH] }, method);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    // `Allow` is not decoration -- 405 without it is a refusal that does not
    // say what would have worked.
    res.setHeader("allow", "GET, HEAD");
    sendJson(res, 405, { error: "method not allowed", allow: "GET, HEAD", path }, method);
    return;
  }

  if (path === HEALTH_PATH) {
    sendJson(res, 200, { status: "ok" }, method);
    return;
  }

  sendJson(res, 200, init.document(), method);
}

/**
 * Start the HTTP surface. Resolves once the port is bound, so a caller that
 * passed `0` can read the port it got.
 */
export async function startRelayHttp(init: RelayHttpInit): Promise<RelayHttp> {
  const server: Server = createServer((req, res) => {
    try {
      handle(req, res, init);
    } catch (err) {
      // A throw from `document()` -- a node stopped underneath us, say -- must
      // not take the process down with an unhandled error inside a request.
      sendJson(
        res,
        500,
        { error: `relay: could not answer this request: ${String(err)}` },
        req.method,
      );
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once("error", onError);
    server.listen(init.port, init.host ?? "0.0.0.0", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address != null ? address.port : init.port;

  return {
    port,
    async stop() {
      // `closeAllConnections` FIRST, then `close`. `close` alone stops
      // accepting and then waits for existing connections to end, and a
      // keep-alive probe from a container platform can hold one open for a
      // minute -- so a relay asked to stop would keep its port for as long as
      // whatever was polling it felt like. `tests/http.test.ts` proves the
      // port is released rather than trusting this call.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err != null ? reject(err) : resolve()));
      });
    },
  };
}
