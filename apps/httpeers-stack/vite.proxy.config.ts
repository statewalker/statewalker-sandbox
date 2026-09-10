/**
 * Builds the proxy page (plan Task 4) to `dist/proxy` -- its own origin, at
 * the port `./src/ports.ts`'s `PROXY_PAGE_PORT` (5178) reserves for it.
 *
 * TWO ENTRIES, ONE OF THEM NAMED EXACTLY `sw.js`. `src/pages/proxy/sw.ts`
 * must build to `dist/proxy/sw.js` with no hash: that exact filename is what
 * `../../browser/edge.ts` registers and what the static server's `swFile`
 * default expects, and a ServiceWorker registered from a HASHED path would
 * stop matching the moment a rebuild changed the hash. `main.ts`/`index.html`
 * get the ordinary hashed-asset treatment.
 *
 * `resolve.conditions` STARTS WITH `"source"` -- matching this app's own
 * `vitest.config.ts` and `vite.image-peer.config.ts` -- so `@statewalker/*`
 * workspace packages resolve against their TypeScript source rather than a
 * possibly-unbuilt `dist/`. It does NOT reach `./sw-worker` (imported by
 * `sw.ts`), whose export map offers no `"source"` condition at all -- that one
 * still needs `webrun-http-browser`'s `dist/` built.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pageRoot = fileURLToPath(new URL("./src/pages/proxy/", import.meta.url));

export default defineConfig({
  root: pageRoot,
  base: "./",
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist/proxy", import.meta.url)),
    emptyOutDir: true,
    // `rolldownOptions`, NOT the deprecated `rollupOptions` alias -- see
    // `treeshake` below for why that distinction is load-bearing here.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./src/pages/proxy/index.html", import.meta.url)),
        sw: fileURLToPath(new URL("./src/pages/proxy/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
      // `sw.ts`'s ENTIRE job is `import "@statewalker/webrun-http-browser/sw-worker"`
      // for that module's side effect (`startHttpDispatcher(...)`, run at top
      // level). With this vite's default tree-shaking that entry built to a
      // literal 0-byte file -- the exact silent failure a ServiceWorker with
      // no handlers produces (registers fine, intercepts nothing). Measured on
      // the image peer, not assumed: `treeshake: { moduleSideEffects: true }`
      // did NOT fix it, and neither did that option under the deprecated
      // `rollupOptions` alias. Only disabling tree-shaking outright produces a
      // `sw.js` containing the real `startHttpDispatcher` call. See
      // `vite.image-peer.config.ts` for the full finding.
      treeshake: false,
    },
  },
  server: {
    port: 5178,
    fs: {
      // pnpm's workspace layout symlinks sibling packages; the umbrella repo
      // root (four levels up from this app's package root) is the shallowest
      // ancestor covering every `@statewalker/*` source tree this build's
      // `"source"` resolution condition reaches into.
      allow: [fileURLToPath(new URL("../../../../", import.meta.url))],
    },
  },
});
