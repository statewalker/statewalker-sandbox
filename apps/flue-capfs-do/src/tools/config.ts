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
  /** esbuild `define`: free globals replaced at build time. */
  define: Record<string, string>;
  check: ToolCheckConfig;
  /**
   * Runtimes whose tool isolates can reach the host file system (cellb on Node):
   * "refuse" every tool, or "bundled-only" — accept bundles that pass the check. The check is
   * not a sandbox (computed property access can still reach the realm), so "bundled-only" is
   * for trusted or reviewed tools only.
   */
  hostFsRuntimes: "refuse" | "bundled-only";
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
export function deploymentToolConfig(json: string | undefined): ToolBundleConfig {
  if (!json) return toolConfig();
  try {
    return toolConfig(JSON.parse(json) as ToolBundleOverrides);
  } catch {
    throw new Error("EINVAL: TOOL_BUNDLE is not valid JSON");
  }
}
