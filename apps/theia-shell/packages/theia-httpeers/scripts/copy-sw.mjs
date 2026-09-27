/**
 * Copies the ServiceWorker the mesh edge registers into `lib/sw.js`; the app's
 * `esbuild.mjs` puts it at `lib/frontend/sw.js`, un-hashed at the origin root.
 *
 * It is `webrun-http-browser`'s ready-made IIFE worker, resolved from
 * `httpeers-member` itself so the worker is the same copy the bundled edge
 * talks to. Copied, not bundled: bundling it as an entry yields a zero-byte
 * file, and an empty registered worker routes nothing without saying why.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const member = fileURLToPath(import.meta.resolve("@statewalker/httpeers-member"));
const worker = createRequire(member).resolve("@statewalker/webrun-http-browser/sw-worker");
mkdirSync(join(here, "..", "lib"), { recursive: true });
copyFileSync(worker, join(here, "..", "lib", "sw.js"));
