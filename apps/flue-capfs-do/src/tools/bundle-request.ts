// What a caller may send to have a tool bundled in the deployment (the `bundle` task and the
// `tool` task with sources): checked here, in the Agent cell, before anything reaches the
// bundler Worker. Pure, so it is unit-tested without a runtime.

import type { ToolBundleConfig, ToolBundleOverrides } from "./config.ts";

export interface BundleRequest {
  /** The tool's sources by path: { "/index.ts": "…", "/lib/x.js": "…" }. */
  sources: Record<string, string>;
  /** The tool module ("/index.ts"): it exports run(input) or a default function. */
  entry: string;
  /** Build-side overrides (which modules are shimmed, defines, process.env). */
  config?: ToolBundleOverrides;
}

/** A request whose limits are checked and whose config is the deployment's plus the caller's. */
export interface CheckedBundleRequest {
  sources: Record<string, string>;
  entry: string;
  config: ToolBundleConfig;
}

export const BUNDLE_LIMITS = {
  files: 100,
  /** UTF-8 bytes of the sources and of every source-like config value, together. */
  bytes: 256 * 1024,
  /** UTF-8 bytes of the bundle the bundler may return. */
  output: 2 * 1024 * 1024,
};

/** The bundler's own entry module: a source may not take its name. */
export const WRAPPER_NAME = "/__capfs_tool_entry__.js";

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
const isRecord = (v: unknown): v is Record<string, string> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");

/** Build-side keys a caller may override, and the shape each must have. */
const BUILD_KEYS: Record<string, (v: unknown) => boolean> = {
  fsModules: isStrings,
  pathModules: isStrings,
  builtins: (v) => v === "deny" || v === "external",
  modules: isRecord,
  define: isRecord,
  processEnv: isRecord,
};

const bad = (why: string): never => {
  throw new Error(`EINVAL: bundle: ${why}`);
};

/** Paths are absolute, made of plain segments (no empty, "." or ".." segment). */
function checkPath(path: string) {
  const segments = path.split("/").slice(1);
  if (
    !path.startsWith("/") ||
    segments.some((s) => s === "" || s === "." || s === ".." || !/^[A-Za-z0-9._@-]+$/.test(s))
  )
    bad(`bad source path '${path}'`);
  if (path === WRAPPER_NAME) bad(`'${path}' is the bundler's own name`);
}

/**
 * Checks a caller's bundle request against the limits and returns it with the effective config:
 * the deployment's, with the caller's build-side keys on top. `external`, the check and the run
 * policy stay the deployment's.
 */
export function checkBundleRequest(
  req: unknown,
  deployment: ToolBundleConfig,
): CheckedBundleRequest {
  const r = (req ?? {}) as Partial<BundleRequest>;
  if (!isRecord(r.sources)) bad("sources is an object of path → source text");
  const sources = r.sources as Record<string, string>;
  const paths = Object.keys(sources);
  if (paths.length === 0 || paths.length > BUNDLE_LIMITS.files)
    bad(`1 to ${BUNDLE_LIMITS.files} source files`);
  for (const p of paths) checkPath(p);
  if (typeof r.entry !== "string") bad("entry must name one of the sources");
  const entry = (r.entry as string).startsWith("/") ? (r.entry as string) : `/${r.entry}`;
  if (!Object.hasOwn(sources, entry)) bad("entry must name one of the sources");

  const overrides: Record<string, unknown> = {};
  let size = 0;
  for (const [p, src] of Object.entries(sources)) size += bytes(p) + bytes(src);
  if (
    r.config !== undefined &&
    (typeof r.config !== "object" || r.config === null || Array.isArray(r.config))
  )
    bad("config is an object");
  for (const [k, v] of Object.entries(r.config ?? {})) {
    const valid = BUILD_KEYS[k];
    if (!valid) bad(`'${k}' is the deployment's to set`);
    if (!(valid as (v: unknown) => boolean)(v)) bad(`config.${k} has the wrong shape`);
    size += bytes(JSON.stringify(v));
    overrides[k] = v;
  }
  if (size > BUNDLE_LIMITS.bytes) bad(`sources and config are over ${BUNDLE_LIMITS.bytes} bytes`);
  return { sources, entry, config: { ...deployment, ...overrides } as ToolBundleConfig };
}
