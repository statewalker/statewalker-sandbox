// The bundler Worker: bundleTool with esbuild-wasm, in its own isolate. The Agent loads it
// through the Worker Loader only when a tool is to be bundled (src/tools/bundler-client.ts),
// with esbuild.wasm (about 14 MB) fetched from the deployment's BUNDLER_WASM_URL, so the main
// Worker carries neither and no other cell compiles esbuild. scripts/build-bundler.mjs builds
// this file into src/bundler/program.gen.js (the code, the wasm's SHA-256, Node's builtin names).
//
// It runs no code it is given: the sources are parsed, transformed and returned as a bundle,
// which the Agent then checks and admits like any other.

import { WorkerEntrypoint } from "cloudflare:workers";
import * as esbuild from "esbuild-wasm/lib/browser.js";
import { bundleTool } from "../tools/bundle.ts";
import type { CheckedBundleRequest } from "../tools/bundle-request.ts";
import wasmModule from "./esbuild.wasm";

// Node's builtin export names, recorded at build time (see builtinExportNames).
declare const __CAPFS_BUILTIN_NAMES__: Record<string, string[]>;

// esbuild-wasm's in-thread mode reads the globals through `self`, which a Worker has; a
// Worker Loader isolate on cellb's Node host is a worker thread without it. This isolate holds
// only the bundler, so the alias is its own.
const g = globalThis as { self?: unknown };
if (typeof g.self === "undefined") g.self = globalThis;

const ready = esbuild.initialize({ wasmModule, worker: false });

export default class Bundler extends WorkerEntrypoint {
  async bundle(req: CheckedBundleRequest) {
    await ready;
    const out = await bundleTool({
      esbuild,
      sources: req.sources,
      entry: req.entry,
      config: req.config,
      builtinNames: __CAPFS_BUILTIN_NAMES__,
    });
    return { code: out.code, hash: out.hash, check: out.check };
  }
}
