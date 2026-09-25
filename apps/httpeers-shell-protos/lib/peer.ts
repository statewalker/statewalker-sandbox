import type { Catalog } from "./catalog.js";
import {
  type A2uiMessage,
  createRenderer,
  type Renderer,
  type RendererOptions,
} from "./renderer.js";

/**
 * PROTOTYPE 9 — apps arriving from peers.
 *
 * This rung adds NO features to the shell. Its value is entirely in what it
 * fails to break: every earlier rung must keep working when the messages
 * come from a remote peer instead of a local module.
 *
 * THE DESIGN CLAIM UNDER TEST (note 01): the shell does not need to know the
 * PROVENANCE of applications. A remote peer and a local module are
 * indistinguishable because both arrive as A2UI messages, and a peer's
 * identity survives only as an opaque origin string.
 *
 * WHAT THIS FILE IS NOT. There is no libp2p here, no service worker, no
 * network. `PeerTransport` is an async message source. That is deliberate:
 * the question is whether the SHELL is indifferent to provenance, and a
 * real transport would test the mesh instead. Swapping this for a libp2p
 * stream should require no change above this file — which is itself the
 * claim being made.
 */

export interface PeerTransportSpec {
  /** Opaque to the shell. Used only to build an origin string. */
  readonly peerId: string;
  /** The A2UI messages this peer serves. */
  messages(): AsyncIterable<A2uiMessage>;
  /** Optional sink for actions travelling back. */
  send?(event: unknown): void;
}

export interface PeerTransport {
  readonly peerId: string;
  /** The origin string the shell stores. A URL path, nothing peer-specific. */
  readonly origin: string;
  messages(): AsyncIterable<A2uiMessage>;
  send(event: unknown): void;
}

export function createPeerTransport(spec: PeerTransportSpec): PeerTransport {
  return {
    peerId: spec.peerId,
    /**
     * The peer becomes a PATH, not a special case. The dock stores this the
     * same way it stores "https://apps.example/notes/".
     *
     * MUTATION-DRIVEN CONSTRAINT: this must stay an opaque string. An
     * earlier test suite passed while this emitted
     * `{"peerId":"...","transport":"libp2p"}` — structured data that
     * something downstream would eventually parse, losing the provenance
     * blindness. A test now asserts it is not JSON.
     */
    origin: `/peer/${spec.peerId}/`,
    messages: () => spec.messages(),
    send: (event) => spec.send?.(event),
  };
}

export interface PeerMount {
  readonly renderer: Renderer;
  readonly origin: string;
}

/**
 * Drain a peer's messages into a renderer.
 *
 * Errors propagate. A peer that fails mid-stream must not leave a
 * half-built surface silently in place, and the caller decides what to do —
 * the shell does not invent a retry policy on the peer's behalf.
 */
export async function mountPeerApp(
  container: HTMLElement,
  transport: PeerTransport,
  catalog: Catalog,
  options: RendererOptions = {},
): Promise<PeerMount> {
  const renderer = createRenderer(container, catalog, {
    ...options,
    // Actions travel back out to the peer as well as to the local handler.
    onAction: (event) => {
      transport.send({ type: "action", ...event });
      options.onAction?.(event);
    },
  });

  for await (const message of transport.messages()) {
    // No provenance check, no sanitisation pass, no special casing. The
    // renderer's catalogue validation is the ONLY gate, and it is the same
    // gate a local module passes through.
    //
    // Mutation testing confirmed this matters: adding a pre-filter here
    // that strips disallowed components made a hostile-peer test pass for
    // the wrong reason — the shell would have been relying on a peer-path
    // filter instead of the catalogue.
    renderer.handle(message);
  }

  return { renderer, origin: transport.origin };
}
