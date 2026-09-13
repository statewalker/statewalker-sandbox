/**
 * The fixture build: the page, and the one-line ServiceWorker beside it.
 *
 * `rolldownOptions` + `treeshake: false`, both load-bearing, for the reason
 * rung 02 documents at length: `@statewalker/webrun-http-browser` declares
 * `"sideEffects": false`, so the bare `import ".../sw-worker"` that IS the
 * worker's whole job is legally tree-shaken away — and `rollupOptions` is
 * accepted while its `treeshake` field is SILENTLY DROPPED. The result is a
 * worker that registers, activates, installs no `fetch` listener, and never
 * claims the page; `SwHttpAdapter.start()` then waits forever.
 *
 * The worker must land at `/sw-worker.js` unhashed, because that is
 * `HostedSiteBuilder`'s default service worker URL.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildFixture(outDir: string): Promise<void> {
  await buildSite(outDir);
  await buildProbe(resolve(outDir, "probe-app"));
}

async function buildSite(outDir: string): Promise<void> {
  await build({
    root: here,
    logLevel: "warn",
    build: {
      target: "esnext",
      outDir,
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          index: resolve(here, "index.html"),
          "sw-worker": resolve(here, "sw-worker.ts"),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "sw-worker" ? "sw-worker.js" : "assets/[name]-[hash].js",
        },
        treeshake: false,
      },
    },
  });
}

/**
 * The abort probe, built into its own directory so it gets its own
 * ServiceWorker SCOPE. Two workers claiming `/` would replace one another,
 * and the site rung's answers would then depend on test ordering.
 */
async function buildProbe(outDir: string): Promise<void> {
  const root = resolve(here, "probe");
  await build({
    root,
    base: "./",
    logLevel: "warn",
    build: {
      target: "esnext",
      outDir,
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          index: resolve(root, "index.html"),
          "probe-worker": resolve(root, "probe-worker.ts"),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "probe-worker" ? "probe-worker.js" : "assets/[name]-[hash].js",
        },
        treeshake: false,
      },
    },
  });
}
