import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);

/**
 * js-clipper (used by gutenye/ocr) ships a Latin-1 encoded file, which the
 * bundler rejects as invalid UTF-8: load it decoded as Latin-1.
 */
const latin1Files = {
  name: "pdf-portabletext:latin1",
  load(id: string) {
    if (/[\\/]js-clipper[\\/]clipper\.js$/.test(id)) return readFileSync(id, "latin1");
    return null;
  },
};

/**
 * Vite plugin for apps using `@statewalker/pdf-portabletext`.
 *
 * - pdf.js loads decoders (JPX/JBIG2 wasm), CMaps, standard fonts and ICC
 *   profiles at runtime from directory URLs: they are served under
 *   `<base>pdfjs/` in dev and copied into the build (see `resourceBaseUrl`
 *   in `openPdf`).
 * - tesseract-wasm does not export its `.wasm` files, nor gutenye's model
 *   package its ONNX models: aliases make them importable with `?url`.
 * - onnxruntime-web (PaddleOCR engine) loads its wasm at runtime: served under
 *   `<base>ort/` and copied into the build.
 */
export function pdfPortableText(): Plugin {
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const tesseractDist = dirname(require.resolve("tesseract-wasm"));
  const paddleModels = join(dirname(require.resolve("@gutenye/ocr-models/node")), "assets");
  const ortDist = dirname(require.resolve("onnxruntime-web"));
  // The default onnxruntime-web bundle loads the JSEP build; the plain one is kept
  // for the wasm-only entry point.
  const ortFiles = readdirSync(ortDist).filter((f) =>
    /^ort-wasm-simd-threaded(\.jsep)?\.(mjs|wasm)$/.test(f),
  );
  const dirs = ["wasm", "cmaps", "standard_fonts", "iccs"];
  for (const dir of dirs) statSync(join(pdfjsRoot, dir));
  return {
    name: "pdf-portabletext",
    config() {
      return {
        resolve: {
          alias: [
            { find: /^tesseract-wasm\/dist\/(.*)$/, replacement: `${tesseractDist}/$1` },
            { find: /^@gutenye\/ocr-models\/assets\/(.*)$/, replacement: `${paddleModels}/$1` },
          ],
        },
        // Workers are bundled with their own plugins: they need the Latin-1 loader too.
        worker: { format: "es", plugins: () => [latin1Files] },
        // tesseract-wasm resolves its .wasm next to itself; the worker passes the binary explicitly.
        optimizeDeps: {
          exclude: ["tesseract-wasm", "onnxruntime-web"],
          rolldownOptions: { plugins: [latin1Files] },
        },
      };
    },
    load: latin1Files.load,
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const ort = req.url?.match(/\/ort\/([\w.-]+)$/);
        if (ort && ortFiles.includes(ort[1])) {
          const type = ort[1].endsWith(".wasm") ? "application/wasm" : "text/javascript";
          res.setHeader("Content-Type", type);
          createReadStream(join(ortDist, ort[1])).pipe(res);
          return;
        }
        const match = req.url?.match(/\/pdfjs\/([\w-]+)\/([\w.-]+)$/);
        const file = match && dirs.includes(match[1]) ? join(pdfjsRoot, match[1], match[2]) : null;
        if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of ortFiles) {
        this.emitFile({
          type: "asset",
          fileName: `ort/${name}`,
          source: readFileSync(join(ortDist, name)),
        });
      }
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
