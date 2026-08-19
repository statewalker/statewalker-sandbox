/**
 * The static server process: plain `node:http`/`node:https`, nothing else.
 *
 * NO LIBP2P, NO MESH IDENTITY -- this file imports neither `httpeers.core`
 * nor any `@libp2p/*`/`libp2p` package. It is a web server, full stop; the
 * relay (`../relay/main.ts`) is the one process in this app allowed to
 * touch libp2p, for the reasons documented there.
 *
 * TWO PORTS IS A CORRECTNESS REQUIREMENT, NOT A CONVENIENCE. The main app
 * (5175) and the image peer (5176) each get their own origin, which means
 * each gets its own ServiceWorker scope and its own adapter key. Two pages
 * sharing one origin would be two SW *clients* of one *registration* -- an
 * unmeasured case where whichever page's `loadChannelInfo` iteration runs
 * last wins the adapter key, and the other page's peer becomes unreachable
 * through the edge while still holding a live libp2p connection. Do not
 * consolidate the two `createOriginServer` calls below onto one port.
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
 * 503 ("run setup"), never a 404 ("not found") -- those are different
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

/** The main app's port. Fixed by the brief -- not an env-configurable knob. */
export const APP_PORT = 5175;
/** The image peer's port. Fixed by the brief -- not an env-configurable knob. */
export const IMAGE_PEER_PORT = 5176;

/** See the module comment's "DIST DIRECTORY LAYOUT" note. */
export const DEFAULT_APP_DIST_DIR = "dist/app";
/** See the module comment's "DIST DIRECTORY LAYOUT" note. */
export const DEFAULT_IMAGE_PEER_DIST_DIR = "dist/image-peer";

/** Where `pnpm setup` (Task 10) writes the invitation payload, and where both origins read it back from. */
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

/** Resolves a request path to a file inside `distDir`, refusing to escape it (e.g. via `..`). Returns `null` if the resolved path would fall outside `distDir`. */
function resolveDistFile(distDir: string, pathname: string): string | null {
  const relative =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const root = resolve(distDir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

function serveFile(
  res: ServerResponse,
  filePath: string,
  extraHeaders?: Record<string, string>,
): void {
  let body: Buffer;
  try {
    body = readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    throw err;
  }
  const contentType = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, ...extraHeaders }).end(body);
}

function serveHttpeersConfig(res: ServerResponse, configPath: string): void {
  let body: Buffer;
  try {
    body = readFileSync(configPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Absent config is a DIFFERENT condition from a missing route: the
      // page should be able to say "run setup", not "not found".
      res
        .writeHead(503, { "Content-Type": "application/json; charset=utf-8" })
        .end(JSON.stringify({ error: 'httpeers.json not found -- run "pnpm setup" first' }));
      return;
    }
    throw err;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(body);
}

/** One origin's request handler: `httpeers.json`, this origin's ServiceWorker script, and everything else out of `distDir`. Every branch is wrapped so a thrown error becomes a 500, not a crashed process or a hung socket -- and a POST/PUT/etc. to any path, matched or not, is a plain 404, never routed into file-reading logic that could throw. */
function createHandler(init: OriginServerInit) {
  const swFile = init.swFile ?? "sw.js";
  const configPath = init.httpeersConfigPath ?? DEFAULT_HTTPEERS_CONFIG_PATH;

  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://static-server").pathname;

      if (pathname === "/httpeers.json") {
        serveHttpeersConfig(res, configPath);
        return;
      }

      const filePath = resolveDistFile(init.distDir, pathname);
      if (filePath == null) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }

      const isSwScript = pathname === `/${swFile}`;
      serveFile(res, filePath, isSwScript ? SW_NO_CACHE_HEADERS : undefined);
    } catch (err) {
      console.error("static-server: unhandled error serving request:", err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("internal error");
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
  httpeersConfigPath?: string;
  tls?: OriginTlsInit;
  /** Defaults to `APP_PORT` (5175). Overridable (e.g. `0` for an ephemeral port) so tests never need the fixed production ports free. */
  appPort?: number;
  /** Defaults to `IMAGE_PEER_PORT` (5176). Same override rationale as `appPort`. */
  imagePeerPort?: number;
}

export interface StaticServers {
  /** The app origin's actual bound port. */
  appPort: number;
  /** The image peer origin's actual bound port. */
  imagePeerPort: number;
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

  const [appPort, imagePeerPort] = await Promise.all([app.listen(), imagePeer.listen()]);

  return {
    appPort,
    imagePeerPort,
    async stop() {
      await Promise.all([app.close(), imagePeer.close()]);
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
    tls,
  });

  const scheme = tls != null ? "https" : "http";
  console.log(`static-server: app listening at ${scheme}://0.0.0.0:${APP_PORT}`);
  console.log(`static-server: image peer listening at ${scheme}://0.0.0.0:${IMAGE_PEER_PORT}`);

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
