import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    globals: false,
    /**
     * These are build-integration tests: each one drives `newProjectBuild` over a
     * MemFilesApi project, which runs Tailwind and the module builder for real.
     * Measured at 21-34 s per test on a warm machine, against vitest's 5 s default —
     * so every one of them timed out the first time they were ever run. They had
     * never run before, because this app could not install until its `catalog:`
     * entries existed.
     *
     * 120 s is ~4x the slowest observed case: enough headroom for a cold cache or a
     * slower machine, and still short enough that a genuine hang fails the suite
     * rather than stalling CI.
     */
    testTimeout: 120_000,
  },
});
