import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["source", "browser", "import", "module", "default"],
  },
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    // The UI tests render whole prototypes in jsdom; under a loaded machine
    // (the repo's suites run in parallel) the 5 s default times out tests that pass.
    testTimeout: 20_000,
  },
});
