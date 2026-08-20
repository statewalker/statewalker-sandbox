/**
 * Builds the main app page (Task 13, design record §5.4) to `dist/app` --
 * the directory `src/static-server/main.ts`'s `DEFAULT_APP_DIST_DIR`
 * already expects, at the port that module's `APP_PORT` (5175) already
 * reserves.
 *
 * NO PEER ID APPEARS IN THIS FILE. Acceptance criterion 4 covers the build
 * config as well as the page: there is no `define`, no env injection, no
 * constant here naming a provider. The only ids this page ever holds come
 * from `httpeers.json` (fetched at runtime) and the mesh view.
 *
 * Structurally the same as `vite.image-peer.config.ts`, which carries the
 * full reasoning for the two non-obvious settings repeated below; the short
 * version:
 *
 *  - TWO ENTRIES, ONE OF THEM NAMED EXACTLY `sw.js`. `src/pages/app/sw.ts`
 *    must build to `dist/app/sw.js` with no content hash -- the static
 *    server's own `swFile` default and `src/browser/edge.ts`'s
 *    `DEFAULT_SERVICE_WORKER_URL` both name that exact path, and a hashed
 *    ServiceWorker filename would break both the moment a rebuild changed
 *    the hash.
 *
 *  - `treeshake: false` IS LOAD-BEARING, NOT A PERFORMANCE OPINION. `sw.ts`'s
 *    entire job is one side-effecting import; Task 12 found this vite
 *    version's default (rolldown-backed) tree-shaking reducing it to a
 *    literal 0-byte file -- a ServiceWorker that registers fine and
 *    intercepts nothing. `treeshake: { moduleSideEffects: true }` did not
 *    fix it; only disabling tree-shaking outright did.
 *
 *    HOW TO CHECK IT, AND HOW NOT TO. Do NOT grep the built `sw.js` for
 *    `startHttpDispatcher`: the identifier is renamed by minification and
 *    that grep returns 0 on a perfectly good build. (Nor for
 *    `addEventListener("fetch")` with double quotes -- the output uses
 *    backticks.) What actually holds, and what was verified for this build
 *    by reading the file: `dist/app/sw.js` is ~7.8 kB, ends in the minified
 *    top-level call `k({self,log:console.log})` -- that IS
 *    `startHttpDispatcher({ self, log: console.log })` -- and contains
 *    exactly one `fetch` listener alongside the `install`/`activate`/
 *    `skipWaiting`/`clients.claim` handlers. A 0-byte or handler-less file
 *    is the regression to watch for; the exit code will not tell you.
 *
 *  - `resolve.conditions` STARTS WITH `"source"`, matching this app's
 *    `vitest.config.ts`, so `@statewalker/*` workspace packages resolve
 *    against their TypeScript source rather than a possibly-unbuilt
 *    `dist/`. It does not reach `./sw-worker` (imported by `sw.ts`), whose
 *    export map offers no `"source"` condition -- that one still needs
 *    `@statewalker/webrun-http-browser`'s `dist/` built, exactly as
 *    `src/browser/edge.ts`'s own `./sw` import does.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pageRoot = fileURLToPath(new URL("./src/pages/app/", import.meta.url));

export default defineConfig({
  root: pageRoot,
  base: "./",
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist/app", import.meta.url)),
    emptyOutDir: true,
    // `rolldownOptions`, NOT the deprecated `rollupOptions` alias -- this
    // vite version's own type declares `rollupOptions` `@deprecated` and it
    // silently drops fields `rolldownOptions` accepts, `treeshake` among
    // them (Task 12's finding; the distinction is load-bearing here).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./src/pages/app/index.html", import.meta.url)),
        sw: fileURLToPath(new URL("./src/pages/app/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
      treeshake: false,
    },
  },
  server: {
    port: 5175,
    fs: {
      // pnpm's workspace layout symlinks sibling packages; the umbrella
      // repo root (four levels up from this app's package root) is the
      // shallowest ancestor that covers every `@statewalker/*` source tree
      // this build's `"source"` resolution condition reaches into.
      allow: [fileURLToPath(new URL("../../../../", import.meta.url))],
    },
  },
});
