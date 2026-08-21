import { defineConfig } from "vitest/config";

/**
 * The gap report: an implementation measured against the spec. Expected to be red
 * until §13's reconciliation is done — each failure is a divergence with a number.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.gap.test.ts"],
    globals: false,
    testTimeout: 30_000,
  },
});
