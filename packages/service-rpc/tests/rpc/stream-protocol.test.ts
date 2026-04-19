import { describe, expect, it } from "vitest";
import {
  type IteratorMessage,
  receiveMessages,
  sendStream,
} from "../../src/rpc/stream-protocol.js";

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Stream Protocol", () => {
  describe("sendStream", () => {
    it("should send messages for each value and completion", async () => {
      async function* source() {
        yield 1;
        yield 2;
        yield 3;
      }

      const messages: IteratorMessage<number>[] = [];
      await sendStream(source(), async (msg) => {
        messages.push(msg);
      });

      expect(messages).toHaveLength(4); // 3 values + 1 done
      expect(messages[0]).toEqual({ done: false, value: 1 });
      expect(messages[1]).toEqual({ done: false, value: 2 });
      expect(messages[2]).toEqual({ done: false, value: 3 });
      expect(messages[3]).toEqual({ done: true });
    });

    it("should handle empty async generator", async () => {
      async function* source() {
        // Empty generator
      }

      const messages: IteratorMessage<number>[] = [];
      await sendStream(source(), async (msg) => {
        messages.push(msg);
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ done: true });
    });

    it("should capture errors in done message", async () => {
      async function* source() {
        yield 1;
        yield 2;
        throw new Error("Test error");
      }

      const messages: IteratorMessage<number>[] = [];
      await sendStream(source(), async (msg) => {
        messages.push(msg);
      });

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ done: false, value: 1 });
      expect(messages[1]).toEqual({ done: false, value: 2 });
      expect(messages[2].done).toBe(true);
      const lastMsg = messages[2];
      if (lastMsg?.done) {
        expect(lastMsg.error).toBeInstanceOf(Error);
        expect((lastMsg.error as Error).message).toBe("Test error");
      }
    });

    it("should handle objects as values", async () => {
      async function* source() {
        yield { id: 1, name: "Alice" };
        yield { id: 2, name: "Bob" };
      }

      const messages: IteratorMessage<{ id: number; name: string }>[] = [];
      await sendStream(source(), async (msg) => {
        messages.push(msg);
      });

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ done: false, value: { id: 1, name: "Alice" } });
      expect(messages[1]).toEqual({ done: false, value: { id: 2, name: "Bob" } });
      expect(messages[2]).toEqual({ done: true });
    });
  });

  describe("receiveMessages", () => {
    it("should reconstruct async generator from notify callback", async () => {
      let producerDone: Promise<void> | undefined;

      const gen = receiveMessages<number>((onMessage) => {
        producerDone = (async () => {
          try {
            await delay(0); // Let generator start
            await onMessage({ done: false, value: 1 });
            await onMessage({ done: false, value: 2 });
            await onMessage({ done: false, value: 3 });
            await onMessage({ done: true });
          } catch {
            // Errors handled by consumer
          }
        })();
        return () => {
          // Cleanup
        };
      });

      const values: number[] = [];
      for await (const value of gen) {
        values.push(value);
      }

      // Wait for producer to finish and any cleanup
      await Promise.allSettled([producerDone]);
      await delay(10);

      expect(values).toEqual([1, 2, 3]);
    });

    it("should handle empty stream", async () => {
      let producerDone: Promise<void> | undefined;

      const gen = receiveMessages<number>((onMessage) => {
        producerDone = (async () => {
          try {
            await onMessage({ done: true });
          } catch {
            // Errors handled by consumer
          }
        })();
        return () => {
          // Cleanup
        };
      });

      const values: number[] = [];
      for await (const value of gen) {
        values.push(value);
      }

      // Wait for producer to finish and any cleanup
      await Promise.allSettled([producerDone]);
      await delay(10);

      expect(values).toEqual([]);
    });

    // TODO: Add error handling test once async timing issues are resolved

    it("should call cleanup function", async () => {
      let cleaned = false;
      let producerDone: Promise<void> | undefined;

      const gen = receiveMessages<number>((onMessage) => {
        producerDone = (async () => {
          try {
            await delay(0); // Let generator start
            await onMessage({ done: false, value: 1 });
            await onMessage({ done: false, value: 2 });
            await onMessage({ done: true });
          } catch {
            // Errors handled by consumer
          }
        })();
        return () => {
          cleaned = true;
        };
      });

      const values: number[] = [];
      for await (const value of gen) {
        values.push(value);
      }

      // Wait for producer to finish and any cleanup
      await Promise.allSettled([producerDone]);
      await delay(10);

      expect(values).toEqual([1, 2]);
      expect(cleaned).toBe(true);
    });

    it("should handle backpressure with awaited onMessage", async () => {
      const events: string[] = [];
      let producerDone: Promise<void> | undefined;

      const gen = receiveMessages<number>((onMessage) => {
        producerDone = (async () => {
          try {
            for (let i = 0; i < 3; i++) {
              events.push(`produce-${i}`);
              const handled = await onMessage({ done: false, value: i });
              events.push(`produced-${i}-${handled}`);
            }
            await onMessage({ done: true });
          } catch {
            // Errors handled by consumer
          }
        })();
        return () => {
          // Cleanup
        };
      });

      for await (const value of gen) {
        events.push(`consume-${value}`);
        await delay(5); // Slow consumer
        events.push(`consumed-${value}`);
      }

      // Wait for producer to finish and any cleanup
      await Promise.allSettled([producerDone]);
      await delay(10);

      // Producer awaits onMessage(), so backpressure is applied
      expect(events).toContain("produce-0");
      expect(events).toContain("produced-0-true");
      expect(events).toContain("consume-0");
      expect(events).toContain("consumed-0");
    });
  });

  // TODO: Add round-trip tests once async coordination issues are resolved

  describe("StreamRegistry", () => {
    it("should generate unique stream IDs", async () => {
      const { StreamRegistry } = await import("../../src/rpc/stream-protocol.js");
      const registry = new StreamRegistry();

      const id1 = registry.generateStreamId();
      const id2 = registry.generateStreamId();

      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it("should register and unregister streams", async () => {
      const { StreamRegistry } = await import("../../src/rpc/stream-protocol.js");
      const registry = new StreamRegistry();

      const streamId = registry.generateStreamId();
      const handler = async () => true;

      expect(registry.has(streamId)).toBe(false);
      expect(registry.size).toBe(0);

      registry.registerStream(streamId, handler);

      expect(registry.has(streamId)).toBe(true);
      expect(registry.size).toBe(1);

      registry.unregisterStream(streamId);

      expect(registry.has(streamId)).toBe(false);
      expect(registry.size).toBe(0);
    });

    it("should route messages to correct stream handler", async () => {
      const { StreamRegistry } = await import("../../src/rpc/stream-protocol.js");
      const registry = new StreamRegistry();

      const streamId1 = registry.generateStreamId();
      const streamId2 = registry.generateStreamId();

      const messages1: unknown[] = [];
      const messages2: unknown[] = [];

      registry.registerStream(streamId1, async (msg) => {
        messages1.push(msg);
        return true;
      });

      registry.registerStream(streamId2, async (msg) => {
        messages2.push(msg);
        return true;
      });

      await registry.routeMessage({ streamId: streamId1, done: false, value: "stream1-msg1" });
      await registry.routeMessage({ streamId: streamId2, done: false, value: "stream2-msg1" });
      await registry.routeMessage({ streamId: streamId1, done: false, value: "stream1-msg2" });

      expect(messages1).toHaveLength(2);
      expect(messages1[0]).toEqual({ done: false, value: "stream1-msg1" });
      expect(messages1[1]).toEqual({ done: false, value: "stream1-msg2" });

      expect(messages2).toHaveLength(1);
      expect(messages2[0]).toEqual({ done: false, value: "stream2-msg1" });
    });

    it("should handle messages for unregistered streams gracefully", async () => {
      const { StreamRegistry } = await import("../../src/rpc/stream-protocol.js");
      const registry = new StreamRegistry();

      const nonExistentStreamId = registry.generateStreamId();

      // Should not throw
      await expect(
        registry.routeMessage({ streamId: nonExistentStreamId, done: false, value: "test" }),
      ).resolves.toBeUndefined();
    });

    it("should clear all streams", async () => {
      const { StreamRegistry } = await import("../../src/rpc/stream-protocol.js");
      const registry = new StreamRegistry();

      const streamId1 = registry.generateStreamId();
      const streamId2 = registry.generateStreamId();

      registry.registerStream(streamId1, async () => true);
      registry.registerStream(streamId2, async () => true);

      expect(registry.size).toBe(2);

      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.has(streamId1)).toBe(false);
      expect(registry.has(streamId2)).toBe(false);
    });

    it("should multiplex concurrent streams", async () => {
      const { StreamRegistry } = await import("../../src/rpc/stream-protocol.js");
      const registry = new StreamRegistry();

      const streamId1 = registry.generateStreamId();
      const streamId2 = registry.generateStreamId();

      const stream1Values: number[] = [];
      const stream2Values: number[] = [];

      registry.registerStream<number>(streamId1, async (msg) => {
        if (!msg.done) {
          stream1Values.push(msg.value);
        }
        return true;
      });

      registry.registerStream<number>(streamId2, async (msg) => {
        if (!msg.done) {
          stream2Values.push(msg.value);
        }
        return true;
      });

      // Interleave messages from both streams
      await registry.routeMessage({ streamId: streamId1, done: false, value: 1 });
      await registry.routeMessage({ streamId: streamId2, done: false, value: 10 });
      await registry.routeMessage({ streamId: streamId1, done: false, value: 2 });
      await registry.routeMessage({ streamId: streamId2, done: false, value: 20 });
      await registry.routeMessage({ streamId: streamId1, done: false, value: 3 });
      await registry.routeMessage({ streamId: streamId2, done: false, value: 30 });

      expect(stream1Values).toEqual([1, 2, 3]);
      expect(stream2Values).toEqual([10, 20, 30]);
    });
  });
});
