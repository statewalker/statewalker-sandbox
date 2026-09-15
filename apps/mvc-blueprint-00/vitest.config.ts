import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { alias } from "./aliases.js";

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
  name: "mvc-blueprint-00:headless",
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

export default defineConfig({
  plugins: [headless()],
  resolve: { alias },
  test: {
    name: "node",
    environment: "node",
    include: ["tests/*/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/B5-*/**/*.test.tsx",
      "tests/B6-*/**/*.test.tsx",
    ],
  },
});
