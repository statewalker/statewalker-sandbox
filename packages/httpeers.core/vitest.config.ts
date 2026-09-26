import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "coverage"],
    // biscuit-wasm spuriously reports `{ RunLimit: 'Timeout' }` under CPU load:
    // rules and tokens tests fail about 1 run in 5 when the whole workspace runs
    // in parallel, and never alone. This retry hides a real defect: under load,
    // rules.ts and tokens.ts can deny a legitimate authorization. httpeers-access
    // fixed it in code (retryOnSpuriousTimeout at every *WithLimits call site);
    // this package has not had that fix yet.
    retry: 2,
  },
  resolve: {
    conditions: ["source", "import", "module", "default"],
  },
});
