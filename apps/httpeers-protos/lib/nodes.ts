/**
 * Two real libp2p 3.x nodes over loopback TCP. Every prototype in this app
 * uses these — no mocks, no in-process fakes. If a demo prints a result, a
 * Noise handshake and a yamux stream really happened.
 */
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import type { Libp2p } from "@libp2p/interface";
import { tcp } from "@libp2p/tcp";
import type { Multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";

export async function createNode(listen: boolean): Promise<Libp2p> {
  return createLibp2p({
    addresses: listen ? { listen: ["/ip4/127.0.0.1/tcp/0"] } : {},
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
  });
}

export interface Pair {
  server: Libp2p;
  client: Libp2p;
  serverAddr: Multiaddr;
  stop(): Promise<void>;
}

export async function createPair(): Promise<Pair> {
  const server = await createNode(true);
  const client = await createNode(false);
  const serverAddr = server.getMultiaddrs()[0];
  if (serverAddr == null) throw new Error("server has no listen address");
  return {
    server,
    client,
    serverAddr,
    async stop() {
      await Promise.allSettled([server.stop(), client.stop()]);
    },
  };
}

export const short = (id: string): string => `${id.slice(0, 8)}…${id.slice(-4)}`;

export function heading(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m\n${"─".repeat(title.length)}`);
}
