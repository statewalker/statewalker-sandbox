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
 * Reservation limits are left at `circuitRelayServer()`'s own defaults --
 * they are what stops this relay becoming a free CDN for arbitrary traffic.
 * Do not raise them here "to make the demo smoother"; a real deployment that
 * needs different limits gets them from the environment, which is a separate,
 * deliberate piece of work.
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
  DEFAULT_RELAY_PORT,
  loadRelayKey,
  type RelayTlsMaterial,
  type ResolvedRelayConfig,
} from "./config.js";

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
}

export interface Relay {
  node: Libp2p;
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
    services: {
      identify: identify(),
      // Reservation limits: left at this call's own defaults -- see the
      // module comment.
      relay: circuitRelayServer(),
    },
  });

  return {
    node,
    async stop() {
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
  });
}
