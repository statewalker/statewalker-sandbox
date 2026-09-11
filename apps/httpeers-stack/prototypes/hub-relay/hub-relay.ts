/**
 * PROTOTYPE (hub-relay) -- the one piece of it worth keeping if it holds.
 *
 * A hub runs a stock circuit relay FOR ITS OWN MEMBERS ONLY, and only for
 * signalling:
 *   - `membershipGater` refuses a reservation from a non-member, and refuses
 *     to relay a connection unless both ends are members. A non-member can
 *     still CONNECT to the hub (it must, to redeem an invitation) -- it just
 *     cannot use the hub to reach anyone.
 *   - `hubRelayServer` keeps libp2p's default per-circuit limits, which are
 *     sized for exactly this: an SDP exchange and nothing more. A circuit
 *     through the hub is therefore a LIMITED connection, and libp2p refuses
 *     to open an application protocol on one -- which is what makes "no
 *     application traffic through a hub" enforced rather than hoped for.
 */
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import type { ConnectionGater, PeerId } from "@libp2p/interface";

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
    // The library defaults (128 KiB, 2 min per circuit) -- stated so that
    // nobody raises them "to make it smoother": a circuit through a hub is a
    // signalling channel, never a data path.
    reservations: { applyDefaultLimit: true },
  });
}
