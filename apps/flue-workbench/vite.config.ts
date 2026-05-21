import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./",
  resolve: {
    // just-bash's `browser` export condition resolves to a stripped bundle
    // that doesn't re-export `decodeBytesToUtf8` (which `@just-bash/executor`
    // imports). Globally omit the `browser` condition so the universal bundle
    // is picked instead. Bundle-size cost is ~30KB gz — acceptable for v1.
    conditions: ["module", "import", "default"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      // @just-bash/executor declares @executor-js/sdk as an optional peer dep
      // (it's only loaded when `config.setup` is supplied). We use inline tools
      // only, so the import paths are dead branches. Mark them external so the
      // build doesn't fail trying to resolve them.
      external: [/^@executor-js\/sdk/],
    },
  },
  server: {
    port: 5173,
  },
});
