// Bundles a tool with webrun-bundler so that its `node:fs` (and every other Node builtin)
// is rewritten at build time, per the ToolBundleConfig:
//   fsModules   → one shared shim over the `files` capability  (option (a): inline, per bundle)
//   pathModules → a pure POSIX path
//   builtins    → "deny": a module that throws on use; "external": left as an import
//   modules     → your own sources by specifier (win over the rules above)
//   define      → free globals replaced (process, require, global → undefined)
// The output is one ES module whose default export is a WorkerEntrypoint with
// run(files, input): what the Agent's `tool` task loads.
//
// Build side only (Node, or a browser with esbuild-wasm): the Worker never imports this file.

import { bundle } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { checkToolBundle } from "./check.ts";
import { type ToolBundleConfig, type ToolBundleOverrides, toolConfig } from "./config.ts";
import { denyModule, FS_ID, FS_SHIM, PATH_ID, PATH_SHIM, reexport, wrapperEntry } from "./shims.ts";

const BUILTINS =
  "assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib".split(
    "|",
  );
const NODE_BUILTIN = new RegExp(`^(node:)?(${BUILTINS.join("|")})(/.*)?$`);

/** The `modules` resolver webrun-bundler gets: specifier → source, or undefined to resolve normally. */
export function toolModules(config: ToolBundleConfig): (spec: string) => string | undefined {
  return (spec) => {
    if (Object.hasOwn(config.modules, spec)) return config.modules[spec];
    if (spec === FS_ID) return FS_SHIM;
    if (spec === PATH_ID) return PATH_SHIM;
    if (config.fsModules.includes(spec)) return reexport(FS_ID);
    if (config.pathModules.includes(spec)) return reexport(PATH_ID);
    if (NODE_BUILTIN.test(spec) && config.builtins === "deny") return denyModule(spec);
    return undefined;
  };
}

export interface BundleToolOptions {
  /** esbuild or esbuild-wasm (initialized). */
  esbuild: unknown;
  /** The tool's sources by path ("/index.ts": "…"), or a FilesApi holding them under `root`. */
  sources?: Record<string, string>;
  files?: MemFilesApi;
  root?: string;
  /** The tool module, relative to `root` ("/index.ts"). It exports run(input) or a default function. */
  entry: string;
  /** Overrides of tool-bundle.config.json for this bundle. */
  config?: ToolBundleOverrides;
  /** webrun-bundler `packages` (default: node_modules in the FilesApi). */
  packages?: unknown;
  minify?: boolean;
}

export interface BundledTool {
  code: string;
  config: ToolBundleConfig;
  /** The acceptance check the Agent will run, run here too: fail early at build time. */
  check: { ok: boolean; problems: string[] };
}

const enc = new TextEncoder();
const WRAPPER = "/__capfs_tool_entry__.js";

export async function bundleTool(opts: BundleToolOptions): Promise<BundledTool> {
  const config = toolConfig(opts.config);
  const root = opts.root ?? "/tool";
  const files = opts.files ?? new MemFilesApi();
  if (opts.sources) {
    if (!(await files.exists(`${root}/package.json`))) {
      await files.write(`${root}/package.json`, [enc.encode('{"name":"tool","type":"module"}')]);
    }
    for (const [path, src] of Object.entries(opts.sources))
      await files.write(`${root}${path}`, [enc.encode(src)]);
  }
  const entry = opts.entry.startsWith("/") ? opts.entry : `/${opts.entry}`;
  await files.write(`${root}${WRAPPER}`, [enc.encode(wrapperEntry(`.${entry}`))]);
  const out = await bundle({
    // biome-ignore lint/suspicious/noExplicitAny: esbuild / esbuild-wasm
    esbuild: opts.esbuild as any,
    files,
    root,
    entry: WRAPPER,
    modules: toolModules(config),
    // builtins "external": kept as imports (and then rejected by the check unless listed in `external`)
    external:
      config.builtins === "external"
        ? [...config.external, "node:*", ...BUILTINS.flatMap((b) => [b, `${b}/*`])]
        : config.external,
    define: config.define,
    conditions: ["workerd", "worker", "browser"],
    sourcemap: false,
    minify: opts.minify,
    ...(opts.packages ? { packages: opts.packages as never } : {}),
  });
  if (!out.code.trim())
    throw new Error(`EINVAL: empty bundle (is entry '${entry}' relative to root '${root}'?)`);
  return { code: out.code, config, check: checkToolBundle(out.code, config) };
}
