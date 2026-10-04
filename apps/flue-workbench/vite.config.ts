import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Absolute path to our just-bash shim. Aliased below so every `from "just-bash"`
// in the dependency graph (including @just-bash/executor's tool-command bridge)
// resolves to the shim, which re-exports `just-bash/browser` + a hand-rolled
// `decodeBytesToUtf8` (see the shim file for why).
const justBashShim = fileURLToPath(
  new URL("./src/lib-host/just-bash-browser-shim.ts", import.meta.url),
);

// `@flue/runtime@2` constructs an `AsyncLocalStorage` at module load; Vite's
// empty browser stub for `node:async_hooks` would crash the page before any
// code runs. See the shim file for why a synchronous-scope stand-in is enough.
//
// Flue's `@flue/runtime/node` entry (whose `start()` boots the runtime) also
// imports `node:sqlite`, `node:child_process`, `node:fs` and `node:path`, but
// only inside `sqlite()` / `local()`, which the workbench never calls (it
// passes its own FilesApi persistence and sandbox) — Vite's empty stubs are
// fine for those.
const asyncHooksShim = fileURLToPath(
  new URL("./src/lib-host/async-hooks-browser-shim.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: [
      // Match `just-bash` (the bare specifier) only — `just-bash/browser`,
      // `just-bash/something-else` etc. still resolve normally.
      { find: /^just-bash$/, replacement: justBashShim },
      { find: /^(node:)?async_hooks$/, replacement: asyncHooksShim },
    ],
  },
  optimizeDeps: {
    // Pre-bundle the executor against our shim, so dev mode and prod use the
    // same resolution. Without this, `pnpm vite dev` may still pre-bundle
    // `@just-bash/executor`'s `import "just-bash"` against the default entry.
    //
    // Also pre-bundle pi-ai's Gemini wire implementation: the provider's
    // `googleGenerativeAIApi()` loads it via a lazy `import()`. In dev, Vite
    // optimises those on first use, then refreshes the URL hash — any
    // in-flight call against an old hash crashes with `504 Outdated Optimize
    // Dep`. Listing it here forces pre-bundling at startup with a stable hash.
    include: ["@just-bash/executor", "@earendil-works/pi-ai/api/google-generative-ai"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      // @just-bash/executor declares @executor-js/sdk as an optional peer dep
      // (loaded only on the SDK discovery path). We use inline tools only, so
      // those imports are dead branches. Mark external so the build doesn't
      // try to resolve them.
      external: [/^@executor-js\/sdk/],
    },
  },
  server: {
    port: 5173,
  },
});
