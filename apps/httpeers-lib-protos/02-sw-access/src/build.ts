/**
 * Two builds, deliberately.
 *
 * The alias that redirects `@biscuit-auth/biscuit-wasm` to the loader shim is
 * a whole-build setting, so building both workers together would apply it to
 * both and there would be nothing to compare. Pass 1 builds the page and the
 * naive worker with the package as published; pass 2 adds only the aliased
 * worker, with `emptyOutDir: false` so it lands beside them.
 *
 * `rolldownOptions` + `treeshake: false`, BOTH LOAD-BEARING, and this rung
 * re-discovered why the hard way. `@statewalker/webrun-http-browser` declares
 * `"sideEffects": false`, so the bare `import ".../sw-worker"` that IS the
 * worker's whole job is legally tree-shaken away: the worker still registers
 * and still activates, but it installs no `fetch` listener and never calls
 * `clients.claim()`, so the page is never controlled and `initServiceWorker`
 * waits forever on a `controllerchange` that cannot come. The first version
 * of this file used `rollupOptions`, which this vite version accepts and then
 * SILENTLY DROPS `treeshake` from — producing exactly that worker.
 * `apps/httpeers-stack/vite.app.config.ts` carries the same warning from its
 * Task 12; the trap is reproducible and costs an hour every time.
 */
import { cpSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const BISCUIT_WASM = resolve(
  here,
  "../../node_modules/@biscuit-auth/biscuit-wasm/module/biscuit_bg.wasm",
);

export async function buildFixture(outDir: string): Promise<void> {
  // Pass 1 — the page and variant A, with biscuit-wasm exactly as published.
  await build({
    root: here,
    logLevel: "warn",
    build: {
      target: "esnext",
      outDir,
      emptyOutDir: true,
      rolldownOptions: {
        input: { index: resolve(here, "index.html"), "sw-naive": resolve(here, "sw-naive.ts") },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "sw-naive" ? "sw-naive.js" : "assets/[name]-[hash].js",
        },
        treeshake: false,
      },
    },
  });

  // Pass 2 — variant B, with the loader shim aliased in.
  await build({
    root: here,
    logLevel: "warn",
    resolve: { alias: { "@biscuit-auth/biscuit-wasm": resolve(here, "biscuit-shim.ts") } },
    build: {
      target: "esnext",
      outDir,
      emptyOutDir: false,
      rolldownOptions: {
        input: { "sw-manual": resolve(here, "sw-manual.ts") },
        output: { entryFileNames: "[name].js" },
        treeshake: false,
      },
    },
  });

  // Variant B fetches the wasm by URL, so it has to be servable.
  cpSync(BISCUIT_WASM, resolve(outDir, "biscuit_bg.wasm"));
}
