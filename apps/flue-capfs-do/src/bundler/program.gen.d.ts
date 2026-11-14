// src/bundler/program.gen.js is written by scripts/build-bundler.mjs (pnpm build:bundler).
declare const program: {
  /** The bundler Worker's module (src/bundler/program.ts, bundled): imports ./esbuild.wasm. */
  code: string;
  /** SHA-256 (hex) of the esbuild.wasm it was built for: the fetched file must match it. */
  wasmSha256: string;
  esbuildVersion: string;
};
export default program;
