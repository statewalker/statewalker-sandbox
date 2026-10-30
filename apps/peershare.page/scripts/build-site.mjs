#!/usr/bin/env node
/**
 * `node scripts/build-site.mjs [outDir]` (default `site/`): the PeerShare page as
 * a site for httpeers' static host (decision 2.8), in the shape `rclone sync`
 * and httpeers' `tools/publish` write to the `sites` bucket:
 *
 *   <outDir>/<SITE>/index.html, assets/…   the page
 *   <outDir>/<SITE>/peershare.json         httpeers' relay and session zone
 *   <outDir>/<SITE>/.site/config.json      { "spa": true }: every route is the page
 *
 * SITE (default peershare.httpeers.net), SESSION_ZONE (default p.httpeers.net),
 * RELAY_DOCUMENT_URL (default the relay's own published document).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";

const SITE = process.env.SITE ?? "peershare.httpeers.net";
const SESSION_ZONE = process.env.SESSION_ZONE ?? "p.httpeers.net";
const RELAY_DOCUMENT_URL =
  process.env.RELAY_DOCUMENT_URL ?? "https://relay.httpeers.net/.well-known/httpeers-relay.json";

const out = resolve(process.argv[2] ?? "site");
const site = join(out, SITE);
rmSync(site, { recursive: true, force: true });

await build({
  root: resolve(import.meta.dirname, ".."),
  logLevel: "warn",
  build: { outDir: site, emptyOutDir: true },
});

// The relay states its own addresses (httpeers apps/relay, bootstrap document).
const res = await fetch(RELAY_DOCUMENT_URL);
if (!res.ok) throw new Error(`${RELAY_DOCUMENT_URL}: ${res.status}`);
const { relayAddrs } = await res.json();
if (!Array.isArray(relayAddrs) || relayAddrs.length === 0) {
  throw new Error(`${RELAY_DOCUMENT_URL} names no relayAddrs`);
}

writeFileSync(
  join(site, "peershare.json"),
  `${JSON.stringify({ relayAddrs, sessionOrigin: `https://{name}.${SESSION_ZONE}` }, null, 2)}\n`,
);
mkdirSync(join(site, ".site"), { recursive: true });
writeFileSync(
  join(site, ".site/config.json"),
  `${JSON.stringify({ spa: true, cacheControl: "public, no-cache" }, null, 2)}\n`,
);
console.log(`site ready: ${site} (publish: rclone sync ${site} httpeers:sites/${SITE})`);
