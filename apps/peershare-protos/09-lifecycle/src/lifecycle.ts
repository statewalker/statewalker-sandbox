/**
 * Stop, reload and Revoke, as the Sharer drives them and a Guest sees them.
 */

import type { Sharer } from "../../05-tab-hub-invite/src/mesh.js";

/**
 * Two writes, as the hub's own `DELETE /admin/members/{peerId}` does: the
 * member record goes, AND a revocation is recorded, so the token the Guest
 * still holds stops verifying on its next call instead of lasting until it
 * expires.
 */
export function revokeGuest(sharer: Sharer, guestPeerId: string): void {
  sharer.hub.members.remove(guestPeerId);
  sharer.hub.revocations.revoke(guestPeerId);
}

/** Whether a Guest's failed request means "the Sharer is offline" (Stop, closed tab). */
/**
 * Measured: once the Sharer stops, a Guest's request comes back within tens
 * of ms as `502 {"kind":"peer-unreachable"}` from the Guest's own member,
 * never as a hang. The body is read from a clone, so the caller keeps it.
 */
export async function isSharerOffline(response: Response): Promise<boolean> {
  if (response.status !== 502) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return body?.kind === "peer-unreachable";
}
