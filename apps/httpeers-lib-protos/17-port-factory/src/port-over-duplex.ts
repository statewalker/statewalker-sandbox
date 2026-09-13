/**
 * A `MessagePort`-shaped target over a byte `Duplex` — the one primitive the
 * requirements document's connection model needs and the repo does not have.
 *
 * `webrun-rpc` ships `byteChannelFromMessagePort` (a port, seen as bytes).
 * Nothing goes the other way, and the other way is what a mesh needs: a
 * libp2p stream, seen as a port. With it, every consumer already written
 * against a `MessageTarget` — webrun-rpc's whole port stack, the browser's
 * ServiceWorker HTTP transport — runs over the mesh unchanged.
 *
 * FRAMING is length-prefixed msgpack, and it had to be. The first version used
 * JSONL, which is fine for structured values and WRONG for this: a real
 * `MessagePort` carries a `Uint8Array` by structured clone, and
 * `JSON.stringify` turns one into `{"0":1,"1":2,…}`. So every byte-oriented
 * consumer — `byteChannelFromMessagePort`, and therefore webrun-rpc's whole
 * `connect`/`serve` stack — saw a plain object, ignored it, and HUNG with no
 * error anywhere. msgpack carries binary natively.
 *
 * THE QUEUE PREDATES THE GENERATOR, which is not a style choice.
 * `newAsyncGenerator`'s init callback runs on the FIRST PULL, not at
 * construction, so a `postMessage` before anyone reads would touch an
 * unassigned `push`. Rung 09 hit exactly this and recorded it; this is the
 * same fix, and `postMessage` is fire-and-forget by contract, so it cannot
 * simply await its way around the problem.
 */

import { decodeMsgpack, encodeMsgpack } from "@statewalker/webrun-msgpack";
import type { MessageListener, MessageTarget } from "@statewalker/webrun-rpc";
import type { Duplex } from "@statewalker/webrun-streams";
import { newAsyncGenerator } from "@statewalker/webrun-streams";

export interface PortOverDuplexOptions {
  /** Reported to consumers that care; the mesh fills this with the PROVEN peer. */
  peerId?: string;
  /** Called when the far side ends the stream, or the pump fails. */
  onClose?: (error?: unknown) => void;
}

export interface DuplexPort extends MessageTarget {
  /** Who is on the other end, where the transport could prove it. */
  readonly peerId: string | undefined;
  /** Resolves when the stream has ended in either direction. */
  readonly closed: Promise<void>;
}

export function portOverDuplex(duplex: Duplex, options: PortOverDuplexOptions = {}): DuplexPort {
  const listeners = new Set<MessageListener>();
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const outbound = newAsyncGenerator<unknown>((next) => {
    void (async () => {
      for (;;) {
        if (closed && pending.length === 0) return;
        const item = pending.shift();
        if (item === undefined && pending.length === 0 && !closed) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (item === undefined) continue;
        const taken = await next(item);
        if (!taken) return;
      }
    })();
  });

  const inbound = decodeMsgpack<unknown>(duplex(encodeMsgpack(outbound)));

  const finish = (error?: unknown): void => {
    if (closed) return;
    closed = true;
    wake?.();
    wake = null;
    listeners.clear();
    resolveClosed();
    options.onClose?.(error);
  };

  /**
   * Inbound messages that arrived before anyone was listening.
   *
   * A real `MessagePort` QUEUES until `start()` (or until an `onmessage` is
   * assigned) and delivers the backlog then. Dropping them instead deadlocks
   * any consumer that attaches its listener asynchronously — `webrun-rpc`'s
   * `serve()` is awaited, so the caller's first bytes routinely beat it, and
   * the symptom is a hang with no error anywhere.
   */
  const backlog: unknown[] = [];

  const deliver = (data: unknown): void => {
    if (listeners.size === 0) {
      backlog.push(data);
      return;
    }
    // A plain object rather than `new MessageEvent`: the listener contract is
    // `event.data`, and constructing the DOM class would tie this to
    // environments that have it.
    const event = { data } as MessageEvent;
    for (const listener of [...listeners]) {
      try {
        void listener(event);
      } catch {
        // A listener that throws must not kill the port for the others.
      }
    }
  };

  const flushBacklog = (): void => {
    while (backlog.length > 0 && listeners.size > 0) {
      deliver(backlog.shift());
    }
  };

  // One pump, started eagerly: a port delivers to whoever is listening WHEN a
  // message arrives, so it cannot wait for a consumer the way an iterator can.
  void (async () => {
    try {
      for await (const data of inbound) {
        if (closed) break;
        deliver(data);
      }
      finish();
    } catch (error) {
      finish(error);
    }
  })();

  return {
    peerId: options.peerId,
    closed: closedPromise,
    addEventListener(_type, listener) {
      if (closed) return;
      listeners.add(listener);
      // Whoever listens first gets what arrived before they did.
      flushBacklog();
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    postMessage(message, transfer) {
      if (closed) return;
      if (transfer != null && transfer.length > 0) {
        // The honest limit. A real `MessagePort` moves ownership of an object
        // between two agents in one process; a mesh stream copies bytes
        // between two machines, and there is no ownership to move. Silently
        // copying would be worse than refusing: the sender would keep using a
        // handle it believes it gave away.
        throw new Error(
          "portOverDuplex: transferables cannot cross a mesh stream — send the bytes instead",
        );
      }
      pending.push(message);
      wake?.();
      wake = null;
    },
    start() {
      // Already pumping; present so a consumer written for a real
      // `MessagePort` can call it without a type guard. It still flushes,
      // because that is what `start()` means on a real port.
      flushBacklog();
    },
    close() {
      finish();
      void Promise.resolve(outbound.return?.(undefined)).catch(() => {});
      void Promise.resolve(inbound.return?.(undefined)).catch(() => {});
    },
  };
}
