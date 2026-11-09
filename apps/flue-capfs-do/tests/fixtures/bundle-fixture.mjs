// Bundles tests/fixtures/todo-tool.ts the way the scenario suite does; the same input gives the
// same bundle, so its hash can be approved before the runtime starts.
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";
import { bundleTool } from "../../src/tools/bundle.ts";

export const bundleTodoTool = () =>
  bundleTool({
    esbuild,
    entry: "/index.ts",
    sources: { "/index.ts": readFileSync(new URL("./todo-tool.ts", import.meta.url), "utf8") },
  });
