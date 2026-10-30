/** PeerShare's extension points (PLAN §2.3): what other Features plug into. */

import { defineKeyedSlot, defineSlot } from "@statewalker/shared-slots";
import type { FetchHandler, Upstream } from "@statewalker/webrun-http-proxy";

/** A way to reach what a Service shares. PeerShare ships "bridged" and "direct" (decision 4.1). */
export interface UpstreamKind {
  id: string;
  label: string;
  /** Whether `target` can be shared this way; the reason is shown on the form. */
  check(target: string): { ok: true } | { ok: false; reason: string };
  create(target: string): Upstream;
  /** The Service's WebSocket at `path` (M9). A kind without it cannot carry live connections. */
  socket?(target: string, path: string, protocols: string[]): WebSocket;
}

export const upstreamKindsSlot = defineKeyedSlot<UpstreamKind>("peershare:upstream-kinds");

/** The Sharer's `/s` handler, provided for whichever Feature hosts the mesh. */
export const sharerMountSlot = defineSlot<FetchHandler>("peershare:sharer-mount");

/**
 * How the Viewer reaches a Service as a Guest: over the mesh, through the
 * member's JavaScript `fetch` (rung 08), so a redirect stays a real 3xx.
 * `request`'s path is the Service's own (`/`, `/api/…`).
 */
export type GuestFetch = (serviceId: string, request: Request) => Promise<Response>;
export const guestFetchSlot = defineSlot<GuestFetch>("peershare:guest-fetch");

/** Everything a view shows, as one immutable snapshot. */
export interface PeerShareSnapshot {
  sharer: import("./types.js").SharerState;
  sharing: import("./commands.js").SharingState;
  guests: import("./commands.js").GuestRecord[];
  /** The last Invite made, for the Invite dialog. */
  invite?: { url: string; expiresAt: number };
  guest: import("./commands.js").GuestState;
}

/** An external store (React's `useSyncExternalStore`): views read here, act through commands. */
export interface PeerShareModel {
  getSnapshot(): PeerShareSnapshot;
  subscribe(onChange: () => void): () => void;
}

export const peershareModelSlot = defineSlot<PeerShareModel>("peershare:model");

/** How the Viewer opens a live connection to a Service as a Guest (M9): a WebSocket over the mesh. */
export type GuestSocket = (
  serviceId: string,
  path: string,
  protocols: string[],
) => import("@statewalker/httpeers-share").TunnelSocket;
export const guestSocketSlot = defineSlot<GuestSocket>("peershare:guest-socket");
