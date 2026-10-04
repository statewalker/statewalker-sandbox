import { describe, expect, it } from "vitest";
import { createWebSocketRpcClient } from "../../src/ws/websocket-rpc.js";

/**
 * A socket that behaves like Node's `ws` where it matters here: it does NOT buffer messages for
 * listeners attached later, and it can deliver the server's first message in the same tick as
 * "open" (`ws` does when that message arrives together with the upgrade response). The shared
 * MockWebSocket buffers, which is why it could not show this.
 */
class UnbufferedSocket extends EventTarget {
  readyState = 0; // CONNECTING

  send(): void {}

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  /** Open, and deliver `data` synchronously right after the "open" event. */
  openWith(data: string): void {
    this.readyState = 1; // OPEN
    this.dispatchEvent(new Event("open"));
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

describe("createWebSocketRpcClient", () => {
  it("receives a service descriptor sent in the same tick as the socket opening", async () => {
    const socket = new UnbufferedSocket();
    const pending = createWebSocketRpcClient<{ add: (a: number, b: number) => number }>(
      socket as never,
    );

    socket.openWith(
      JSON.stringify({ __service_descriptor: { add: { type: "method", args: ["a", "b"] } } }),
    );

    // The descriptor wait times out after 5s; a client that missed the message never resolves
    // before that.
    const outcome = await Promise.race([
      pending.then(([service, cleanup]) => {
        cleanup();
        return typeof service.add;
      }),
      new Promise((resolve) => setTimeout(() => resolve("missed the descriptor"), 1000)),
    ]);
    expect(outcome).toBe("function");
  });
});
