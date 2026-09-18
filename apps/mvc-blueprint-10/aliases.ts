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
