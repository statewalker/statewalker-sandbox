// Bundle a tool for the Agent's `tool` task (with `bundled: true`).
//   node scripts/bundle-tool.mjs <dir> [--entry /index.ts] [--config overrides.json] [--out tool.bundle.js]
// <dir> holds the tool's sources (and its node_modules, if any). The defaults come from
// tool-bundle.config.json; --config overrides them for this bundle. The acceptance check the
// Agent runs is run here too: the command fails if the bundle would be rejected.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import * as esbuild from "esbuild";
import { bundleTool } from "../src/tools/bundle.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    entry: { type: "string", default: "/index.ts" },
    config: { type: "string" },
    out: { type: "string" },
    minify: { type: "boolean", default: false },
  },
});
if (positionals.length !== 1) {
  console.error(
    "usage: bundle-tool.mjs <dir> [--entry /index.ts] [--config overrides.json] [--out file]",
  );
  process.exit(2);
}
const files = new NodeFilesApi({ rootDir: resolve(positionals[0]) });
const config = values.config ? JSON.parse(readFileSync(values.config, "utf8")) : undefined;
const out = await bundleTool({
  esbuild,
  files,
  root: "/",
  entry: values.entry,
  config,
  minify: values.minify,
});
if (!out.check.ok) {
  console.error(`rejected by the acceptance check:\n  ${out.check.problems.join("\n  ")}`);
  process.exit(1);
}
if (values.out) writeFileSync(values.out, out.code);
else process.stdout.write(out.code);
