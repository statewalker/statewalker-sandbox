/**
 * Session origins on one machine: `https://<name>.localhost:<port>`, each its
 * own origin (Chromium resolves `*.localhost` to loopback). Every name serves
 * the same bytes: the vendored session-shell, built here.
 *
 * HTTPS, not http: the shell admits a navigation only with its parent's
 * `Referer`, and an https Viewer framing an http session is a downgrade, for
 * which the browser sends no referrer at all (measured). Production is https
 * on both sides.
 */

import { createServer, type Server } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { selfSignedCert } from "../../03-local-network-access/src/harness.js";

const vendor = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/session-shell");

async function bundle(entry: string): Promise<string> {
  const built = await build({
    root: vendor,
    logLevel: "error",
    configFile: false,
    build: {
      target: "esnext",
      write: false,
      minify: false,
      lib: { entry: resolve(vendor, entry), formats: ["iife"], name: "Shell" },
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: vite's build() union is not narrowable here.
  const results = (Array.isArray(built) ? built : [built]) as any[];
  const chunk = results[0]?.output?.find((o: { type: string }) => o.type === "chunk");
  if (chunk == null) throw new Error(`no chunk for ${entry}`);
  return chunk.code as string;
}

export interface SessionServer {
  port: number;
  /** WebSocket upgrades that reached this host: a session's sockets bypass its ServiceWorker (rung 15). */
  upgrades: string[];
  /** The certificate's SPKI hash, for `launchChromium(…, trust)`. */
  spki: string;
  /** The `origin` function `openSession` takes. */
  originOf(name: string): string;
  close(): Promise<void>;
}

export async function startSessionServer(): Promise<SessionServer> {
  const [worker, relay] = await Promise.all([bundle("sw.ts"), bundle("relay.ts")]);
  const relayHtml =
    '<!doctype html><meta charset="utf-8"><title>session relay</title>' +
    '<script src="/_shell/relay.js"></script>';
  const fallback =
    "<!doctype html><title>An empty session</title><p>Nothing is connected here.</p>";

  const cert = selfSignedCert("DNS:localhost,DNS:*.localhost");
  const server: Server = createServer(cert, (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const js = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" };
    if (path === "/relay-sw.js") return void res.writeHead(200, js).end(worker);
    if (path === "/_shell/relay.js") return void res.writeHead(200, js).end(relay);
    if (path === "/_shell/ws-shim.js") return void res.writeHead(200, js).end(WS_SHIM);
    if (path === "/relay.html") {
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(relayHtml);
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(fallback);
  });
  const upgrades: string[] = [];
  server.on("upgrade", (req, socket) => {
    upgrades.push(`${req.headers.host}${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  const port = address.port;
  return {
    port,
    spki: cert.spki,
    upgrades,
    originOf: (name) => `https://${name}.localhost:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/**
 * Rung 15's hook (spike): replaces `WebSocket` before the app's own scripts
 * run, so a socket could be carried over the mesh instead of the network.
 * This shim only records the attempt; carrying it is the open question.
 */
const WS_SHIM = `(() => {
  class PeerShareSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = String(url);
      this.readyState = 0;
      (window.__peershareSockets ??= []).push(this.url);
      setTimeout(() => this.dispatchEvent(new Event("error")), 0);
    }
    send() {}
    close() {}
  }
  PeerShareSocket.peershare = true;
  window.WebSocket = PeerShareSocket;
})();`;
