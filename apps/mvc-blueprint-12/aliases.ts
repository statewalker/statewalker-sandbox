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
  { find: /^@features\/(.+)$/, replacement: `${r("./src/features/")}$1.ts` },
];

/** The same table over P0's sources (`../mvc-blueprint-04`) — the glitch test runs against both. */
export const aliasP0 = [
  { find: /^@kernel$/, replacement: r("../mvc-blueprint-04/src/kernel/index.ts") },
  { find: /^@kit\/(.+)$/, replacement: `${r("../mvc-blueprint-04/src/kits/")}$1/index.ts` },
  { find: /^@b\/(.+)$/, replacement: `${r("../mvc-blueprint-04/src/bundles/")}$1/index.ts` },
  { find: /^@features\/(.+)$/, replacement: `${r("../mvc-blueprint-04/src/features/")}$1.ts` },
];
