import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The three layers, addressed by alias. B0's boundary suite polices them, so
 * these aliases are the seam under test, not a convenience.
 */
export const alias = {
  // Before "@todo/app": Vite matches string aliases by PREFIX in declaration
  // order, so the other way round "@todo/app/models" resolves to
  // ".../index.ts/models".
  "@todo/app/models": r("./lib/todo-app/src/models.ts"),
  "@todo/core": r("./lib/todo-core/src/index.ts"),
  "@todo/app": r("./lib/todo-app/src/index.ts"),
  // Before "@todo/ui", for the same prefix reason. The adapter's own entry:
  // the bus-facing half of the view layer, with no React in its import graph,
  // so a headless suite can take it without loading react-dom and the kit.
  "@todo/ui/adapter": r("./lib/todo-ui/src/view-adapter.ts"),
  "@todo/ui": r("./lib/todo-ui/src/index.ts"),
};

export default defineConfig({
  resolve: { alias },
  test: {
    name: "node",
    environment: "node",
    include: ["*/tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "B5-*/tests/**/*.test.tsx",
      "B6-*/tests/**/*.test.tsx",
    ],
  },
});
