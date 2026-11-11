import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/index.ts",
  external: [/^@statewalker\//],
  output: [
    { file: "dist/esm/index.js", format: "esm" },
    { file: "dist/cjs/index.cjs", format: "cjs" },
  ],
});
