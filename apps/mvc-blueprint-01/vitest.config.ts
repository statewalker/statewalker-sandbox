import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { aliasFor, type SignalsImpl } from "./aliases.js";

/**
 * What a node suite may never load: React, React DOM, and the kit that renders
 * with them — by bare name or any subpath (`react/jsx-runtime`,
 * `react-dom/client`).
 */
const REACT_STACK = /^(react|react-dom|@statewalker\/ui\.view\.shadcn)(\/.*)?$/;

/**
 * "Headless stays headless", made a fact of the run rather than of a grep.
 * B0 checks what a node suite IMPORTS by name; this checks what it LOADS —
 * which is what a relative import of `src/app.ts` (or any module that reaches
 * the React views) actually does. Resolution fails at import, naming the
 * specifier, the importer and the rule.
 *
 * It sees only what Vite resolves: this app's sources, its suites and their
 * direct specifiers. A package in node_modules that imported React on its own
 * would be loaded by Node, not by Vite, and would not be caught — none of this
 * project's headless dependencies does.
 */
const headless = (): Plugin => ({
  name: "mvc-blueprint-01:headless",
  enforce: "pre",
  resolveId(source, importer) {
    if (!REACT_STACK.test(source)) return null;
    throw new Error(
      `headless stays headless: "${source}" was loaded by ${importer ?? "a node suite"}. ` +
        "The node project (vitest.config.ts) refuses React, react-dom and @statewalker/ui.view.shadcn — " +
        "take the view layer as @todo/ui/adapter, or move the suite to a .test.tsx browser suite.",
    );
  },
});

const NODE_SUITES = "tests/**/*.test.ts";
const BROWSER_SUITES = ["tests/B5-*/**/*.test.tsx", "tests/B6-*/**/*.test.tsx"];

/**
 * One node project per signals implementation. `node:alien` runs every node
 * suite; `node:preact` runs the rungs whose behaviour depends on the library
 * (B1–B4). B0 reads files, the contract suite imports both implementations
 * itself, and B6's node half builds the app through `deps.ts` — each runs once.
 * `provide` is what `signals-binding` checks, proving the alias took effect.
 */
const nodeProject = (signals: SignalsImpl, exclude: string[]) => ({
  plugins: [headless()],
  resolve: { alias: aliasFor(signals) },
  test: {
    name: `node:${signals}`,
    environment: "node" as const,
    include: [NODE_SUITES],
    exclude: ["**/node_modules/**", "**/dist/**", ...BROWSER_SUITES, ...exclude],
    provide: { signals },
  },
});

export default defineConfig({
  test: {
    projects: [
      nodeProject("alien", []),
      nodeProject("preact", [
        "tests/B0-boundaries/**",
        "tests/B1-models/signals-contract.test.ts",
        "tests/B6-app/**",
      ]),
    ],
  },
});
