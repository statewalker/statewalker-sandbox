// Builds everything a browser needs to run this project on cellb:
//   dist/cellb/            the Worker project (`cellb build`: wrangler.json, worker.js)
//   dist/browser/          index.html, page.js, cells-worker.js (cellb's browser runtime + SQLite
//                          on OPFS), isolate-worker.js (Worker Loader code, one Worker each)
// The Python engine (src/python/engine.mjs) and Pyodide are served as they are (serve-browser).
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProject } from "@statewalker/cellb/node";
import * as esbuild from "esbuild";

const dir = fileURLToPath(new URL("..", import.meta.url));
const out = `${dir}dist`;

/** `vars` are added to the built project's wrangler.json (cellb in a browser reads vars from it). */
export async function buildBrowser({ quiet = false, vars = {} } = {}) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(`${out}/browser`, { recursive: true });
  await buildProject(dir, `${out}/cellb`);
  if (Object.keys(vars).length) {
    const file = `${out}/cellb/wrangler.json`;
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.vars = { ...config.vars, ...vars };
    writeFileSync(file, JSON.stringify(config, null, 2));
  }
  await esbuild.build({
    entryPoints: {
      "cells-worker": `${dir}browser/cells-worker.ts`,
      page: `${dir}browser/page.ts`,
      "isolate-worker": "@statewalker/cellb/isolate-worker",
    },
    outdir: `${out}/browser`,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["browser"],
    logLevel: quiet ? "silent" : "warning",
  });
  cpSync(`${dir}browser/index.html`, `${out}/browser/index.html`);
  if (!quiet) console.log(`built ${out}/cellb and ${out}/browser`);
}

if (import.meta.url === `file://${process.argv[1]}`) await buildBrowser();
