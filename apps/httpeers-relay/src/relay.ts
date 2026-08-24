/**
 * The relay: a stock libp2p Circuit Relay v2 server over WebSockets, and
 * nothing else.
 *
 * NO APPLICATION CODE. This process does not serve discovery, does not
 * announce itself as a member of any mesh, and holds no directory -- design
 * notes 04 §6 and 07 §3's arrangement, which `webrun-wire`'s `p2p-demo`
 * violates today by calling `serveDiscovery()` inside its own
 * `relay/server.ts`. Do NOT copy that file's shape: this is the one component
 * in the whole system that is genuinely infrastructure, and it is also the
 * only one containing no project logic. That those two facts coincide is the
 * design working, not an oversight to "complete" by adding a directory here
 * too.
 *
 * A RELAY IS NOT AN AUTHORISER. It forwards bytes for peers with no inbound
 * socket. It makes no membership decision, and nothing about being relayed
 * grants anything -- a relayed connection still has to redeem an invitation,
 * present a token bound to the key it proves, and satisfy the destination's
 * policy. Do not describe anything in this package as making a mesh secure.
 *
 * SUBNETWORKS DO NOT CHANGE THAT. This relay partitions by subnetwork name
 * (`./subnetwork-registry.ts`), so peers announcing different names cannot
 * dial each other through it. That is REACHABILITY, not authorisation: it
 * stops strangers stumbling in and stops cross-subnetwork dialling, and it
 * makes no mesh private. The name is not a key, a secret or a credential.
 *
 * RESERVATION LIMITS COME FROM THE ENVIRONMENT, and default to
 * `circuitRelayServer()`'s own values so that setting nothing changes nothing
 * (`./config.ts`'s `RelayLimits`). They are what stops this relay becoming a
 * free CDN for arbitrary traffic, and on a relay with a public name they are
 * the only cost control there is. Do not raise them here "to make the demo
 * smoother" -- a deployment that needs different limits sets the variables.
 *
 * IDENTITY IS NOT GENERATED HERE. A relay's peerId is embedded in every
 * multiaddr peers dial (`.../p2p/<relayPeerId>/...`), so an ephemeral key
 * would silently invalidate every published address on every restart, with a
 * symptom -- peers failing to connect -- that points nowhere near the relay.
 * The key comes from `RELAY_KEY` or `RELAY_KEY_PATH`; if neither is there,
 * this fails loudly rather than papering over the gap with a fresh identity
 * nobody asked for. See `./config.ts`.
 *
 * KEY FORMAT: the protobuf encoding `@libp2p/crypto/keys`' own
 * `privateKeyToProtobuf`/`privateKeyFromProtobuf` round-trip through -- raw
 * bytes on disk for `RELAY_KEY_PATH`, base64 of the same bytes for
 * `RELAY_KEY`. `apps/httpeers-stack`'s `pnpm bootstrap` writes exactly that
 * shape, and `./keygen.ts` prints exactly that shape.
 */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p, type Libp2p } from "libp2p";
import {
  DEFAULT_RELAY_LIMITS,
  DEFAULT_RELAY_PORT,
  loadRelayKey,
  type RelayLimits,
  type RelayMode,
  type RelayNetworkDescriptor,
  type RelayTlsMaterial,
  type ResolvedRelayConfig,
} from "./config.js";
import { type RelayHttp, startRelayHttp } from "./http.js";
import { createSubnetworkRegistry, type SubnetworkRegistry } from "./subnetwork-registry.js";

export interface StartRelayInit {
  /**
   * Ignored when `listen` is given. Defaults to `DEFAULT_RELAY_PORT` (9090);
   * `0` binds an arbitrary free port, which is what every test wants.
   */
  port?: number;
  /** Overrides `port` entirely. Defaults to `/ip4/0.0.0.0/tcp/${port}/${ws|wss}`. */
  listen?: string[];
  /**
   * What peers are told to dial, when that is not what this relay binds.
   * Empty (the default) means "announce the listen addresses" -- libp2p's own
   * behaviour. See `./config.ts`'s `RELAY_ANNOUNCE`.
   */
  announce?: string[];
  /** base64 protobuf. Wins over `keyPath`, mirroring `RELAY_KEY` over `RELAY_KEY_PATH`. */
  key?: string;
  /** Defaults to `DEFAULT_RELAY_KEY_PATH`. */
  keyPath?: string;
  /** Already decoded. Wins over both `key` and `keyPath`; this is what `main.ts` passes. */
  privateKey?: Ed25519PrivateKey;
  /** When set, the relay listens `wss` and terminates TLS itself. Absent means plain `ws`. */
  tls?: RelayTlsMaterial;
  /** `open` (the default) accepts any subnetwork name; `registered` accepts only `networks`. See `./config.ts`. */
  mode?: RelayMode;
  /** The registered list, consulted in `registered` mode. */
  networks?: readonly RelayNetworkDescriptor[];
  /** How long the gater waits for an announcement that has not arrived yet. See `./subnetwork-registry.ts`. */
  admissionGraceMs?: number;
  /** Where the subnetwork registry reports refusals. Defaults to `console.warn`. */
  log?: (message: string) => void;
  /** Reservation limits. Defaults to `DEFAULT_RELAY_LIMITS`, which are `circuitRelayServer()`'s own. */
  limits?: RelayLimits;
  /**
   * Serve `/health` and the discovery document on this port. `0` binds an
   * arbitrary free port. Omit to serve neither -- which is what the library
   * tests that only want a relay do, and is NOT what a deployment does; see
   * `./config.ts`'s `resolveHttpPort`.
   */
  httpPort?: number;
}

export interface Relay {
  node: Libp2p;
  /** The `/health` + discovery surface, when `httpPort` was given. `undefined` otherwise. */
  http?: RelayHttp;
  /**
   * Who announced which subnetwork. Exposed because it is the one piece of
   * relay state a test or an operator surface has any business reading -- the
   * partition's whole input.
   */
  subnetworks: SubnetworkRegistry;
  stop: () => Promise<void>;
}

/**
 * Boots the relay. Everything it needs is in `init`; nothing is read from the
 * environment here, so a test and a deployment run the same code with
 * different arguments rather than different code.
 */
export async function startRelay(init: StartRelayInit = {}): Promise<Relay> {
  const privateKey =
    init.privateKey ?? loadRelayKey({ key: init.key, keyPath: init.keyPath }).privateKey;

  const scheme = init.tls != null ? "wss" : "ws";
  const listen = init.listen ?? [`/ip4/0.0.0.0/tcp/${init.port ?? DEFAULT_RELAY_PORT}/${scheme}`];
  const announce = init.announce ?? [];
  const limits = init.limits ?? DEFAULT_RELAY_LIMITS;

  // BUILT BEFORE THE NODE, because `createLibp2p` takes the gater as
  // construction input and the gater is where the partition is enforced. The
  // protocol handler that feeds it is registered afterwards, by `attach`.
  const subnetworks = createSubnetworkRegistry({
    mode: init.mode ?? "open",
    networks: init.networks ?? [],
    admissionGraceMs: init.admissionGraceMs,
    log: init.log,
  });

  const node = await createLibp2p({
    privateKey,
    // `announce` replaces the listen addresses in what this node tells peers.
    // An empty array is libp2p's own "no override", which is why the default
    // is byte-identical to having passed `listen` alone.
    addresses: { listen, announce },
    transports: [
      webSockets(init.tls != null ? { https: { cert: init.tls.cert, key: init.tls.key } } : {}),
    ],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // THE ONLY ADMISSION HOOK CIRCUIT RELAY v2 HAS. `circuitRelayServer()`
    // takes no policy of its own -- its options are limits. See
    // `./subnetwork-registry.ts`.
    connectionGater: subnetworks.connectionGater,
    services: {
      identify: identify(),
      // PASSED EXPLICITLY, and equal to this call's own defaults unless an
      // operator said otherwise -- see `./config.ts`'s `RelayLimits` for where
      // those numbers were read from and the test that keeps them honest.
      relay: circuitRelayServer({
        // NESTED UNDER `reservations`, which is where this version puts them --
        // a flat `{ maxReservations }` is silently ignored by the type and by
        // the runtime, so a limit set that way would look configured and do
        // nothing.
        reservations: {
          maxReservations: limits.maxReservations,
          reservationTtl: limits.reservationTtlMs,
          defaultDataLimit: limits.defaultDataLimitBytes,
          defaultDurationLimit: limits.defaultDurationLimitMs,
        },
      }),
    },
  });

  await subnetworks.attach(node);

  // AFTER the node, because the document it serves is read from the node and
  // an endpoint that answered before there was anything to report would be
  // publishing an empty address list to whoever probed first.
  let http: RelayHttp | undefined;
  if (init.httpPort != null) {
    try {
      http = await startRelayHttp({
        port: init.httpPort,
        document: () => ({
          peerId: node.peerId.toString(),
          // THE SAME HONEST SOURCE `./report.ts` PRINTS. libp2p replaces the
          // listen addresses with the announce ones when any are configured,
          // so this is "what a peer will actually be handed" rather than
          // "what this process was configured with".
          addrs: node.getMultiaddrs().map((addr) => addr.toString()),
          mode: init.mode ?? "open",
        }),
      });
    } catch (err) {
      // The node is already up and holding a port by now. A relay that came up
      // with no liveness endpoint would be one a container platform kills on
      // its first probe, so this fails loudly rather than half-starting.
      await node.stop();
      throw err;
    }
  }

  return {
    node,
    subnetworks,
    http,
    async stop() {
      // The HTTP surface first: it is the one thing outside this process that
      // is actively polling us, and leaving it answering while the node goes
      // away would report a healthy relay that no longer relays.
      await http?.stop();
      await node.stop();
    },
  };
}

/** Boots the relay from an already-resolved environment configuration. */
export async function startRelayFromConfig(config: ResolvedRelayConfig): Promise<Relay> {
  return startRelay({
    privateKey: config.privateKey,
    listen: config.listen,
    announce: config.announce,
    tls: config.tls,
    mode: config.mode,
    networks: config.networks,
    limits: config.limits,
    httpPort: config.httpPort,
  });
}
