/**
 * Builds the hub page (Task 24) to `dist/hub` -- the directory
 * `../static-server/main.ts`'s `DEFAULT_HUB_PAGE_DIST_DIR` already expects,
 * at the port that module's `HUB_PAGE_PORT` (5177) already reserves.
 *
 * Structurally identical to `vite.image-peer.config.ts`, and deliberately
 * so: both findings that config records were paid for once and apply here
 * unchanged.
 *
 * TWO ENTRIES, ONE OF THEM NAMED EXACTLY `sw.js`. `src/pages/hub/sw.ts`
 * must build to `dist/hub/sw.js` with no hash -- the static server's own
 * `swFile` default, and the exact filename `Service-Worker-Allowed`
 * matters for (a ServiceWorker registered from a HASHED path would still
 * work, but would silently stop matching this config's own assumption, and
 * every other page in this stack, the moment a rebuild changed the hash).
 * `main.ts`/`index.html` get the ordinary hashed-asset treatment.
 *
 * `resolve.conditions` STARTS WITH `"source"` — matching this app's own
 * `vitest.config.ts` and both sibling page configs — so `@statewalker/*`
 * workspace packages resolve against their TypeScript source rather than a
 * possibly-unbuilt `dist/`. This sidesteps
 * `@statewalker/webrun-http-browser`'s main `"."`/`"./sw"` exports (no
 * `dist/` committed, see `src/browser/edge.ts`'s module comment) for THIS
 * build; it does NOT reach `./sw-worker` (imported by `sw.ts`), whose
 * export map offers no `"source"` condition at all (a ready-built runtime
 * script, not a TS module) -- that one still needs
 * `webrun-http-browser`'s `dist/` built.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pageRoot = fileURLToPath(new URL("./src/pages/hub/", import.meta.url));

export default defineConfig({
  root: pageRoot,
  base: "./",
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist/hub", import.meta.url)),
    emptyOutDir: true,
    // `rolldownOptions`, NOT the deprecated `rollupOptions` alias -- see
    // `treeshake` below for why this distinction is load-bearing here, not
    // cosmetic.
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL("./src/pages/hub/index.html", import.meta.url)),
        sw: fileURLToPath(new URL("./src/pages/hub/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
      // `sw.ts`'s ENTIRE job is `import "@statewalker/webrun-http-browser/sw-worker"`
      // for that module's side effect (`startHttpDispatcher(...)`, run at
      // top level). With this vite version's default (rolldown-backed)
      // tree-shaking, that built to a literal 0-byte file for the image
      // peer -- the exact silent failure a ServiceWorker script with no
      // handlers produces (registers fine, intercepts nothing).
      // `treeshake: { moduleSideEffects: true }` did NOT fix it there, and
      // neither did that option under the deprecated `rollupOptions.treeshake`
      // (which silently drops fields `rolldownOptions` accepts). Only
      // disabling tree-shaking outright produced a real `sw.js`. Carried
      // here rather than re-derived: the same entry, the same bundler, the
      // same outcome -- and verified again by reading THIS build's output,
      // not assumed from the sibling's.
      treeshake: false,
    },
  },
  server: {
    port: 5177,
    fs: {
      // pnpm's workspace layout symlinks sibling packages; the umbrella
      // repo root (four levels up from this app's package root) is the
      // shallowest ancestor that covers every `@statewalker/*` source tree
      // this build's `"source"` resolution condition reaches into.
      allow: [fileURLToPath(new URL("../../../../", import.meta.url))],
    },
  },
});
