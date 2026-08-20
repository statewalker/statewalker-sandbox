/**
 * Builds the image peer page (Task 12, design record §5.5) to
 * `dist/image-peer` -- the directory `../static-server/main.ts`'s
 * `DEFAULT_IMAGE_PEER_DIST_DIR` already expects, at the port that module's
 * `IMAGE_PEER_PORT` (5176) already reserves.
 *
 * TWO ENTRIES, ONE OF THEM NAMED EXACTLY `sw.js`. `src/pages/image-peer/sw.ts`
 * must build to `dist/image-peer/sw.js` with no hash -- the static server's
 * own `swFile` default, and the exact filename `Service-Worker-Allowed`
 * matters for (a ServiceWorker registered from a HASHED path would still
 * work, but would silently stop matching this config's own assumption, and
 * every other page in this stack, the moment a rebuild changed the hash).
 * `main.ts`/`index.html` get the ordinary hashed-asset treatment.
 *
 * `resolve.conditions` STARTS WITH `"source"` — matching this app's own
 * `vitest.config.ts` and `apps/byok-config-prototype/vite.config.ts`'s
 * precedent — so `@statewalker/*` workspace packages resolve against their
 * TypeScript source rather than a possibly-unbuilt `dist/`. This sidesteps
 * `@statewalker/webrun-http-browser`'s main `"."`/`"./sw"` exports (no
 * `dist/` committed, see `src/browser/edge.ts`'s module comment and Task
 * 11's report) for THIS build; it does NOT reach `./sw-worker` (imported by
 * `sw.ts`), whose export map offers no `"source"` condition at all (a
 * ready-built runtime script, not a TS module) -- that one still needs
 * `webrun-http-browser`'s `dist/` built, exactly as Task 11 already found
 * for `edge.ts`'s own `./sw` import.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pageRoot = fileURLToPath(new URL("./src/pages/image-peer/", import.meta.url));

export default defineConfig({
  root: pageRoot,
  base: "./",
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist/image-peer", import.meta.url)),
    emptyOutDir: true,
    // `rolldownOptions`, NOT the deprecated `rollupOptions` alias -- see
    // `treeshake` below for why this distinction is load-bearing here, not
    // cosmetic.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./src/pages/image-peer/index.html", import.meta.url)),
        sw: fileURLToPath(new URL("./src/pages/image-peer/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
      // `sw.ts`'s ENTIRE job is `import "@statewalker/webrun-http-browser/sw-worker"`
      // for that module's side effect (`startHttpDispatcher(...)`, run at
      // top level -- see `sw.ts`'s own doc comment). Verified directly, not
      // assumed: with `vite 8.2.1`'s default (rolldown-backed) tree-shaking,
      // `sw.js` built to a literal 0-byte file -- the exact silent failure a
      // ServiceWorker script with no handlers produces (registers fine,
      // intercepts nothing). `treeshake: { moduleSideEffects: true }` did
      // NOT fix it (tried first, still 0 bytes) -- neither did that same
      // option under the deprecated `rollupOptions.treeshake` (this vite
      // version's own type declares `rollupOptions` `@deprecated`, and it
      // silently drops fields `rolldownOptions` accepts, `treeshake` among
      // them). Only disabling tree-shaking OUTRIGHT for this build
      // (`treeshake: false`) produced a `sw.js` containing the real,
      // minified `startHttpDispatcher({ self, log: console.log })` call --
      // confirmed by reading the built output, not by file size alone. The
      // cost (marginally less aggressive dead-code elimination on the
      // `main` entry too, since `treeshake` is a build-wide option here) is
      // acceptable for a small reference/demo page and far cheaper than a
      // ServiceWorker that silently does nothing.
      treeshake: false,
    },
  },
  server: {
    port: 5176,
    fs: {
      // pnpm's workspace layout symlinks sibling packages; the umbrella
      // repo root (four levels up from this app's package root) is the
      // shallowest ancestor that covers every `@statewalker/*` source tree
      // this build's `"source"` resolution condition reaches into.
      allow: [fileURLToPath(new URL("../../../../", import.meta.url))],
    },
  },
});
