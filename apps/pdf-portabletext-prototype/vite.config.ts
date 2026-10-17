import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * pdf.js loads decoders (JPX/JBIG2 wasm), CMaps, standard fonts and ICC
 * profiles at runtime from directory URLs. Serve them under `pdfjs/` in dev
 * and copy them into the build.
 */
function pdfjsResources(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const dirs = ["wasm", "cmaps", "standard_fonts", "iccs"];
  // Sanity check that the directories exist in this pdf.js version.
  for (const dir of dirs) statSync(join(root, dir));
  return {
    name: "pdfjs-resources",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/\/pdfjs\/([\w-]+)\/([\w.-]+)$/);
        const file = match && dirs.includes(match[1]) ? join(root, match[1], match[2]) : null;
        if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of readdirSync(join(root, dir))) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: readFileSync(join(root, dir, name)),
          });
        }
      }
    },
  };
}

const tesseractDist = join(dirname(createRequire(import.meta.url).resolve("tesseract-wasm")));

export default defineConfig({
  base: "./",
  resolve: {
    // tesseract-wasm does not export its .wasm files; reach them directly.
    alias: [{ find: /^tesseract-wasm\/dist\/(.*)$/, replacement: `${tesseractDist}/$1` }],
  },
  plugins: [pdfjsResources()],
  worker: { format: "es" },
  // tesseract-wasm resolves its .wasm next to itself; we pass the binary explicitly.
  optimizeDeps: { exclude: ["tesseract-wasm"] },
  server: { port: 5181 },
});
