/**
 * The A2UI shell's `PeerTransport`, over a mesh duplex.
 *
 * `apps/httpeers-shell-protos/lib/peer.ts` states the claim under test in its
 * own header: "Swapping this for a libp2p stream should require no change
 * above this file." This is that swap — and the reason the duplex altitude
 * earns its place, because a fetch-only contract cannot express it.
 *
 * THE BUG THIS FILE EXISTS TO NOT HAVE. A reviewer, executing an earlier
 * sketch of this adapter, found it threw on its first `send()`:
 * `newAsyncGenerator` is an `async function*`, so its `init` callback does not
 * run — and `push` is not assigned — until the generator is FIRST PULLED. The
 * sketch wrote `let push!: …` , which hid exactly that from the compiler. A
 * transport whose first message throws is not a transport.
 *
 * The fix is a queue that predates the generator: `send()` never touches
 * `push` directly, it appends, and the generator drains. Backpressure is kept
 * where it is real — `next()` resolves only once a consumer has taken the
 * value — by having `send()` return that promise for a caller who wants it.
 */

import {
  decodeJsonl,
  decodeText,
  encodeJsonl,
  encodeText,
  newAsyncGenerator,
} from "@statewalker/webrun-streams";
import type { PeerDuplex } from "./duplex-mount.js";

/** The shape `httpeers-shell-protos/lib/peer.ts` consumes, field for field. */
export interface PeerTransport<M = unknown> {
  readonly peerId: string;
  readonly origin: string;
  messages(): AsyncIterable<M>;
  /** Fire-and-forget for the shell; the returned promise is the backpressure signal for anyone who wants it. */
  send(message: M): Promise<boolean>;
}

export function peerTransportOverDuplex<M>(duplex: PeerDuplex): PeerTransport<M> {
  // The queue predates the generator, which is the whole fix.
  const pending: { value: M; settle: (taken: boolean) => void }[] = [];
  let wake: (() => void) | null = null;

  const outbound = newAsyncGenerator<M>((next) => {
    // Runs on the FIRST PULL, not at construction — the trap.
    void (async () => {
      for (;;) {
        const item = pending.shift();
        if (item == null) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const taken = await next(item.value);
        item.settle(taken);
        if (!taken) return;
      }
    })();
  });

  const inbound = decodeJsonl<M>(decodeText(duplex.call(encodeText(encodeJsonl(outbound)))));

  // One generator, one consumer: handing the same exhausted iterator to a
  // second caller is a silent empty stream, so `messages()` returns the same
  // stream deliberately and says so.
  return {
    peerId: duplex.peerId,
    origin: `/peer/${duplex.peerId}/`,
    messages: () => inbound,
    send: (message: M) =>
      new Promise<boolean>((settle) => {
        pending.push({ value: message, settle });
        const w = wake;
        wake = null;
        w?.();
      }),
  };
}
