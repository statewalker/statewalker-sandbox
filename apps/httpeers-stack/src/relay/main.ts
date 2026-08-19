/**
 * The relay process: a stock libp2p Circuit Relay v2 server over
 * WebSockets, and nothing else.
 *
 * NO APPLICATION CODE. This process does not serve discovery, does not
 * announce itself as a member of any mesh, and holds no directory --
 * design notes 04 §6 and 07 §3's arrangement, which `webrun-wire`'s
 * `p2p-demo` violates today by calling `serveDiscovery()` inside its own
 * `relay/server.ts`. Do NOT copy that file's shape: this is the one
 * component in the whole system that is genuinely infrastructure, and it
 * is also the only one containing no project logic. That those two facts
 * coincide is the design working, not an oversight to "complete" by adding
 * a directory here too.
 *
 * Reservation limits are left at `circuitRelayServer()`'s own defaults --
 * they are what stops this relay becoming a free CDN for arbitrary
 * traffic. Do not raise them here "to make the demo smoother"; if a real
 * deployment needs different limits, that is a deliberate, reviewed
 * change to this one line, not a default to quietly work around.
 *
 * IDENTITY IS NOT GENERATED HERE. A relay's peerId is embedded in every
 * multiaddr peers dial (`.../p2p/<relayPeerId>/...`), which
 * `httpeers.json` (Task 10's setup CLI) hands out as the invitation
 * payload. An ephemeral key would silently invalidate that config on
 * every restart, with a symptom -- peers failing to connect -- that
 * points nowhere near the relay. So the key MUST come from
 * `.httpeers/relay.key`, written once by `pnpm setup`; if it is missing,
 * this process fails loudly and exits rather than papering over the gap
 * with a fresh identity nobody asked for.
 *
 * KEY FILE FORMAT (a decision this task makes, for Task 10 to honor): the
 * protobuf encoding `@libp2p/crypto/keys`' own `privateKeyToProtobuf` /
 * `privateKeyFromProtobuf` round-trip through -- the same package
 * `httpeers.core`'s `tokens.ts` already depends on for `generateMeshKey`,
 * and libp2p's own idiomatic on-disk key format. `.httpeers/relay.key` is
 * that protobuf, written as raw bytes; Task 10 must produce exactly that
 * shape (`writeFileSync(path, privateKeyToProtobuf(key))`) for this loader
 * to read it back.
 */

import { readFileSync } from "node:fs";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import type { Ed25519PrivateKey } from "@libp2p/interface";
import { webSockets } from "@libp2p/websockets";
import { createLibp2p, type Libp2p } from "libp2p";

/** `RELAY_PORT`'s default -- matches the brief and the design spec's `/ip4/0.0.0.0/tcp/9090/ws` example. */
export const DEFAULT_RELAY_PORT = 9090;

/** Where `pnpm setup` (Task 10) writes the relay's signing key, and where this process reads it back from. */
export const DEFAULT_RELAY_KEY_PATH = "./.httpeers/relay.key";

export interface RelayTlsInit {
  /** PEM certificate content -- already read from `TLS_CERT`'s file, not the path itself. See the run-if-main block below. */
  cert: string;
  /** PEM private key content -- already read from `TLS_KEY`'s file. */
  key: string;
}

export interface StartRelayInit {
  /** Defaults to `DEFAULT_RELAY_PORT` (9090). */
  port?: number;
  /** Defaults to `DEFAULT_RELAY_KEY_PATH`. */
  keyPath?: string;
  /** When set, the relay listens on `wss` instead of `ws` and passes `{ cert, key }` through to `webSockets()`. */
  tls?: RelayTlsInit;
}

export interface Relay {
  node: Libp2p;
  stop: () => Promise<void>;
}

/**
 * Reads and decodes the relay's signing key from `keyPath`. Exits the
 * process (after printing guidance) if the file is absent -- see the
 * module comment's "IDENTITY IS NOT GENERATED HERE" section for why this
 * is not a silent ephemeral-key fallback.
 */
function loadRelayKey(keyPath: string): Ed25519PrivateKey {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`relay: no signing key found at "${keyPath}".`);
      console.error(
        'relay: run "pnpm setup" first -- it generates the relay and hub keys this process needs.',
      );
      console.error(
        "relay: refusing to start with a freshly generated key: this relay's peerId is embedded in",
      );
      console.error(
        "relay: every multiaddr peers dial, so an ephemeral identity would invalidate that config",
      );
      console.error("relay: on every restart.");
      process.exit(1);
    }
    throw err;
  }
  const key = privateKeyFromProtobuf(bytes);
  if (key.type !== "Ed25519") {
    throw new Error(
      `relay: key at "${keyPath}" is a ${key.type} key -- only Ed25519 is supported (design note 05 §2).`,
    );
  }
  return key;
}

export async function startRelay(init: StartRelayInit = {}): Promise<Relay> {
  const port = init.port ?? DEFAULT_RELAY_PORT;
  const keyPath = init.keyPath ?? DEFAULT_RELAY_KEY_PATH;
  const privateKey = loadRelayKey(keyPath);

  const scheme = init.tls != null ? "wss" : "ws";
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [`/ip4/0.0.0.0/tcp/${port}/${scheme}`] },
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

// Run directly (e.g. `tsx src/relay/main.ts`) rather than only as a library import.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.RELAY_PORT != null ? Number(process.env.RELAY_PORT) : DEFAULT_RELAY_PORT;
  const tls =
    process.env.TLS_CERT != null && process.env.TLS_KEY != null
      ? {
          cert: readFileSync(process.env.TLS_CERT, "utf8"),
          key: readFileSync(process.env.TLS_KEY, "utf8"),
        }
      : undefined;

  const relay = await startRelay({ port, tls });
  console.log(`relay peerId: ${relay.node.peerId.toString()}`);
  console.log("relay addrs:");
  for (const addr of relay.node.getMultiaddrs()) console.log(`  ${addr.toString()}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nrelay: received ${signal}, stopping...`);
    try {
      await relay.stop();
    } catch (err) {
      console.error("relay: error during stop:", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
