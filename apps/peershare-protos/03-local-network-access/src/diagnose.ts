/**
 * What the PeerShare page can learn about its Bridge, in a browser.
 *
 * Chromium's Local Network Access check fails a refused request exactly like
 * a closed port: `TypeError: Failed to fetch`, nothing reaches the Bridge.
 * Only the permission state tells the two apart, so it is read alongside.
 */

import { BRIDGE_TOKEN_HEADER } from "../../01-upstream-kinds/src/upstreams.js";

export type BridgeDiagnosis = "ok" | "permission-needed" | "bridge-not-running" | "token-rejected";

export async function diagnoseBridge(init: {
  localUrl: string;
  token: string;
}): Promise<BridgeDiagnosis> {
  let response: Response;
  try {
    response = await fetch(`${init.localUrl}/`, {
      headers: { [BRIDGE_TOKEN_HEADER]: init.token },
    });
  } catch {
    // Read AFTER the attempt: the attempt is what asks the Sharer.
    const permission = await localNetworkPermission();
    // "unsupported": a browser without the check — the failure is the Bridge's.
    return permission === "prompt" || permission === "denied"
      ? "permission-needed"
      : "bridge-not-running";
  }
  if (response.status === 401) return "token-rejected";
  // Something else may answer on that port; to the Sharer it is the same:
  // the Bridge is not there.
  const body = await response.json().catch(() => undefined);
  return body?.bridge === "peershare" ? "ok" : "bridge-not-running";
}

/**
 * Chromium 153 knows three names and grants them together; older builds know
 * only `local-network-access`. A browser without the check has no such
 * permission at all, and nothing to ask for.
 */
async function localNetworkPermission(): Promise<PermissionState | "unsupported"> {
  try {
    return (await navigator.permissions.query({ name: "local-network-access" as PermissionName }))
      .state;
  } catch {
    return "unsupported";
  }
}
