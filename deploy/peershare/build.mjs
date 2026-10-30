#!/usr/bin/env node
/**
 * `node deploy/peershare/build.mjs` — everything Caddy serves, into ./srv:
 *
 *   srv/page/    the PeerShare page (apps/peershare.page)
 *   srv/shell/   the session shell, built for this deployment's zones
 *   srv/config/  peershare.json
 *
 * Settings come from the environment (see .env.example).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const here = import.meta.dirname;
const root = resolve(here, "../..");
const page = join(root, "apps/peershare.page");
// vite is the page's own dependency; resolve it from there.
const { build } = await import(createRequire(join(page, "package.json")).resolve("vite"));

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value == null) throw new Error(`set ${name} (see deploy/peershare/.env.example)`);
  return value;
};
const SESSION_ZONE = env("SESSION_ZONE"); // p.sandclaw.ai
const PARENT_ZONE = env("PARENT_ZONE"); // sandclaw.ai: the page lives here or one label under it
const HTTPS_PORT = env("HTTPS_PORT", "443");
const RELAY_ADDRS = env("RELAY_ADDRS").split(",").filter(Boolean);
const port = HTTPS_PORT === "443" ? "" : `:${HTTPS_PORT}`;

const srv = join(here, "srv");
rmSync(srv, { recursive: true, force: true });

// The page.
await build({
  root: page,
  logLevel: "warn",
  build: { outDir: join(srv, "page"), emptyOutDir: true },
});

// The shell, for this deployment's zones.
const vendor = join(page, "src/vendor/session-shell");
const define = {
  __PEERSHARE_SESSION_ZONE__: JSON.stringify(SESSION_ZONE),
  __PEERSHARE_PARENT_ZONE__: JSON.stringify(PARENT_ZONE),
};
for (const [entry, out] of [
  ["sw.ts", "relay-sw.js"],
  ["relay.ts", "_shell/relay.js"],
  // The WebSocket shim (M9): served beside the relay, outside the worker's reach.
  ["../../ws-shim.ts", "_shell/ws-shim.js"],
]) {
  await build({
    root: vendor,
    logLevel: "warn",
    configFile: false,
    define,
    build: {
      outDir: join(srv, "shell", out.includes("/") ? out.split("/")[0] : ""),
      emptyOutDir: false,
      minify: true,
      lib: {
        entry: join(vendor, entry),
        formats: ["iife"],
        name: "Shell",
        fileName: () => out.split("/").pop(),
      },
    },
  });
}
writeFileSync(
  join(srv, "shell/relay.html"),
  '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>session relay</title><script src="/_shell/relay.js"></script>\n',
);
cpSync(join(vendor, "index.html"), join(srv, "shell/index.html"));

// The deployment's facts, for the page.
mkdirSync(join(srv, "config"), { recursive: true });
writeFileSync(
  join(srv, "config/peershare.json"),
  `${JSON.stringify(
    {
      relayAddrs: RELAY_ADDRS,
      sessionOrigin: `https://{name}.${SESSION_ZONE}${port}`,
      ...(process.env.DEV === "true" ? { dev: true } : {}),
    },
    null,
    2,
  )}\n`,
);
console.log(`built ${srv}`);
