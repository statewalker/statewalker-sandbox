import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["[0-9][0-9]-*/tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "coverage"],
    testTimeout: 30_000,
  },
});
