// Configuration of tool bundling, shared by the bundler (build side) and the Agent's
// acceptance check (run side). Defaults live in tool-bundle.config.json; a bundle call can
// override them, and a deployment can override the run-side policy with the TOOL_BUNDLE var
// (a JSON string with the same keys).

import defaults from "../../tool-bundle.config.json" with { type: "json" };

export interface ToolCheckConfig {
  /** Free identifiers a bundle must not reference (after `define` replaced the defined ones). */
  forbidIdentifiers: string[];
  /** Reject `import(…)` of any kind. */
  forbidDynamicImport: boolean;
  /** Reject `import.meta`. */
  forbidImportMeta: boolean;
  /**
   * Reject any use of globalThis/self/global/window other than reading a plain, non-forbidden
   * property (aliasing, passing it, computed access). Off: only forbidden keys are rejected,
   * which lets libraries that test for the global object (`typeof globalThis == "object" &&
   * globalThis`) pass, and lets the aliases through.
   */
  restrictGlobalObject: boolean;
}

export interface ToolBundleConfig {
  /** Specifiers replaced by the file-capability shim (async node:fs API over the tool's `files`). */
  fsModules: string[];
  /** Specifiers replaced by a small pure POSIX `path` implementation. */
  pathModules: string[];
  /** Every other Node builtin: "deny" (a module that throws on use) or "external" (left as an import; the check then rejects it unless listed in `external`). */
  builtins: "deny" | "external";
  /** Extra modules supplied by source, by specifier (wins over the rules above). */
  modules: Record<string, string>;
  /** Specifiers left as imports in the bundle — and the only imports the check accepts. */
  external: string[];
  /**
   * esbuild `define`: free globals replaced at build time. By default `process` becomes a frozen
   * stub (`env` from `processEnv`, no host access), `global` becomes `globalThis` and `require`
   * becomes `undefined`.
   */
  define: Record<string, string>;
  /** `process.env` of the process stub. */
  processEnv: Record<string, string>;
  check: ToolCheckConfig;
  /**
   * Runtimes whose tool isolates can reach the host file system (cellb on Node): "refuse" every
   * tool, or "bundled-only": run bundles that the deployment APPROVED (their hash is in
   * `allowedBundles`) and that pass the check. The check alone is not a sandbox, so a client's
   * own bundle never runs there.
   */
  hostFsRuntimes: "refuse" | "bundled-only";
  /**
   * Run side: hashes ("sha256-<hex>", from bundleTool / the CLI) of approved bundles. When not
   * empty, only these bundles run, on every runtime. "bundled-only" needs it.
   */
  allowedBundles: string[];
  /** Run side: every tool must pass the check (a raw module is then refused even on workerd). */
  requireBundled: boolean;
}

export type ToolBundleOverrides = Partial<Omit<ToolBundleConfig, "check">> & {
  check?: Partial<ToolCheckConfig>;
};

const { $comment: _comment, ...base } = defaults as typeof defaults & { $comment?: string };
export const DEFAULT_TOOL_CONFIG = base as ToolBundleConfig;

/** Defaults ← overrides (shallow per key; `check` merged one level deeper). */
export function toolConfig(...overrides: (ToolBundleOverrides | undefined)[]): ToolBundleConfig {
  let out: ToolBundleConfig = structuredClone(DEFAULT_TOOL_CONFIG);
  for (const o of overrides) {
    if (!o) continue;
    out = { ...out, ...o, check: { ...out.check, ...(o.check ?? {}) } } as ToolBundleConfig;
  }
  return out;
}

/** The run-side config of a deployment: defaults ← TOOL_BUNDLE (JSON). */
const parsed = new Map<string, ToolBundleConfig>();

/** TOOL_BUNDLE may be a JSON string or (wrangler object `vars`) an object. */
export function deploymentToolConfig(value: unknown): ToolBundleConfig {
  if (value === undefined || value === null || value === "") return toolConfig();
  if (typeof value === "object") return toolConfig(value as ToolBundleOverrides);
  const json = String(value);
  let config = parsed.get(json);
  if (!config) {
    try {
      config = toolConfig(JSON.parse(json) as ToolBundleOverrides);
    } catch {
      throw new Error("EINVAL: TOOL_BUNDLE is not valid JSON");
    }
    parsed.set(json, config);
  }
  return config;
}
