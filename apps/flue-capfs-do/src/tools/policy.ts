// Which tools may run on this runtime, decided from the DEPLOYMENT's config only (nothing in a
// request feeds it). Pure, so it is unit-tested without a runtime.

import { bundleHash, checkToolBundle } from "./check.ts";
import type { ToolBundleConfig } from "./config.ts";

/**
 * Whether Worker Loader isolates on this runtime can reach the host's files. cellb on Node runs
 * loaded code in a worker thread with the real node:fs — there a tool could read the cells'
 * SQLite files, including the Workspace root key.
 */
export const isolatesSeeHostFs = (): boolean =>
  /Node\.js/.test(globalThis.navigator?.userAgent ?? "");

export type ToolPolicy = "none" | "isolated" | "bundled-only" | "refused";

/**
 *   "none"          no Worker Loader binding
 *   "isolated"      isolates have no host file system: raw modules and bundles run
 *   "bundled-only"  isolates see the host file system: approved bundles only (config opt-in)
 *   "refused"       isolates see the host file system: every tool refused (the default there)
 */
export function toolPolicy(
  env: { LOADER?: unknown; ALLOW_HOST_FS_TOOLS?: string },
  config: ToolBundleConfig,
  seesHostFs: boolean = isolatesSeeHostFs(),
): ToolPolicy {
  if (!env.LOADER) return "none";
  if (!seesHostFs || env.ALLOW_HOST_FS_TOOLS === "1") return "isolated";
  return config.hostFsRuntimes === "bundled-only" ? "bundled-only" : "refused";
}

const refuse = (why: string): never => {
  throw new Error(`EPERM: ${why}`);
};

/**
 * Throws EPERM unless this tool may run. A bundle the client wrote is never enough where the
 * isolate sees the host file system: there it must be APPROVED (its hash in `allowedBundles`).
 *   - refused                         → nothing runs
 *   - requireBundled / bundled-only / a non-empty allowedBundles → only `bundled: true` code
 *   - bundled code                    → must pass the acceptance check
 *   - bundled-only or allowedBundles  → its hash must be listed
 */
export async function admitTool(
  tool: { code: string; bundled: boolean },
  policy: ToolPolicy,
  config: ToolBundleConfig,
): Promise<void> {
  if (policy === "none")
    throw new Error("ENOSYS: no Worker Loader binding (LOADER) in this runtime");
  if (policy === "refused")
    refuse("tool isolates on this runtime can reach the host file system; refused");
  const approvedOnly = policy === "bundled-only" || config.allowedBundles.length > 0;
  if ((config.requireBundled || approvedOnly) && !tool.bundled) {
    refuse("this runtime accepts bundled tools only (bundle with bundleTool)");
  }
  if (tool.bundled) {
    const r = checkToolBundle(tool.code, config);
    if (!r.ok) refuse(`tool bundle rejected: ${r.problems.slice(0, 5).join("; ")}`);
  }
  if (approvedOnly) {
    const hash = await bundleHash(tool.code);
    if (!config.allowedBundles.includes(hash))
      refuse(`bundle ${hash} is not in the deployment's allowedBundles`);
  }
}
