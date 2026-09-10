import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The three packages of the design, addressed the way the C-era rungs address
 * them. fm-core is Node-only and DOM-free; fm-app may hold models but no DOM;
 * fm-ui is the only one allowed a document. C0's `boundaries.test.ts` asserts
 * exactly that, so these aliases are the seam the boundary suite polices.
 */
export const alias = {
  "@fm/core": r("./lib/fm-core/src/index.ts"),
  "@fm/app": r("./lib/fm-app/src/index.ts"),
  "@fm/ui": r("./lib/fm-ui/src/index.ts"),
};

// Node is the default because the ladder was built to be Node-testable to the
// end of Phase C. The browser rungs live in vitest.browser.config.ts.
export default defineConfig({
  resolve: { alias },
  test: {
    name: "node",
    environment: "node",
    include: ["*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "D2b-browser-prototypes/**"],
  },
});
