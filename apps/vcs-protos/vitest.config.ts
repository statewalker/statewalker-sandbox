import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["[0-9][0-9]-*/tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "coverage", "**/*.browser.test.ts"],
    // --expose-gc: R4b samples memory after forced collections to catch retained references.
    execArgv: ["--expose-gc"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    conditions: ["source", "import", "module", "default"],
  },
});
