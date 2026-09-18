import { defineConfig } from "vitest/config";

/** Node project: kernel, bundles headless, boundaries. React is refused here by the boundary suite, not by config. */
export default defineConfig({
  test: {
    name: "node",
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
