/**
 * A `PortMux` whose ports are libp2p streams — so yamux does the multiplexing
 * and no id table exists.
 *
 * THE POINT OF THE WHOLE RUNG. `connect`/`serve` in `webrun-rpc` take ONE
 * `MessageTarget` and manufacture many virtual ports from it with an id table,
 * because from a single pipe there is no other way to get a second port. That
 * is correct for a `MessagePort` or a WebSocket, and wrong for libp2p, which
 * already multiplexes: running the id table inside yamux stacks two
 * multiplexers with no way to tell which one stalled.
 *
 * `PortMux` is already the seam that fixes this — `openPort()` outbound,
 * `onPort` inbound, `maxMessageSize` reported — so the strategy can be chosen
 * by whoever builds the mux rather than baked into the consumer. This file is
 * the implementation that was missing:
 *
 *   one pipe of bytes  -> multiplexPort   (id table; MessagePort, WebSocket)
 *   a transferable env -> transferPortMux (real ports; browser, worker, iframe)
 *   a libp2p conn      -> THIS            (a stream per port; yamux)
 *
 * A consumer written against `PortMux` then runs over all three unchanged,
 * which is what makes "the httpeers stack over any kind of port" a real claim
 * rather than an aspiration.
 */

import type { Libp2p } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";
import type { MessageTarget, PortMux } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import {
  type ConnectionContext,
  connect,
  serveConnections,
} from "@statewalker/webrun-streams-libp2p";
import { type DuplexPort, portOverDuplex } from "./port-over-duplex.js";

export const PORT_PROTOCOL = "/httpeers-portmux/1.0.0";

export interface Libp2pPortMuxInit {
  node: Libp2p;
  /** The peer to dial. Omit on a listen-only mux that never opens a port. */
  peerId?: string;
  protocol?: string;
  /** Called for each inbound stream, exactly as `PortMuxOptions.onPort` is. */
  onPort?: (port: MessageTarget, meta?: unknown) => boolean | undefined;
}

export interface Libp2pPortMux extends PortMux {
  /** How many libp2p streams this mux has opened. The measurement of the claim. */
  readonly streamsOpened: number;
  stop(): Promise<void>;
}

/**
 * Build a `PortMux` over a libp2p connection.
 *
 * Each `openPort()` opens a NEW libp2p stream and wraps it as a port. There is
 * no id table and no envelope of our own: the stream *is* the port, and
 * yamux's own flow control is the only one in the path.
 */
export async function libp2pPortMux(init: Libp2pPortMuxInit): Promise<Libp2pPortMux> {
  const protocol = init.protocol ?? PORT_PROTOCOL;
  const ports = new Set<DuplexPort>();
  let opened = 0;

  let stopServing: (() => Promise<void>) | undefined;
  if (init.onPort != null) {
    stopServing = await serveConnections(
      { node: init.node, protocol, maxInboundStreams: 512, drainTimeoutMs: 15_000 },
      (context: ConnectionContext) => {
        const peerId = context.remotePeer.toString();
        return (input) => {
          // The same inversion rung 15 needed: a server handler is handed its
          // input and must return its output, while `portOverDuplex` wants a
          // duplex it can call.
          let ours: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined;
          const inverted: Duplex = (out) => {
            ours = out;
            return asGenerator(input);
          };
          const port = portOverDuplex(inverted, { peerId });
          ports.add(port);
          init.onPort?.(port, { peerId });
          if (ours == null)
            throw new Error("libp2pPortMux: the port never claimed its outbound side");
          return asGenerator(ours);
        };
      },
    );
  }

  let dialled: Awaited<ReturnType<typeof connect>> | undefined;
  if (init.peerId != null) {
    dialled = await connect({
      node: init.node,
      peer: peerIdFromString(init.peerId),
      protocol,
      maxOutboundStreams: 512,
    });
  }

  return {
    get streamsOpened() {
      return opened;
    },
    // `maxMessageSize` is undefined on purpose: a libp2p stream is a byte
    // stream with no message ceiling, so there is nothing for layer 2 to chunk
    // to. Reporting a number here would make `duplexOverPort` split bodies for
    // no reason.
    maxMessageSize: undefined,
    async openPort() {
      if (dialled == null) {
        throw new Error("libp2pPortMux: this mux has no peer to dial — it is listen-only");
      }
      opened++;
      // `connection.call` opens a NEW libp2p stream per invocation, so each
      // port gets its own. That is the entire multiplexing, and it is yamux's.
      const port = portOverDuplex(dialled.call, { peerId: init.peerId });
      ports.add(port);
      return port;
    },
    async close() {
      for (const port of [...ports]) {
        ports.delete(port);
        port.close?.();
      }
      await dialled?.close();
    },
    async stop() {
      for (const port of [...ports]) {
        ports.delete(port);
        port.close?.();
      }
      await dialled?.close();
      await stopServing?.();
    },
  };
}

async function* asGenerator(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  yield* input as AsyncIterable<Uint8Array>;
}
