/**
 * HOST build harness.
 *
 * Runs the no-bundle pipeline: `newProjectBuild` scans the guest sources under
 * `src/` (a NodeFilesApi) and emits a static `.js` tree into `dist/` (another
 * NodeFilesApi). The browser then loads `dist/~/main.js` as a plain ES module —
 * no bundler, no CDN. See serve.ts + index.html for how it is served.
 */
import { fileURLToPath } from "node:url";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { newProjectBuild } from "@statewalker/webrun-modules-build";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const project = new NodeFilesApi({ rootDir: here("./src") });
const cache = new NodeFilesApi({ rootDir: here("./dist") });

console.log("Building guest (src → dist) …");
const { served } = await newProjectBuild({ project, cache }).build();

console.log(`\nEmitted ${served.length} entry pointer(s):`);
for (const url of served) console.log(`  ${url}`);
console.log("\nDone. Run `pnpm serve` and open http://localhost:8899");
