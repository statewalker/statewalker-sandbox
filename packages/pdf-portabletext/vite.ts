import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/**
 * Vite plugin for apps using `@statewalker/pdf-portabletext`.
 *
 * - pdf.js loads decoders (JPX/JBIG2 wasm), CMaps, standard fonts and ICC
 *   profiles at runtime from directory URLs: they are served under
 *   `<base>pdfjs/` in dev and copied into the build (see `resourceBaseUrl`
 *   in `openPdf`).
 * - tesseract-wasm does not export its `.wasm` files: an alias makes them
 *   importable with `?url`.
 */
export function pdfPortableText(): Plugin {
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const tesseractDist = dirname(require.resolve("tesseract-wasm"));
  const dirs = ["wasm", "cmaps", "standard_fonts", "iccs"];
  for (const dir of dirs) statSync(join(pdfjsRoot, dir));
  return {
    name: "pdf-portabletext",
    config() {
      return {
        resolve: {
          alias: [{ find: /^tesseract-wasm\/dist\/(.*)$/, replacement: `${tesseractDist}/$1` }],
        },
        worker: { format: "es" },
        // tesseract-wasm resolves its .wasm next to itself; the worker passes the binary explicitly.
        optimizeDeps: { exclude: ["tesseract-wasm"] },
      };
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/\/pdfjs\/([\w-]+)\/([\w.-]+)$/);
        const file = match && dirs.includes(match[1]) ? join(pdfjsRoot, match[1], match[2]) : null;
        if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const name of readdirSync(join(pdfjsRoot, dir))) {
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: readFileSync(join(pdfjsRoot, dir, name)),
          });
        }
      }
    },
  };
}
