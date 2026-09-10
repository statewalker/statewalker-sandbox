import { defineConfig } from "vite";

// The @statewalker/webrun-* packages publish TypeScript source
// (`exports: { ".": "./src/index.ts" }`), which Vite compiles happily and
// plain Node refuses. That asymmetry is why the browser build needs no
// special handling here and the Node harness has to bundle first — see the
// README's note on packaging.
//
// `outDir` is `dist-web` because `dist-node` holds the esbuild output for the
// Node harness, and Vite empties its output directory on every build. Sharing
// one `dist` means each build silently deletes the other's output.
export default defineConfig({
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { target: "es2022", outDir: "dist-web" },
});
