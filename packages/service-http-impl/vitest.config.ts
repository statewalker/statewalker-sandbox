import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "coverage"],
    // Real WebSocket servers: ~1.2s locally, over vitest's 5s default on a GitHub runner.
    testTimeout: 30_000,
  },
  resolve: {
    conditions: ["source", "import", "module", "default"],
  },
});
