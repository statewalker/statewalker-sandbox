import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The three source roots are resolved by alias, not by pnpm: the ladder is one
// app package, and the boundary between `@fm/core`, `@fm/app` and `@fm/ui` is
// enforced by `test/boundaries.test.ts` instead. The same three entries exist in
// `tsconfig.json` under `paths` — if the two ever disagree, `vitest run` and
// `tsc --noEmit` disagree with them, which is worse than either being wrong.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "fm-*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
  resolve: {
    alias: {
      "@fm/core": root("./src/core/index.ts"),
      "@fm/app": root("./src/app/index.ts"),
      "@fm/ui": root("./src/ui/index.ts"),
    },
  },
});
