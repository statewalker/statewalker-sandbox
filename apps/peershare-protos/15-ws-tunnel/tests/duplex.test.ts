/**
 * 15 (spike, part 2) — Can ONE request across the mesh be full-duplex?
 *
 * A WebSocket carried over the mesh needs it: frames both ways while the
 * request is still open. The Sharer's handler echoes each chunk of the
 * request body as it arrives; the Guest sends A, waits for A's echo, and only
 * then sends B. A half-duplex leg (request read whole before the response
 * starts) never echoes A, and the test says so instead of hanging.
 */

import type { MemberHandle } from "@statewalker/httpeers-member";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Relay,
  type Sharer,
  startGuest,
  startRelay,
  startSharer,
  toSharer,
} from "../../05-tab-hub-invite/src/mesh.js";

let relay: Relay;
let sharer: Sharer;
let guest: MemberHandle;

beforeAll(async () => {
  relay = await startRelay({ limits: "httpeers" });
  sharer = await startSharer({
    relayAddr: relay.addr,
    // Echo: the response body IS the request body, chunk for chunk, as it arrives.
    services: async (request) =>
      new Response(request.body, { headers: { "content-type": "application/octet-stream" } }),
  });
  guest = await startGuest({
    relayAddr: relay.addr,
    sharerPeerId: sharer.peerId,
    invitationId: (await sharer.invite()).id,
  });
}, 60_000);
afterAll(async () => {
  await guest?.stop();
  await sharer?.stop();
  await relay?.stop();
});

function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what}: nothing in ${ms} ms`)), ms),
    ),
  ]);
}

describe("15 — one request, both ways at once", () => {
  it("the Guest hears A's echo before it has sent B", async () => {
    let send!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        send = c;
      },
    });
    const enc = new TextEncoder();
    send.enqueue(enc.encode("A"));

    const res = await within(
      5_000,
      guest.fetch(
        toSharer(sharer.peerId, "/s/echo", { method: "POST", body, duplex: "half" } as RequestInit),
      ),
      "the response head",
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await within(5_000, reader.read(), "A's echo");
    expect(new TextDecoder().decode(first.value)).toBe("A");

    send.enqueue(enc.encode("B"));
    const second = await within(5_000, reader.read(), "B's echo");
    expect(new TextDecoder().decode(second.value)).toBe("B");
    send.close();
  }, 30_000);
});
