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

/**
 * The 502 `kind`s that mean "the Sharer is offline" (Stop, closed tab).
 *
 * Measured: once the Sharer stops, a Guest's request comes back within tens
 * of ms, never as a hang, almost always as `peer-unreachable` from the
 * Guest's own member. Rarely (1 in 200 runs) the request goes out on the
 * dying per-peer mux before the Guest sees it close; it then fails as
 * `PeerGoneError`, which the member reports as `stream-reset`. Both mean the
 * same thing to a Guest, so both count; there is no retry (decided on
 * statewalker-sandbox#154).
 */
export const SHARER_OFFLINE_KINDS: readonly string[] = ["peer-unreachable", "stream-reset"];

/**
 * Whether a Guest's failed request means "the Sharer is offline": a 502
 * whose JSON body's `kind` is one of {@link SHARER_OFFLINE_KINDS}. The body
 * is read from a clone, so the caller keeps it.
 */
export async function isSharerOffline(response: Response): Promise<boolean> {
  if (response.status !== 502) return false;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return typeof body?.kind === "string" && SHARER_OFFLINE_KINDS.includes(body.kind);
}
