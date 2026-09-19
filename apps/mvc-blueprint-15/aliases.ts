import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * ONE alias table for the build and both test configs. Every importable module is a folder with
 * an `index.ts`: `@kernel`, `@kit/<name>`, `@b/<bundle>[/<sub-module>]`.
 */
export const alias = [
  { find: /^@kernel$/, replacement: r("./src/kernel/index.ts") },
  { find: /^@kit\/(.+)$/, replacement: `${r("./src/kits/")}$1/index.ts` },
  { find: /^@b\/(.+)$/, replacement: `${r("./src/bundles/")}$1/index.ts` },
];

/**
 * React and Solid in one build: both compile `.tsx`. Solid owns the `.tsx` files of every folder
 * named `solid` or `<something>.solid` (`kits/solid`, `shell.solid`, `jr.solid`); React owns the rest.
 */
export const SOLID_TSX = /\/(?:[^/]*\.)?solid\/[^/]*\.tsx$/;
