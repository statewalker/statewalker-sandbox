/**
 * A libp2p connection that hands out ports.
 *
 * ONE LIBP2P STREAM IS ONE PORT, and that is the whole design decision. The
 * tempting alternative — one stream carrying `multiplexPort` — would run our
 * multiplexer inside yamux's, two credit systems stacked with no way to tell
 * which one stalled. yamux already opens cheap independent streams with its
 * own flow control, so the mesh's multiplexing stays yamux's and this layer
 * adds none.
 *
 * Identity comes from the transport and only from the transport:
 * `serveConnections` hands each inbound stream a `ConnectionContext` carrying
 * the Noise-proven `remotePeer`, and it is captured per stream by closure —
 * the same seam rung 11 uses, for the same reason (a duplex has no `Request`
 * to hang a `WeakMap` off).
 */

import type { Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { Duplex } from "@statewalker/webrun-streams";
import { connect, serveConnections } from "@statewalker/webrun-streams-libp2p";
import { type DuplexPort, portOverDuplex } from "./port-over-duplex.js";

export const PORT_PROTOCOL = "/httpeers-port/1.0.0";

export interface ServePortsInit {
  node: Libp2p;
  protocol?: string;
  maxInboundStreams?: number;
}

/** Accept inbound streams, handing each one to `onPort` as a port. */
export async function servePorts(
  init: ServePortsInit,
  onPort: (port: DuplexPort) => void,
): Promise<() => Promise<void>> {
  return await serveConnections(
    {
      node: init.node,
      protocol: init.protocol ?? PORT_PROTOCOL,
      maxInboundStreams: init.maxInboundStreams ?? 512,
      drainTimeoutMs: 15_000,
    },
    (context) => {
      const peerId = context.remotePeer.toString();
      return (input) => {
        // `portOverDuplex` wants a duplex it can CALL; a server handler is
        // handed its input and must return its output. Bridging the two is
        // this inversion: capture what the port wants to send, hand it the
        // input as its inbound, and return the captured side.
        let ours: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined;
        const inverted: Duplex = (out) => {
          ours = out;
          return asGenerator(input);
        };
        // Synchronous by construction: `portOverDuplex` calls the duplex while
        // building its inbound pipeline, so `ours` is assigned before this
        // returns. If that ever stops being true the `??` below fails loudly
        // rather than serving an empty stream.
        onPort(portOverDuplex(inverted, { peerId }));
        if (ours == null) throw new Error("servePorts: the port never claimed its outbound side");
        return asGenerator(ours);
      };
    },
  );
}

export interface OpenPortInit {
  node: Libp2p;
  peerId: string;
  protocol?: string;
}

export interface OpenedPort {
  port: DuplexPort;
  close(): Promise<void>;
}

/** Dial a peer and open one port on it. */
export async function openPort(init: OpenPortInit): Promise<OpenedPort> {
  const connection = await connect({
    node: init.node,
    peer: peerIdFromString(init.peerId),
    protocol: init.protocol ?? PORT_PROTOCOL,
    maxOutboundStreams: 512,
  });
  const port = portOverDuplex(connection.call, { peerId: init.peerId });
  return {
    port,
    async close() {
      port.close?.();
      await connection.close();
    },
  };
}

async function* asGenerator(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield* input as AsyncIterable<Uint8Array>;
}
