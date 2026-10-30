import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Both files are whole-stack runs (Chromium, a relay, a page build, Docker):
    // one at a time, so neither starves the other's 30 s waits.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
