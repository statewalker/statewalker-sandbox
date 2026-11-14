// Bundles a tool with webrun-bundler so that its `node:fs` (and every other Node builtin)
// is rewritten at build time, per the ToolBundleConfig:
//   fsModules   → one shared shim over the `files` capability  (option (a): inline, per bundle);
//                 a `…/promises` specifier gets the promise API of the same shim
//   pathModules → a pure POSIX path
//   builtins    → "deny": a module that throws on use; "external": left as an import
//   modules     → your own sources by specifier (win over the rules above)
//   define      → free globals replaced (process → a frozen stub, global → globalThis, require → undefined)
// The output is one ES module whose default export is a WorkerEntrypoint with
// run(files, input): what the Agent's `tool` task loads (with `bundled: true`).
//
// Build side: Node, a browser with esbuild-wasm, or the bundler Worker (src/bundler/program.ts,
// loaded on demand by the Agent); the main Worker does not import this file.

import { bundle } from "@statewalker/webrun-bundler";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { bundleHash, checkToolBundle } from "./check.ts";
import { type ToolBundleConfig, type ToolBundleOverrides, toolConfig } from "./config.ts";
import {
  denyModule,
  FS_ID,
  FS_PROMISES_ID,
  FS_PROMISES_SHIM,
  FS_SHIM,
  PATH_ID,
  PATH_SHIM,
  PROCESS_GLOBAL,
  PROCESS_ID,
  processShim,
  reexport,
  wrapperEntry,
} from "./shims.ts";

const BUILTINS =
  "assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|perf_hooks|process|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib".split(
    "|",
  );
const NODE_BUILTIN = new RegExp(`^(node:)?(${BUILTINS.join("|")})(/.*)?$`);

/** The real export names of a builtin, so `import { Buffer } from "node:buffer"` still links. */
async function builtinNames(spec: string): Promise<string[]> {
  const g = globalThis as { process?: { getBuiltinModule?: (s: string) => object | undefined } };
  try {
    const m = g.process?.getBuiltinModule?.(spec.startsWith("node:") ? spec : `node:${spec}`);
    return m ? Object.keys(m) : [];
  } catch {
    return []; // not on Node (a browser build): default export only
  }
}

// Loading these prints deprecation/experimental warnings: their imports get the default only.
const QUIET = new Set(["punycode", "sys", "wasi"]);

/**
 * Every Node builtin's export names, as this host (Node) has them: what a denied builtin
 * exports. scripts/build-bundler.mjs records them for the bundler Worker, so a bundle built
 * there denies the same names (and gets the same hash) as one built on Node.
 */
export async function builtinExportNames(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const b of BUILTINS) out[b] = QUIET.has(b) ? [] : await builtinNames(b);
  return out;
}

/** The `modules` resolver webrun-bundler gets: specifier → source, or undefined to resolve normally. */
export async function toolModules(
  config: ToolBundleConfig,
  table?: Record<string, string[]>,
): Promise<(spec: string) => string | undefined> {
  const names = new Map<string, string[]>(Object.entries(table ?? (await builtinExportNames())));
  const process = processShim(config.processEnv);
  return (spec) => {
    if (Object.hasOwn(config.modules, spec)) return config.modules[spec];
    if (spec === FS_ID) return FS_SHIM;
    if (spec === FS_PROMISES_ID) return FS_PROMISES_SHIM;
    if (spec === PATH_ID) return PATH_SHIM;
    if (spec === PROCESS_ID) return process;
    if (config.fsModules.includes(spec))
      return reexport(spec.endsWith("/promises") ? FS_PROMISES_ID : FS_ID);
    if (config.pathModules.includes(spec)) return reexport(PATH_ID);
    const m = spec.match(NODE_BUILTIN);
    if (m && config.builtins === "deny")
      return denyModule(spec, m[3] ? [] : (names.get(m[2] as string) ?? []));
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
  /** Node builtins' export names (builtinExportNames()), where this host is not Node. */
  builtinNames?: Record<string, string[]>;
}

export interface BundledTool {
  code: string;
  /** "sha256-<hex>": the id to list in a deployment's `allowedBundles`. */
  hash: string;
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
  const wrapper = `${root === "/" ? "" : root}${WRAPPER}`;
  await files.write(wrapper, [enc.encode(wrapperEntry(`.${entry}`))]);
  let code: string;
  try {
    const out = await bundle({
      // biome-ignore lint/suspicious/noExplicitAny: esbuild / esbuild-wasm
      esbuild: opts.esbuild as any,
      files,
      root,
      entry: WRAPPER,
      modules: await toolModules(config, opts.builtinNames),
      // `process` → the stub's identifier, provided by injecting the stub module
      inject: Object.values(config.define).includes(PROCESS_GLOBAL) ? [PROCESS_ID] : [],
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
    code = out.code;
  } finally {
    await files.remove(wrapper).catch(() => {}); // never leave the generated entry in the user's tree
  }
  if (!code.trim())
    throw new Error(`EINVAL: empty bundle (is entry '${entry}' relative to root '${root}'?)`);
  return { code, hash: await bundleHash(code), config, check: checkToolBundle(code, config) };
}
