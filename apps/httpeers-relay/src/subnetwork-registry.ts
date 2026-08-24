/**
 * The relay's half of subnetworks: who announced which name, and the two
 * connection-gater hooks that turn those records into a partition.
 *
 * `circuitRelayServer()` HAS NO ADMISSION HOOK. Its options are limits only
 * -- `maxReservations`, TTLs, data and duration caps. But it takes the node's
 * `connectionGater` from components, and `@libp2p/interface@3.2.5` defines
 * exactly the two hooks this needs:
 *
 *   - `denyInboundRelayReservation(source)` -- ADMISSION. Who may reserve.
 *   - `denyOutboundRelayedConnection(source, destination)` -- PARTITIONING,
 *     and the half that matters. Its own doc says when it fires: "invoked on
 *     the relay server when a source client with a reservation instructs the
 *     server to relay a connection to a destination peer." Admission alone
 *     would be a door policy; this is what makes two peers with different
 *     names unable to reach each other at all.
 *
 * BOTH HOOKS RECEIVE ONLY A `PeerId`, which is the whole reason
 * `/httpeers/relay-net/1.0.0` exists: the relay must already know a peer's
 * subnetwork before that peer reserves. Noise has proven the peer id by the
 * time the announcement arrives, so keying the record on it is safe.
 *
 * THE ADMISSION GRACE, AND WHY IT IS NOT A PAPERING-OVER. A peer announces on
 * the connection it just dialled, while libp2p's own reservation path is
 * still waiting for identify to report that this node speaks the hop
 * protocol -- so in practice the announcement lands first, comfortably. "In
 * practice" is not a guarantee, and losing that race would produce a denied
 * reservation that libp2p does not retry promptly, i.e. a peer that hangs for
 * reasons no log explains. So `denyInboundRelayReservation` -- which may
 * return a promise -- waits up to `DEFAULT_ADMISSION_GRACE_MS` for a record
 * to appear before refusing. A peer that genuinely announces nothing pays
 * that grace once and is then refused, having ALREADY been told why over the
 * protocol.
 *
 * PARTITIONING IS NOT AUTHORISATION. Nothing here makes a mesh secure. See
 * `./subnetwork.ts`.
 */

import type { Connection, Libp2p, PeerId, Stream } from "@libp2p/interface";
import type { RelayMode, RelayNetworkDescriptor } from "./config.js";
import type { SubnetworkAnnouncementReply } from "./subnetwork.js";
import { RELAY_NET_PROTOCOL, serveAnnouncement } from "./subnetwork.js";

/**
 * How long `denyInboundRelayReservation` waits for an announcement that has
 * not arrived yet. See the module comment. Well under libp2p's own
 * reservation completion timeout, so a waiting reservation is never left
 * hanging by this.
 */
export const DEFAULT_ADMISSION_GRACE_MS = 2_000;

/** What the relay knows about one connected peer. */
interface SubnetworkRecord {
  subnetwork: string;
  /** The connection the announcement arrived on -- the record dies with it. */
  connectionId: string;
}

export interface SubnetworkRegistryInit {
  /**
   * `open` accepts any well-formed name; `registered` accepts only names in
   * `networks`. Neither mode has a default subnetwork: a peer that announces
   * nothing is refused in both.
   */
  mode: RelayMode;
  /** The registered list. Consulted in `registered` mode; ignored in `open`. */
  networks: readonly RelayNetworkDescriptor[];
  /** Defaults to `DEFAULT_ADMISSION_GRACE_MS`. */
  admissionGraceMs?: number;
  /** Where the registry reports refusals it makes silently, i.e. in the gater. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

export interface SubnetworkRegistry {
  /**
   * Pass this to `createLibp2p`'s `connectionGater`. Built BEFORE the node
   * exists, which is why `attach` is a separate step.
   */
  connectionGater: {
    denyInboundRelayReservation(source: PeerId): Promise<boolean>;
    denyOutboundRelayedConnection(source: PeerId, destination: PeerId): boolean;
  };
  /**
   * Register the `/httpeers/relay-net/1.0.0` handler on `node` and start
   * dropping records when their connections close. Call once, after
   * `createLibp2p` has returned.
   */
  attach(node: Libp2p): Promise<void>;
  /** The subnetwork a peer announced, or `undefined` when it announced none (or has disconnected). */
  subnetworkOf(peerId: PeerId | string): string | undefined;
  /** How many peers currently hold a record. For the startup report and for tests. */
  size(): number;
}

export function createSubnetworkRegistry(init: SubnetworkRegistryInit): SubnetworkRegistry {
  const graceMs = init.admissionGraceMs ?? DEFAULT_ADMISSION_GRACE_MS;
  const log = init.log ?? ((message: string): void => console.warn(message));
  const registered = new Set(init.networks.map((network) => network.name));

  const records = new Map<string, SubnetworkRecord>();
  /** Callers of `denyInboundRelayReservation` waiting on a record that has not arrived yet. */
  const waiting = new Map<string, Set<() => void>>();

  const idOf = (peer: PeerId | string): string =>
    typeof peer === "string" ? peer : peer.toString();

  const remember = (peerId: string, record: SubnetworkRecord): void => {
    // OVERWRITES, and that is the point. A peer that reconnects announcing a
    // DIFFERENT name must land in the new subnetwork, never linger in the old
    // one -- which is also why records die with their connection below.
    records.set(peerId, record);
    const waiters = waiting.get(peerId);
    if (waiters != null) {
      waiting.delete(peerId);
      for (const wake of waiters) wake();
    }
  };

  /** Wait up to `graceMs` for a record for `peerId`. Resolves early the moment one arrives. */
  const awaitRecord = async (peerId: string): Promise<SubnetworkRecord | undefined> => {
    const held = records.get(peerId);
    if (held != null) return held;

    await new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.get(peerId)?.delete(wake);
        resolve();
      }, graceMs);
      (timer as { unref?: () => void }).unref?.();

      const waiters = waiting.get(peerId) ?? new Set<() => void>();
      waiters.add(wake);
      waiting.set(peerId, waiters);
    });
    return records.get(peerId);
  };

  /** The policy, and the only place `mode` is consulted. */
  const decide = (subnetwork: string): SubnetworkAnnouncementReply => {
    if (init.mode === "registered" && !registered.has(subnetwork)) {
      return {
        ok: false,
        reason: "not-registered",
        message:
          `relay: "${subnetwork}" is not a subnetwork registered on this relay. This relay runs ` +
          "in registered mode (RELAY_MODE=registered), so it accepts only the names its operator " +
          "listed in RELAY_NETWORKS at startup. Ask the operator to add this one, or use a relay " +
          "running in open mode.",
      };
    }
    return { ok: true, subnetwork };
  };

  const handler = (stream: Stream, connection: Connection): void => {
    const peerId = connection.remotePeer.toString();
    void serveAnnouncement(stream, (subnetwork) => {
      const reply = decide(subnetwork);
      if (reply.ok) remember(peerId, { subnetwork, connectionId: connection.id });
      return reply;
    }).catch((err) => {
      // A malformed or abandoned announcement is an ordinary event on a
      // public relay, and the peer is refused by the gater regardless. Say
      // it once, at the level of "something a peer did", not as a fault.
      log(`relay: ${RELAY_NET_PROTOCOL} exchange with ${peerId} failed: ${String(err)}`);
    });
  };

  return {
    connectionGater: {
      async denyInboundRelayReservation(source: PeerId): Promise<boolean> {
        const peerId = source.toString();
        const record = await awaitRecord(peerId);
        if (record == null) {
          log(
            `relay: refused a reservation from ${peerId}: it announced no subnetwork name. ` +
              `A peer announces one over ${RELAY_NET_PROTOCOL} after connecting and before ` +
              "reserving; this relay has no default subnetwork.",
          );
          return true;
        }
        // `registered` was already enforced when the record was made -- an
        // unregistered name is never recorded -- so holding a record IS
        // admission. Re-checking here would only be able to disagree with the
        // reply the peer was already given.
        return false;
      },

      denyOutboundRelayedConnection(source: PeerId, destination: PeerId): boolean {
        const from = records.get(source.toString());
        const to = records.get(destination.toString());
        // NO GRACE HERE, deliberately: both ends have already reserved by the
        // time one instructs the relay to reach the other, so both records
        // exist or the peer in question is not reachable through this relay
        // at all.
        if (from == null || to == null || from.subnetwork !== to.subnetwork) {
          log(
            `relay: refused to relay ${source.toString()} -> ${destination.toString()}: ` +
              `subnetworks ${from?.subnetwork ?? "(none)"} and ${to?.subnetwork ?? "(none)"} ` +
              "are not the same. Peers can only reach each other through this relay when they " +
              "announced the same subnetwork name.",
          );
          return true;
        }
        return false;
      },
    },

    async attach(node: Libp2p): Promise<void> {
      await node.handle(RELAY_NET_PROTOCOL, handler);
      // THE RECORD DIES WITH THE CONNECTION IT ARRIVED ON. Without this a
      // peer that reconnects announcing a different name would still be
      // partitioned by the old one -- and a peer that reconnects announcing
      // NOTHING would keep a reservation it is no longer entitled to.
      node.addEventListener("connection:close", (event) => {
        const connection = event.detail;
        const peerId = connection.remotePeer.toString();
        if (records.get(peerId)?.connectionId === connection.id) records.delete(peerId);
      });
    },

    subnetworkOf(peer: PeerId | string): string | undefined {
      return records.get(idOf(peer))?.subnetwork;
    },

    size(): number {
      return records.size;
    },
  };
}
