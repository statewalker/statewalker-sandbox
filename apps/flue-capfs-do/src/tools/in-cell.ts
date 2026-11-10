// Bundling inside the Agent cell: esbuild-wasm (compiled once per isolate from the imported
// esbuild.wasm, run in the same thread) behind bundleTool, so a caller can send a tool's
// Node-style sources instead of a bundle built elsewhere. What comes out is a bundle like any
// other: the Agent runs the acceptance check and the deployment's policy on it (on cellb only
// approved hashes run, wherever the bundle was built).
//
// esbuild.wasm is about 14 MB: it is part of the Worker (and of cellb's browser build).

import wasmModule from "esbuild-wasm/esbuild.wasm";
import * as esbuild from "esbuild-wasm/lib/browser.js";
import { type BundledTool, bundleTool } from "./bundle.ts";
import type { ToolBundleConfig, ToolBundleOverrides } from "./config.ts";

export interface InCellBundleRequest {
  /** The tool's sources by path: { "/index.ts": "…", "/lib/x.js": "…" }. */
  sources: Record<string, string>;
  /** The tool module ("/index.ts"): it exports run(input) or a default function. */
  entry: string;
  /** Build-side overrides (which modules are shimmed, defines, process.env). */
  config?: ToolBundleOverrides;
}

const MAX_FILES = 200;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
/** What a caller may change: how modules are rewritten, not what the run side accepts. */
const BUILD_KEYS = ["fsModules", "pathModules", "builtins", "modules", "define", "processEnv"];

let ready: Promise<void> | undefined;
function initialized(): Promise<void> {
  // esbuild-wasm's in-thread mode reads the globals through `self` (also later, lazily).
  // workerd and browsers have it; cellb on Node does not, so it gets the same alias there.
  const g = globalThis as { self?: unknown };
  if (typeof g.self === "undefined") g.self = globalThis;
  ready ??= esbuild.initialize({ wasmModule, worker: false }).catch((e: unknown) => {
    ready = undefined; // a later call may try again
    throw e;
  });
  return ready;
}

/**
 * Bundles a tool in this cell. `deployment` is the run-side config (TOOL_BUNDLE): the caller's
 * overrides apply to build-side keys only, so `external`, the check and the policy stay the
 * deployment's.
 */
export async function bundleInCell(
  req: InCellBundleRequest,
  deployment: ToolBundleConfig,
): Promise<BundledTool> {
  const sources = req?.sources;
  if (!sources || typeof sources !== "object" || Array.isArray(sources))
    throw new Error("EINVAL: bundle: sources is an object of path → source");
  const entries = Object.entries(sources);
  if (entries.length === 0 || entries.length > MAX_FILES)
    throw new Error(`EINVAL: bundle: 1 to ${MAX_FILES} source files`);
  let size = 0;
  for (const [path, src] of entries) {
    if (!/^\/[A-Za-z0-9._@/-]+$/.test(path) || path.split("/").includes(".."))
      throw new Error(`EINVAL: bundle: bad source path '${path}'`);
    if (typeof src !== "string") throw new Error(`EINVAL: bundle: '${path}' is not text`);
    size += src.length;
  }
  if (size > MAX_SOURCE_BYTES) throw new Error("EINVAL: bundle: sources are too large");
  if (typeof req.entry !== "string" || !Object.hasOwn(sources, req.entry.replace(/^\/?/, "/")))
    throw new Error("EINVAL: bundle: entry must name one of the sources");
  const overrides: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.config ?? {}))
    if (BUILD_KEYS.includes(k)) overrides[k] = v;
    else throw new Error(`EINVAL: bundle: '${k}' is the deployment's to set`);

  await initialized();
  const out = await bundleTool({
    esbuild,
    sources,
    entry: req.entry,
    config: { ...deployment, ...overrides } as ToolBundleOverrides,
  });
  if (out.code.length > MAX_OUTPUT_BYTES)
    throw new Error("EINVAL: bundle: the bundle is too large");
  return out;
}
