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

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    alias: [
      // Match `just-bash` (the bare specifier) only — `just-bash/browser`,
      // `just-bash/something-else` etc. still resolve normally.
      { find: /^just-bash$/, replacement: justBashShim },
    ],
  },
  optimizeDeps: {
    // Pre-bundle the executor against our shim, so dev mode and prod use the
    // same resolution. Without this, `pnpm vite dev` may still pre-bundle
    // `@just-bash/executor`'s `import "just-bash"` against the default entry.
    include: ["@just-bash/executor"],
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
