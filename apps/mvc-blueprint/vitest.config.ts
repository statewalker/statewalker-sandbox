import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The three layers, addressed by alias. B0's boundary suite polices them, so
 * these aliases are the seam under test, not a convenience.
 */
export const alias = {
  "@todo/core": r("./lib/todo-core/src/index.ts"),
  "@todo/app": r("./lib/todo-app/src/index.ts"),
  "@todo/ui": r("./lib/todo-ui/src/index.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    name: "node",
    environment: "node",
    include: ["*/tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
