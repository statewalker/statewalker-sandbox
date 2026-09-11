/**
 * The hub as a relay for its own members -- signalling only, members only.
 *
 * WHY THE HUB RELAYS AT ALL. Members of a mesh reach each other through
 * their hub rather than through the public relay: the hub is the one peer
 * every member is already connected to (over WebRTC, heartbeating), so it
 * can carry the few kilobytes of WebRTC offer/answer between two members,
 * after which they talk directly. The public relay is then needed only to
 * reach the hub itself. Tested end to end in Chromium by the
 * `proto/hub-relay` prototype; its `NOTES.md` has the evidence.
 *
 * MEMBERS ONLY. `membershipGater` refuses a reservation from a non-member
 * and refuses to relay unless BOTH ends are members. A non-member can still
 * CONNECT to the hub -- it must, to redeem an invitation -- it just cannot
 * use the hub to reach anyone. The public relay, by contrast, connects
 * anyone to any reserved peer whose id they know.
 *
 * SIGNALLING ONLY, ENFORCED RATHER THAN HOPED FOR. `hubRelayServer` keeps
 * libp2p's default per-circuit limits (128 KiB, 2 min), which are sized for
 * an SDP exchange. A circuit carrying limits is a LIMITED connection, and
 * libp2p refuses to open an application protocol on one -- so application
 * data cannot cross a hub by accident. When two members cannot connect
 * directly, WebRTC falls back to TURN; never to the hub. (Opening a
 * protocol with `runOnLimitedConnection` would bypass that, and the
 * prototype saw the result: a 1 MiB transfer silently cut at 112 KiB. Nothing
 * here may set it for application traffic.)
 */
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import type { ConnectionGater, PeerId } from "@libp2p/interface";

/** Whether `peerId` is a member of this hub's mesh -- read live, so a revocation takes effect on the next relay request. */
export type IsMember = (peerId: string) => boolean;

export function membershipGater(isMember: IsMember): ConnectionGater {
  return {
    denyInboundRelayReservation: async (source: PeerId) => !isMember(source.toString()),
    denyOutboundRelayedConnection: async (source: PeerId, destination: PeerId) =>
      !isMember(source.toString()) || !isMember(destination.toString()),
  };
}

export function hubRelayServer() {
  return circuitRelayServer({
    // The library's own limits, stated so nobody raises them to "make it
    // smoother": they are what keeps a hub a signalling channel.
    reservations: { applyDefaultLimit: true },
  });
}
