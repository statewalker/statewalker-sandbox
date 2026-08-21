import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // The gap report is a MEASUREMENT of an implementation against the spec, not a
    // regression suite. Leaving it in the default run makes `pnpm test` permanently
    // red, and a permanently-red suite is one that gets disabled. Run it with
    // `pnpm report:gap`.
    exclude: ["**/node_modules/**", "tests/**/*.gap.test.ts"],
    globals: false,
    // Biscuit's first authorization in a process costs ~30 ms of warm-up and the
    // suite mints real Ed25519 keys per fixture. Generous, but still short enough
    // that a hang fails rather than stalls.
    testTimeout: 30_000,
  },
});
