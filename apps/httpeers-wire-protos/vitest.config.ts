import { defineConfig } from "vitest/config";

// Every suite here starts real libp2p nodes on loopback TCP, so the whole app runs
// with `--no-file-parallelism` (see package.json) exactly as the prototype's own
// manifest did. Tests sit beside the code in `src/` because that is where the Drive
// export put them, and adopting them byte-identically was the point of the rung.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // R2 pushes 8 MB through a circuit relay and B5 opens 40 concurrent streams;
    // both are well inside their own per-test timeouts, but the relay suite's
    // `beforeAll` polls for a reservation for up to 10s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
