import { defineConfig } from "tsdown";

// Rolldown build (via tsdown): the library entry and the `jobs` CLI as ES modules for Node, with
// type declarations. Dependencies stay external; the CLI keeps its shebang.
export default defineConfig({
  entry: { index: "src/index.ts", web: "src/web.ts", cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node22",
  dts: { build: true },
  clean: true,
});
