import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: ["node_modules", "dist", "coverage"],
  },
  resolve: {
    conditions: ["source", "import", "module", "default"],
  },
});
