/**
 * `connect`/`serve`, rewritten against a `PortMux` instead of a `MessageTarget`.
 *
 * THIS IS THE WHOLE PROPOSAL, and it is twenty lines. Today's implementation
 * takes one port and builds an id table inside itself; this takes a source of
 * ports and asks it for one per call. Everything else — the framing, the
 * one-chunk window, the cancellation — is `duplexOverPort`'s, unchanged.
 *
 * What moves out of the API as a result:
 *
 *   - `side` ("initiator"/"responder") is id parity, which is `multiplexPort`'s
 *     private business. A caller over libp2p has no ids and no parity, and
 *     today's signature makes them pass one anyway.
 *   - `maxPorts` bounds an id table that may not exist.
 *   - `maxMessageSize` stops being a parameter and becomes something the mux
 *     REPORTS, which is where it was already: a libp2p stream has no ceiling,
 *     a LiveKit data channel does, and neither is the consumer's to know.
 *
 * What it buys: the same consumer runs over a MessagePort, a transferable
 * boundary, and libp2p — and on libp2p there is no second multiplexer, because
 * yamux already did it.
 */

import {
  type DuplexOverPortOptions,
  duplexOverPort,
  type MessageTarget,
  type PortMux,
  serveDuplexOverPort,
} from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";

/** Announced with every port, so a capture says what the port is for. */
const STREAM_META = { kind: "stream" } as const;

export interface OverPortMuxOptions {
  /** Per-stream inactivity timeout. Unset means none: a slow consumer is throttled, never failed. */
  timeout?: number;
}

/**
 * A caller `Duplex` over any `PortMux`.
 *
 * The port is opened on the consumer's FIRST PULL, not when `call` is invoked —
 * so a caller that builds a stream and drops it costs the peer nothing. Under
 * eager opening it would burn a port (and, on libp2p, a whole stream) for a
 * call that never arrives.
 */
export function callOverPortMux(mux: PortMux, options: OverPortMuxOptions = {}): Duplex {
  const streamOptions: DuplexOverPortOptions = {
    // REPORTED, not configured. The mux knows its own transport's ceiling.
    maxMessageSize: mux.maxMessageSize,
    timeout: options.timeout,
  };
  return (input) =>
    (async function* () {
      const port = await mux.openPort(STREAM_META);
      // `yield*` rather than a hand-rolled pump: delegation already forwards
      // `return()` and `throw()` into the stream, which is the cancellation
      // path `Duplex` specifies.
      yield* duplexOverPort(port, streamOptions)(input);
    })();
}

/**
 * Install `handler` on every port the mux accepts.
 *
 * Returns the `onPort` callback to hand to the mux at construction, plus a
 * teardown. The callback shape is why a `PortMux` cannot simply be passed in
 * already built: `multiplexPort` takes `onPort` in its OPTIONS, so a serving
 * consumer has to be wired before the mux exists. That is the one wrinkle in
 * the proposal, and it is why the API below is a factory rather than a value.
 */
export function serveOverPortMux(
  handler: Duplex,
  options: OverPortMuxOptions = {},
): {
  onPort: (port: MessageTarget) => void;
  stop: () => void;
} {
  const live = new Set<() => void>();

  return {
    onPort: (port) => {
      let off: (() => void) | undefined;
      let finished = false;
      // Tracking the handler's OUTPUT is how this side learns a stream ended —
      // on every ending, including a peer abort — so the set stays the size of
      // what is actually running rather than growing for the connection's life.
      const tracked: Duplex = (input) =>
        (async function* () {
          try {
            yield* handler(input);
          } finally {
            finished = true;
            if (off) live.delete(off);
          }
        })();
      off = serveDuplexOverPort(port, tracked, {
        maxMessageSize: undefined,
        timeout: options.timeout,
      });
      if (!finished) live.add(off);
    },
    stop: () => {
      for (const off of [...live]) {
        live.delete(off);
        try {
          off();
        } catch {
          // One stream's teardown must not strand the rest.
        }
      }
    },
  };
}
