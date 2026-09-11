// PROTOTYPE (hub-relay) -- the browser side. Throwaway; see ../README.md.
// Driven entirely from ../run.ts through `window.proto`.
// A side-effect import, first: import sorting never moves one, and the
// wrapper must run before `@libp2p/webrtc` is evaluated.
import "./track-pcs.js";

import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { identify } from "@libp2p/identify";
import type { Connection, ConnectionGater, Stream } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import { webRTC } from "@libp2p/webrtc";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p, type Libp2p } from "libp2p";
import { hubRelayServer, membershipGater } from "../hub-relay.js";
import { pcStats, peerConnections } from "./track-pcs.js";

const SINK = "/proto/sink/1.0.0";
/** The same sink, but allowed on a limited connection -- to see what a hub circuit does to data if someone forces it. */
const SINK_LIMITED = "/proto/sink-limited/1.0.0";

type Role = "hub" | "member";

let node: Libp2p;
const members = new Set<string>();
const received: Record<string, number> = { [SINK]: 0, [SINK_LIMITED]: 0 };
let ice: RTCConfiguration = { iceServers: [] };

const describeConn = (c: Connection) => ({
  peer: c.remotePeer.toString().slice(-6),
  remoteAddr: c.remoteAddr
    .toString()
    .replace(/\/p2p\/(\w+)/g, (_m, id: string) => `/p2p/…${id.slice(-6)}`),
  limited: c.limits != null,
  direction: c.direction,
  status: c.status,
});

async function sinkHandler(stream: Stream, proto: string): Promise<void> {
  try {
    for await (const chunk of stream) received[proto] += chunk.byteLength;
    await stream.close();
  } catch {
    // a limit reset mid-stream: what was counted is the answer
  }
}

async function send(stream: Stream, bytes: number): Promise<void> {
  const chunk = new Uint8Array(16 * 1024);
  for (let sent = 0; sent < bytes; sent += chunk.byteLength) {
    if (!stream.send(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          stream.removeEventListener("drain", done);
          stream.removeEventListener("close", done);
          stream.status === "open" ? resolve() : reject(new Error(`stream ${stream.status}`));
        };
        stream.addEventListener("drain", done);
        stream.addEventListener("close", done);
      });
    }
  }
  await stream.close();
}

const proto = {
  async start(init: { role: Role }) {
    const gater: ConnectionGater = {
      denyDialMultiaddr: async () => false, // loopback/ws relay in a local run
      ...(init.role === "hub" ? membershipGater((id) => members.has(id)) : {}),
    };
    node = await createLibp2p({
      addresses: { listen: init.role === "hub" ? ["/p2p-circuit", "/webrtc"] : ["/webrtc"] },
      transports: [
        webSockets(),
        webRTC({ rtcConfiguration: async () => ice }),
        circuitRelayTransport(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionGater: gater,
      services:
        init.role === "hub"
          ? { identify: identify(), relay: hubRelayServer() }
          : { identify: identify() },
    });
    await node.handle(SINK, (stream) => sinkHandler(stream, SINK));
    await node.handle(SINK_LIMITED, (stream) => sinkHandler(stream, SINK_LIMITED), {
      runOnLimitedConnection: true,
    });
    return node.peerId.toString();
  },

  allow(peerId: string) {
    members.add(peerId);
  },

  async dial(addr: string) {
    const c = await node.dial(multiaddr(addr));
    return describeConn(c);
  },

  /**
   * Close the limited (signalling) circuit to `peerId` once a WebRTC
   * connection to it is up. Needed, not tidy: the circuit transport relays
   * through `getConnections(relay)[0]` -- the FIRST connection, limited or
   * not -- and a HOP stream cannot open on a limited one.
   */
  async dropLimited(peerId: string) {
    const conns = node.getConnections(peerIdFromString(peerId));
    const limited = conns.filter((c) => c.limits != null);
    await Promise.all(limited.map((c) => c.close()));
    return {
      closed: limited.length,
      left: node.getConnections(peerIdFromString(peerId)).map(describeConn),
    };
  },

  /** Reserve on the hub, over whatever connection we hold to it (the WebRTC one). */
  async reserveOn(hubId: string) {
    try {
      await node.components.transportManager.listen([multiaddr(`/p2p/${hubId}/p2p-circuit`)]);
    } catch (err) {
      const e = err as Error & { errors?: Error[]; cause?: Error };
      const inner = [...(e.errors ?? []), ...(e.cause ? [e.cause] : [])].map(
        (x) => `${x.name}: ${x.message}`,
      );
      throw new Error(`${e.name}${inner.length ? ` <- ${inner.join(" | ")}` : `: ${e.message}`}`);
    }
    return node
      .getMultiaddrs()
      .map(String)
      .filter((a) => a.includes(hubId));
  },

  setIce(config: RTCConfiguration) {
    ice = config;
  },

  async hangUp(peerId: string) {
    await node.hangUp(peerIdFromString(peerId));
  },

  /** Push `bytes` to `peerId` over the connection of the given kind; the receiver counts. */
  async sink(
    peerId: string,
    bytes: number,
    opts: { over: "unlimited" | "limited"; forceLimited?: boolean },
  ) {
    const conns = node.getConnections(peerIdFromString(peerId));
    const conn = conns.find((c) => (opts.over === "limited" ? c.limits != null : c.limits == null));
    if (conn == null)
      return { ok: false, error: `no ${opts.over} connection`, conns: conns.map(describeConn) };
    try {
      const stream = await conn.newStream(opts.forceLimited ? SINK_LIMITED : SINK, {
        runOnLimitedConnection: opts.forceLimited === true,
      });
      await send(stream, bytes);
      return { ok: true, via: describeConn(conn) };
    } catch (err) {
      return {
        ok: false,
        via: describeConn(conn),
        error: `${(err as Error).name}: ${(err as Error).message}`,
      };
    }
  },

  received: () => ({ ...received }),

  async state() {
    return {
      peerId: node.peerId.toString().slice(-6),
      circuitAddrs: node
        .getMultiaddrs()
        .map(String)
        .filter((a) => a.includes("p2p-circuit")).length,
      connections: node.getConnections().map(describeConn),
      peerConnections: await pcStats(),
    };
  },

  pcCount: () => peerConnections.length,
};

Object.assign(globalThis, { proto });
