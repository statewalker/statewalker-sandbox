import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    globals: false,
    // Flue's attachment-store contract suite writes a payload larger than one persisted
    // chunk: ~1.4s locally, ~9s on a GitHub runner. Its tests cannot carry their own timeout.
    testTimeout: 30_000,
  },
});
