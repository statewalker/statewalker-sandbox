/**
 * The static server process: plain `node:http`/`node:https`, nothing else.
 *
 * NO LIBP2P, NO MESH IDENTITY -- this file imports neither `httpeers.core`
 * nor any `@libp2p/*`/`libp2p` package. It is a web server, full stop; the
 * relay (`../relay/main.ts`) is the one process in this app allowed to
 * touch libp2p, for the reasons documented there.
 *
 * ONE PORT PER PAGE IS A CORRECTNESS REQUIREMENT, NOT A CONVENIENCE. The
 * main app (5175), the image peer (5176) and the hub page (5177) each get
 * their own origin, which means each gets its own ServiceWorker scope and
 * its own adapter key. Two pages sharing one origin would be two SW
 * *clients* of one *registration* -- an unmeasured case where whichever
 * page's `loadChannelInfo` iteration runs last wins the adapter key, and
 * the other page's peer becomes unreachable through the edge while still
 * holding a live libp2p connection. Do not consolidate the
 * `createOriginServer` calls below onto one port.
 *
 * THE HUB PAGE (Task 24) IS A THIRD ORIGIN FOR A SECOND REASON ON TOP OF
 * THAT ONE. Each origin is also its own IndexedDB, and that is where a page
 * keeps its identity (`../browser/identity.ts`). The hub page's identity is
 * the MESH -- `claims.mesh === claims.iss` -- so it must not be the same
 * stored key as any joining page's, or the hub and one of its own members
 * would be the same peer. Sharing an origin here would not merely confuse
 * the ServiceWorker; it would collapse the mesh's issuer into one of its
 * subjects.
 *
 * DIST DIRECTORY LAYOUT IS AN ASSUMPTION THIS TASK MAKES. Tasks 12/13 (the
 * image-peer and main-app pages, `vite.image-peer.config.ts` /
 * `vite.app.config.ts`) do not exist yet, so there is no built bundle to
 * point at. `dist/app` and `dist/image-peer` are chosen as the defaults --
 * following this workspace's existing `dist/` gitignore convention -- and
 * are overridable via `APP_DIST_DIR`/`IMAGE_PEER_DIST_DIR` precisely so
 * Task 12/13's vite configs can either match this default or override it
 * with no change needed here. Flag to the team lead if a different layout
 * is later chosen.
 *
 * THE SERVICE WORKER SCRIPT is assumed to build to `sw.js` at the dist
 * root (from each page's `sw.ts` entry) -- also overridable
 * (`swFile` on `OriginServerInit`) for the same reason.
 *
 * `/httpeers.json` IS SERVED FROM OUTSIDE EACH DIST DIRECTORY -- it is one
 * shared invitation payload (Task 10's setup CLI writes it once, at the
 * app package root), not a per-page build artifact. A missing file is a
 * 503 ("run bootstrap"), never a 404 ("not found") -- those are different
 * conditions and the page needs to be able to tell them apart.
 */

import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, resolve, sep } from "node:path";

// The three page ports live in `../ports.ts` -- a file with nothing in it
// but these numbers, because the hub page needs them to compose the join
// links it hands out and cannot import THIS module to get them (its
// run-as-a-process guard evaluates `process.argv` at top level, which
// throws in a tab). Re-exported here so every existing importer, this
// module included, still reads them from where they are used.
export { APP_PORT, HUB_PAGE_PORT, IMAGE_PEER_PORT } from "../ports.js";

import { APP_PORT, HUB_PAGE_PORT, IMAGE_PEER_PORT } from "../ports.js";

/** See the module comment's "DIST DIRECTORY LAYOUT" note. */
export const DEFAULT_APP_DIST_DIR = "dist/app";
/** See the module comment's "DIST DIRECTORY LAYOUT" note. */
export const DEFAULT_IMAGE_PEER_DIST_DIR = "dist/image-peer";
/** See the module comment's "DIST DIRECTORY LAYOUT" note. `vite.hub.config.ts` builds here. */
export const DEFAULT_HUB_PAGE_DIST_DIR = "dist/hub";

/** Where `pnpm bootstrap` (Task 10) writes the invitation payload, and where both origins read it back from. */
export const DEFAULT_HTTPEERS_CONFIG_PATH = "./httpeers.json";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** No-cache headers for the ServiceWorker script -- see the module comment on `webrun-http-browser`'s duplex bug in the sibling doc for why a stale cached SW is treated as a first-class risk here, not an afterthought. */
const SW_NO_CACHE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  "Service-Worker-Allowed": "/",
};

export interface OriginTlsInit {
  cert: string;
  key: string;
}

export interface OriginServerInit {
  port: number;
  /** Where this origin's built `index.html` (and its other assets) live. */
  distDir: string;
  /** The ServiceWorker script's filename within `distDir`. Defaults to `"sw.js"`. */
  swFile?: string;
  /** Where the shared `httpeers.json` invitation payload lives. Defaults to `DEFAULT_HTTPEERS_CONFIG_PATH`. */
  httpeersConfigPath?: string;
  /** PEM cert/key content (already read from `TLS_CERT`/`TLS_KEY`'s files). Omit for plain HTTP. */
  tls?: OriginTlsInit;
}

export interface OriginServer {
  /** Resolves to the actual bound port -- the same as `init.port` unless `init.port` was `0` (used by tests to bind an ephemeral port). */
  listen(): Promise<number>;
  close(): Promise<void>;
}

/**
 * Resolves a request path to a file inside `distDir`, refusing to escape it
 * (e.g. via `..`). Returns `null` -- meaning "404, not a server error" to
 * every caller -- both when the resolved path would fall outside `distDir`
 * AND when `pathname` carries malformed percent-encoding (e.g. a lone
 * trailing `%`, which `decodeURIComponent` throws `URIError` on). A
 * malformed path is not a 500: it is exactly as "not found" as any other
 * path this server doesn't recognise, and a scanner or a stale cached link
 * can produce one without doing anything unusual.
 *
 * Exported (only) so `tests/static-server.test.ts` can exercise the root-
 * boundary check directly with a target that is genuinely outside
 * `distDir` -- `new URL()`'s own dot-segment normalization means an actual
 * out-of-root request is not constructible through the HTTP server's own
 * request handling (see that test for the full explanation), which would
 * otherwise leave this function's `target.startsWith(root + sep)` guard
 * completely untested.
 */
export function resolveDistFile(distDir: string, pathname: string): string | null {
  let relative: string;
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return null;
  }
  const root = resolve(distDir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * Writes `body` as the response, except for a `HEAD` request, which gets
 * the same status/headers with no body passed to `.end()`. Node's
 * `http.ServerResponse` already suppresses a `HEAD` response's body
 * unconditionally on its own (verified directly: a raw TCP capture shows
 * zero body bytes on the wire even when `.end(body)` is called
 * unconditionally, with no `isHead` check anywhere) -- `isHead` is
 * threaded through explicitly anyway so that guarantee is visible in this
 * code, rather than resting on a reader already knowing an uncited Node
 * runtime behaviour.
 */
function respond(
  res: ServerResponse,
  isHead: boolean,
  status: number,
  headers: Record<string, string>,
  body: string | Buffer,
): void {
  res.writeHead(status, headers);
  res.end(isHead ? undefined : body);
}

function serveFile(
  res: ServerResponse,
  filePath: string,
  isHead: boolean,
  extraHeaders?: Record<string, string>,
): void {
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: no such file. EISDIR: `filePath` resolved to a real
    // directory (e.g. a request for a bundle subdirectory with no
    // trailing index.html of its own) -- `readFileSync` throws for both,
    // and both mean "nothing to serve at this path," not a server error.
    if (code === "ENOENT" || code === "EISDIR") {
      respond(res, isHead, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found");
      return;
    }
    throw err;
  }
  const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  respond(res, isHead, 200, { "Content-Type": contentType, ...extraHeaders }, body);
}

function serveHttpeersConfig(res: ServerResponse, configPath: string, isHead: boolean): void {
  let body: Buffer;
  try {
    body = readFileSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Absent config is a DIFFERENT condition from a missing route: the
      // page should be able to say "run bootstrap", not "not found".
      respond(
        res,
        isHead,
        503,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({ error: 'httpeers.json not found -- run "pnpm bootstrap" first' }),
      );
      return;
    }
    throw err;
  }
  respond(res, isHead, 200, { "Content-Type": "application/json; charset=utf-8" }, body);
}

/**
 * One origin's request handler: `httpeers.json`, this origin's
 * ServiceWorker script, and everything else out of `distDir`.
 *
 * NEVER 500 ON A REQUEST SHAPE, ONLY ON A GENUINE SERVER FAULT. Every path
 * an attacker, a scanner, or a stale cached link can drive from the
 * request alone -- an unmatched route, a POST/PUT/etc. verb, a `..`-shaped
 * path, malformed percent-encoding, a path that resolves to a real
 * directory -- is handled explicitly and answered 404 (or 503 for the one
 * "config not generated yet" case) before any file read that could throw
 * on it runs. A POST specifically never reaches file-reading logic at
 * all: the method check below runs first. The outer `try`/`catch` here is
 * a last-resort net for a genuine fault (e.g. a permissions error reading
 * `distDir` itself), not the mechanism relied on for any of the cases
 * above -- each of those is caught at its own, more specific layer.
 */
function createHandler(init: OriginServerInit) {
  const swFile = init.swFile ?? "sw.js";
  const configPath = init.httpeersConfigPath ?? DEFAULT_HTTPEERS_CONFIG_PATH;

  return (req: IncomingMessage, res: ServerResponse): void => {
    const isHead = req.method === "HEAD";
    try {
      if (req.method !== "GET" && !isHead) {
        respond(res, false, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found");
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://static-server").pathname;

      if (pathname === "/httpeers.json") {
        serveHttpeersConfig(res, configPath, isHead);
        return;
      }

      const filePath = resolveDistFile(init.distDir, pathname);
      if (filePath == null) {
        respond(res, isHead, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found");
        return;
      }

      const isSwScript = pathname === `/${swFile}`;
      serveFile(res, filePath, isHead, isSwScript ? SW_NO_CACHE_HEADERS : undefined);
    } catch (err) {
      console.error("static-server: unhandled error serving request:", err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(isHead ? undefined : "internal error");
    }
  };
}

export function createOriginServer(init: OriginServerInit): OriginServer {
  const handler = createHandler(init);
  const server =
    init.tls != null
      ? createHttpsServer({ cert: init.tls.cert, key: init.tls.key }, handler)
      : createHttpServer(handler);

  return {
    listen: () =>
      new Promise<number>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(init.port, () => {
          const addr = server.address();
          resolvePromise(typeof addr === "object" && addr != null ? addr.port : init.port);
        });
      }),
    close: () =>
      new Promise<void>((resolvePromise, reject) =>
        server.close((err) => (err ? reject(err) : resolvePromise())),
      ),
  };
}

export interface StartStaticServerInit {
  appDistDir?: string;
  imagePeerDistDir?: string;
  hubPageDistDir?: string;
  httpeersConfigPath?: string;
  tls?: OriginTlsInit;
  /** Defaults to `APP_PORT` (5175). Overridable (e.g. `0` for an ephemeral port) so tests never need the fixed production ports free. */
  appPort?: number;
  /** Defaults to `IMAGE_PEER_PORT` (5176). Same override rationale as `appPort`. */
  imagePeerPort?: number;
  /** Defaults to `HUB_PAGE_PORT` (5177). Same override rationale as `appPort`. */
  hubPagePort?: number;
}

export interface StaticServers {
  /** The app origin's actual bound port. */
  appPort: number;
  /** The image peer origin's actual bound port. */
  imagePeerPort: number;
  /** The hub page origin's actual bound port. */
  hubPagePort: number;
  stop(): Promise<void>;
}

export async function startStaticServer(init: StartStaticServerInit = {}): Promise<StaticServers> {
  const app = createOriginServer({
    port: init.appPort ?? APP_PORT,
    distDir: init.appDistDir ?? DEFAULT_APP_DIST_DIR,
    httpeersConfigPath: init.httpeersConfigPath,
    tls: init.tls,
  });
  const imagePeer = createOriginServer({
    port: init.imagePeerPort ?? IMAGE_PEER_PORT,
    distDir: init.imagePeerDistDir ?? DEFAULT_IMAGE_PEER_DIST_DIR,
    httpeersConfigPath: init.httpeersConfigPath,
    tls: init.tls,
  });
  // The third origin -- see the module comment's "ONE PORT PER PAGE" note
  // and the paragraph after it for why the hub page in particular cannot
  // share one. It serves the same `httpeers.json` as the other two, and for
  // the same reason: the hub page reads `relayAddrs` out of it (its own
  // peerId is not in there and could not be -- it is generated in the tab).
  const hubPage = createOriginServer({
    port: init.hubPagePort ?? HUB_PAGE_PORT,
    distDir: init.hubPageDistDir ?? DEFAULT_HUB_PAGE_DIST_DIR,
    httpeersConfigPath: init.httpeersConfigPath,
    tls: init.tls,
  });

  const [appPort, imagePeerPort, hubPagePort] = await Promise.all([
    app.listen(),
    imagePeer.listen(),
    hubPage.listen(),
  ]);

  return {
    appPort,
    imagePeerPort,
    hubPagePort,
    async stop() {
      await Promise.all([app.close(), imagePeer.close(), hubPage.close()]);
    },
  };
}

// Run directly (e.g. `tsx src/static-server/main.ts`) rather than only as a library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const tls =
    process.env.TLS_CERT != null && process.env.TLS_KEY != null
      ? {
          cert: readFileSync(process.env.TLS_CERT, "utf8"),
          key: readFileSync(process.env.TLS_KEY, "utf8"),
        }
      : undefined;

  const servers = await startStaticServer({
    appDistDir: process.env.APP_DIST_DIR,
    imagePeerDistDir: process.env.IMAGE_PEER_DIST_DIR,
    hubPageDistDir: process.env.HUB_PAGE_DIST_DIR,
    tls,
  });

  const scheme = tls != null ? "https" : "http";
  // PRINT A URL THAT WORKS, NOT THE BIND ADDRESS. These servers bind 0.0.0.0
  // (every interface), but `http://0.0.0.0:PORT` must never be offered as
  // something to open: browsers do not treat 0.0.0.0 as a secure context, so
  // `navigator.serviceWorker` is undefined there and every page in this stack
  // fails at `mountEdge` -- the peer is only reachable through the page's own
  // fetch(), which is the ServiceWorker. `127.0.0.1` is the same server,
  // reached over the same bind, and IS a secure context.
  //
  // This was not theoretical: the printed 0.0.0.0 URL was followed, and the
  // failure surfaced as a relay/gater error naming neither cause nor fix.
  const shown = scheme === "https" ? (process.env.PUBLIC_HOST ?? "127.0.0.1") : "127.0.0.1";
  console.log(`static-server: app listening at ${scheme}://${shown}:${APP_PORT}`);
  console.log(`static-server: image peer listening at ${scheme}://${shown}:${IMAGE_PEER_PORT}`);
  console.log(`static-server: hub page listening at ${scheme}://${shown}:${HUB_PAGE_PORT}`);
  if (scheme !== "https") {
    console.log(
      "static-server: open these on 127.0.0.1 or localhost. Another device on the LAN " +
        "needs https (TLS_CERT/TLS_KEY) -- a LAN address over plain http is not a secure " +
        "context, so the pages' ServiceWorker, and with it the mesh, will not start.",
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nstatic-server: received ${signal}, stopping...`);
    try {
      await servers.stop();
    } catch (err) {
      console.error("static-server: error during stop:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
