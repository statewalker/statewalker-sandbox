import { defineConfig } from "vitest/config";

// happy-dom is the default because most rungs render into a DOM. The rungs that
// do not (04 manifest generation, 08 biscuit, Z schema derivation) are unaffected
// by a document being present, so one environment for the whole app is simpler
// than a per-rung override.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["**/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
