/** A relay, and runtimes with PeerShare on a real mesh. */

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { memoryStorage } from "@statewalker/httpeers-hub";
import { createLibp2p } from "libp2p";
import { memoryGuestStore, memoryKeyStore, nodeMeshPlatform } from "../src/node/index.js";
import type { PeerShareInit } from "../src/public/feature.js";
import type { MeshInit } from "../src/public/mesh.js";
import { withPeerShare } from "./harness.js";

export async function startRelay(): Promise<{ addr: string; stop(): Promise<void> }> {
  const node = await createLibp2p({
    privateKey: await generateKeyPair("Ed25519"),
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    // Every test peer dials from 127.0.0.1 (rung 05, finding 4).
    connectionManager: { inboundConnectionThreshold: 1000, maxIncomingPendingConnections: 1000 },
    services: {
      identify: identify(),
      relay: circuitRelayServer({
        reservations: {
          applyDefaultLimit: true,
          defaultDataLimit: 1n << 30n,
          defaultDurationLimit: 6 * 3600_000,
        },
      }),
    },
  });
  const addr = node
    .getMultiaddrs()
    .map(String)
    .find((a) => a.includes("/ws/"));
  if (addr == null) throw new Error("relay has no ws address");
  return {
    addr,
    stop: async () => {
      await node.stop();
    },
  };
}

export const INVITE_PAGE = "https://tools.sandclaw.ai/peer-share/invite";

/** One browser's worth of mesh state: keys and hub storage, kept across "reloads". */
export function meshFor(relayAddr: string): MeshInit {
  return {
    platform: nodeMeshPlatform,
    relayAddrs: [relayAddr],
    invitePage: INVITE_PAGE,
    sharerKey: memoryKeyStore(),
    hubStorage: memoryStorage(),
    guestStore: memoryGuestStore(),
  };
}

export function onMesh(mesh: MeshInit, init: Partial<PeerShareInit> = {}) {
  return withPeerShare({ mesh, ...init });
}
