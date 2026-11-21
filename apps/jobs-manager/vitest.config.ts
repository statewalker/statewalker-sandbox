import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    globalSetup: ["test/global-setup.ts"],
    // Real child processes and HTTP servers; two tests stream a 30 s job and set their own timeout.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    conditions: ["source", "import", "module", "default"],
  },
});
