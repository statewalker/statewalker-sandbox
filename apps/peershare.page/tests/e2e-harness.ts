/**
 * Everything around the page, real: a relay, a public https server for the
 * built page, session origins on `<name>.localhost` built from the vendored
 * shell, and Chromium told which addresses are public (apps/peershare-protos
 * rungs 03 and 08 for why each piece is the way it is).
 */

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p } from "libp2p";
import { type Browser, chromium } from "playwright";
import { build } from "vite";

export interface Hosted {
  origin: string;
  port: number;
  spki: string;
  close(): Promise<void>;
}

function cert(san: string) {
  const dir = mkdtempSync(join(tmpdir(), "peershare-e2e-"));
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
      ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      ...["-subj", "/CN=peershare-e2e", "-addext", `subjectAltName=${san}`],
    ],
    { stdio: "ignore" },
  );
  const key = readFileSync(join(dir, "key.pem"));
  const spki = createHash("sha256")
    .update(createPublicKey(key).export({ type: "spki", format: "der" }))
    .digest("base64");
  return { key, cert: readFileSync(join(dir, "cert.pem")), spki };
}

async function https(san: string, handler: Parameters<typeof createServer>[1]): Promise<Hosted> {
  const c = cert(san);
  const server: Server = createServer({ key: c.key, cert: c.cert }, handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    port: address.port,
    spki: c.spki,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

/** The built page (`dist/`), with `/peershare.json`, every route falling back to index.html. */
export function servePage(dist: string, config: () => object): Promise<Hosted> {
  return https("IP:127.0.0.1", async (req, res) => {
    const path = new URL(req.url ?? "/", "https://x").pathname;
    if (path === "/peershare.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(config()));
      return;
    }
    const file = path.startsWith("/assets/") ? join(dist, path) : join(dist, "index.html");
    try {
      const body = await readFile(file);
      res
        .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
}

async function bundle(entry: string): Promise<string> {
  const built = await build({
    root: resolve(entry, ".."),
    logLevel: "error",
    configFile: false,
    build: {
      target: "esnext",
      write: false,
      minify: false,
      lib: { entry, formats: ["iife"], name: "Shell" },
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: vite's build() union is not narrowable here.
  const results = (Array.isArray(built) ? built : [built]) as any[];
  return results[0]?.output?.find((o: { type: string }) => o.type === "chunk").code;
}

/** Session origins `https://<name>.localhost:<port>`, serving the vendored shell. */
export async function serveSessions(vendor: string): Promise<Hosted> {
  const [worker, relay, shim] = await Promise.all([
    bundle(join(vendor, "sw.ts")),
    bundle(join(vendor, "relay.ts")),
    bundle(resolve(vendor, "../../ws-shim.ts")),
  ]);
  const js = { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" };
  return https("DNS:localhost,DNS:*.localhost", (req, res) => {
    const path = new URL(req.url ?? "/", "https://x").pathname;
    if (path === "/relay-sw.js") return void res.writeHead(200, js).end(worker);
    if (path === "/_shell/relay.js") return void res.writeHead(200, js).end(relay);
    if (path === "/_shell/ws-shim.js") return void res.writeHead(200, js).end(shim);
    if (path === "/relay.html") {
      return void res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end('<!doctype html><meta charset="utf-8"><script src="/_shell/relay.js"></script>');
    }
    res.writeHead(404).end("<p>An empty session.</p>");
  });
}

export async function startRelay(): Promise<{ addr: string; stop(): Promise<void> }> {
  const node = await createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionManager: { inboundConnectionThreshold: 1000, maxIncomingPendingConnections: 1000 },
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: {
          applyDefaultLimit: true,
          defaultDataLimit: 1n << 30n,
          defaultDurationLimit: 6 * 3600_000,
        },
      }),
    },
  });
  const addr = node
    .getMultiaddrs()
    .map(String)
    .find((a) => a.includes("/ws/"));
  if (addr == null) throw new Error("relay has no ws address");
  return {
    addr,
    stop: async () => {
      await node.stop();
    },
  };
}

/** Chromium with the page relabelled public, and the session certificate trusted. */
export function launch(page: Hosted, sessions: Hosted): Promise<Browser> {
  return chromium.launch({
    args: [
      `--ip-address-space-overrides=127.0.0.1:${page.port}=public`,
      `--ignore-certificate-errors-spki-list=${sessions.spki}`,
    ],
  });
}
