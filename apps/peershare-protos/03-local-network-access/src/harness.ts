/**
 * A PUBLIC https page in real Chromium, on a test machine.
 *
 * Chromium decides a page's address space from the IP it was loaded from, so
 * a page served from 127.0.0.1 is "loopback" and never meets Local Network
 * Access. `--ip-address-space-overrides` (the switch Chromium's own tests use)
 * relabels chosen `ip:port`s: the page becomes public, and a server on this
 * machine's non-loopback interface can play a LAN device.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer, type Server } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export interface PublicPage {
  origin: string;
  port: number;
  close(): Promise<void>;
}

/** A throwaway self-signed certificate for `san` (e.g. `IP:127.0.0.1`, `DNS:remote.localhost`). */
export function selfSignedCert(san: string): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "peershare-cert-"));
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
      ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      ...["-subj", "/CN=peershare-test", "-addext", `subjectAltName=${san}`],
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
}

/** An https server on 127.0.0.1 with a certificate for `san`. */
export async function startHttps(
  san: string,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<PublicPage> {
  const server: Server = createServer(selfSignedCert(san), handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The PeerShare page stand-in: https on 127.0.0.1, relabelled public by `launchChromium`. */
export function startPublicPage(): Promise<PublicPage> {
  return startHttps("IP:127.0.0.1", (req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>PeerShare (public page)</title><p>public</p>");
  });
}

/** `overrides` as `ip:port=public|private|local`. */
export function launchChromium(overrides: string[]): Promise<Browser> {
  return chromium.launch({ args: [`--ip-address-space-overrides=${overrides.join(",")}`] });
}

const pageCode = new Map<string, Promise<string>>();

/** `entry` (default: this rung's `browser-entry.ts`), bundled once, as an IIFE exposing `window[name]`. */
export function bundledPageCode(
  entry = resolve(here, "browser-entry.ts"),
  name = "Rung03",
): Promise<string> {
  const key = `${entry}#${name}`;
  let code = pageCode.get(key);
  if (code == null) {
    code = (async () => {
      const built = await build({
        root: dirname(entry),
        logLevel: "error",
        configFile: false,
        build: {
          target: "esnext",
          write: false,
          minify: false,
          lib: { entry, formats: ["iife"], name },
        },
      });
      // biome-ignore lint/suspicious/noExplicitAny: vite's build() union is not narrowable here.
      const results = (Array.isArray(built) ? built : [built]) as any[];
      const chunk = results[0]?.output?.find((o: { type: string }) => o.type === "chunk");
      if (chunk == null) throw new Error(`no chunk built for ${entry}`);
      return chunk.code as string;
    })();
    pageCode.set(key, code);
  }
  return code;
}

export interface OpenedPage {
  context: BrowserContext;
  page: Page;
  /** What Chromium logged: the only place it says WHY a request was blocked. */
  console: string[];
}

/** The public page with the bundle loaded; `grant` answers the Local Network Access prompt with "Allow". */
export async function openPage(
  browser: Browser,
  origin: string,
  opts: { grant?: boolean; entry?: string; name?: string } = {},
): Promise<OpenedPage> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (opts.grant === true) await context.grantPermissions(["local-network-access"]);
  const page = await context.newPage();
  const console: string[] = [];
  page.on("console", (m) => console.push(m.text()));
  await page.goto(`${origin}/`);
  await page.addScriptTag({ content: await bundledPageCode(opts.entry, opts.name) });
  return { context, page, console };
}

/** This machine's first non-loopback IPv4 address: where a "LAN device" can listen. */
export function lanAddress(): string | undefined {
  return Object.values(networkInterfaces())
    .flat()
    .find((i) => i != null && i.family === "IPv4" && !i.internal)?.address;
}

/**
 * A Way B Service on the LAN: plain http, and it sends CORS headers itself,
 * as Way B requires.
 */
export async function startLanService(host: string): Promise<PublicPage> {
  const server = createHttpServer((req, res) => {
    const cors = {
      "access-control-allow-origin": req.headers.origin ?? "*",
      "access-control-allow-headers": "*",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(JSON.stringify({ service: "nas", path: req.url }));
  });
  await new Promise<void>((r) => server.listen(0, host, r));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("no address");
  return {
    origin: `http://${host}:${address.port}`,
    port: address.port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
