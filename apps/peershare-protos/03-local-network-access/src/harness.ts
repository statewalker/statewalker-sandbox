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
import { createServer as createHttpServer } from "node:http";
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

/** An https page with a throwaway self-signed certificate for 127.0.0.1. */
export async function startPublicPage(): Promise<PublicPage> {
  const dir = mkdtempSync(join(tmpdir(), "peershare-03-"));
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1"],
      ...["-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")],
      ...["-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
    ],
    { stdio: "ignore" },
  );
  const server: Server = createServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/" }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>PeerShare (public page)</title><p>public</p>");
    },
  );
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

/** `overrides` as `ip:port=public|private|local`. */
export function launchChromium(overrides: string[]): Promise<Browser> {
  return chromium.launch({ args: [`--ip-address-space-overrides=${overrides.join(",")}`] });
}

let pageCode: Promise<string> | undefined;

/** `browser-entry.ts`, bundled once, as an IIFE exposing `window.Rung03`. */
export function bundledPageCode(): Promise<string> {
  pageCode ??= (async () => {
    const built = await build({
      root: here,
      logLevel: "error",
      configFile: false,
      build: {
        target: "esnext",
        write: false,
        minify: false,
        lib: { entry: resolve(here, "browser-entry.ts"), formats: ["iife"], name: "Rung03" },
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: vite's build() union is not narrowable here.
    const results = (Array.isArray(built) ? built : [built]) as any[];
    const chunk = results[0]?.output?.find((o: { type: string }) => o.type === "chunk");
    if (chunk == null) throw new Error("no chunk built for the page");
    return chunk.code as string;
  })();
  return pageCode;
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
  opts: { grant?: boolean } = {},
): Promise<OpenedPage> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  if (opts.grant === true) await context.grantPermissions(["local-network-access"]);
  const page = await context.newPage();
  const console: string[] = [];
  page.on("console", (m) => console.push(m.text()));
  await page.goto(`${origin}/`);
  await page.addScriptTag({ content: await bundledPageCode() });
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
