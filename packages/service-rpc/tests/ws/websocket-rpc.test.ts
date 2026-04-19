import { describe, expect, it, vi } from "vitest";
import { waitForWebSocketOpen } from "../../src/ws/index.js";
import { createWebSocketRpcServer } from "../../src/ws/websocket-rpc.js";
import { newMockWebSocket, setupMockWebSocket } from "./mock-websocket.js";

// Make MockWebSocket available globally
setupMockWebSocket();
describe("websocket-rpc", () => {
  const testService = {
    async add(a: number, b: number) {
      return a + b;
    },
  };

  describe("createWebSocketRpcServer", () => {
    it("should create RPC server and return cleanup function", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const cleanup = createWebSocketRpcServer(mockWs, testService);

      expect(typeof cleanup).toBe("function");

      cleanup();
    });

    it("should call onConnect callback", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      const onConnect = vi.fn();

      await new Promise((resolve) => setTimeout(resolve, 10));

      createWebSocketRpcServer(mockWs, testService, { onConnect });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onConnect).toHaveBeenCalled();
    });

    it("should call onDisconnect callback", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      const onDisconnect = vi.fn();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const cleanup = createWebSocketRpcServer(mockWs, testService, {
        onDisconnect,
      });

      mockWs.close();

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(onDisconnect).toHaveBeenCalled();

      cleanup();
    });

    it("should call onError callback", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      const onError = vi.fn();

      await new Promise((resolve) => setTimeout(resolve, 10));

      const cleanup = createWebSocketRpcServer(mockWs, testService, {
        onError,
      });

      mockWs.simulateError();

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onError).toHaveBeenCalled();

      cleanup();
    });

    it("should handle cleanup idempotently", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      await new Promise((resolve) => setTimeout(resolve, 10));

      const cleanup = createWebSocketRpcServer(mockWs, testService);

      cleanup();
      cleanup();
      cleanup();

      // Should not throw
    });
  });

  describe("WebSocket RPC Integration Tests", () => {
    interface TestService {
      add(a: number, b: number): Promise<number>;
      multiply(a: number, b: number): Promise<number>;
      generateNumbers(start: number, count: number): AsyncGenerator<number>;
      generateMessages(prefix: string, count: number): AsyncGenerator<string>;
      sumStream(numbers: AsyncIterable<number>): Promise<number>;
      throwError(): Promise<never>;
    }

    const createTestService = (): TestService => ({
      async add(a: number, b: number) {
        return a + b;
      },
      async multiply(a: number, b: number) {
        return a * b;
      },
      async *generateNumbers(start: number, count: number) {
        for (let i = 0; i < count; i++) {
          yield start + i;
        }
      },
      async *generateMessages(prefix: string, count: number) {
        for (let i = 0; i < count; i++) {
          yield `${prefix}-${i}`;
        }
      },
      async sumStream(numbers: AsyncIterable<number>) {
        let sum = 0;
        for await (const num of numbers) {
          sum += num;
        }
        return sum;
      },
      async throwError() {
        throw new Error("Test error");
      },
    });

    it("should handle multiple sequential calls to the same method", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      // Expose service on port1
      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      // Create client on port2
      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Make multiple sequential calls
      const result1 = await client.add(5, 3);
      const result2 = await client.add(10, 20);
      const result3 = await client.add(1, 1);

      expect(result1).toBe(8);
      expect(result2).toBe(30);
      expect(result3).toBe(2);

      closeClient();
      closeServer();
    });

    it("should handle multiple concurrent calls to different methods", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Make multiple concurrent calls
      const [result1, result2, result3] = await Promise.all([
        client.add(5, 3),
        client.multiply(4, 5),
        client.add(10, 10),
      ]);

      expect(result1).toBe(8);
      expect(result2).toBe(20);
      expect(result3).toBe(20);

      closeClient();
      closeServer();
    });

    it("should handle multiple calls to streaming methods", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // First stream
      const numbers1: number[] = [];
      for await (const num of client.generateNumbers(0, 5)) {
        numbers1.push(num);
      }
      expect(numbers1).toEqual([0, 1, 2, 3, 4]);

      // Second stream with different parameters
      const numbers2: number[] = [];
      for await (const num of client.generateNumbers(10, 3)) {
        numbers2.push(num);
      }
      expect(numbers2).toEqual([10, 11, 12]);

      // Third stream
      const messages: string[] = [];
      for await (const msg of client.generateMessages("test", 4)) {
        messages.push(msg);
      }
      expect(messages).toEqual(["test-0", "test-1", "test-2", "test-3"]);

      closeClient();
      closeServer();
    });

    it("should handle concurrent streaming method calls", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Start two streams concurrently
      const stream1Promise = (async () => {
        const numbers: number[] = [];
        for await (const num of client.generateNumbers(0, 3)) {
          numbers.push(num);
        }
        return numbers;
      })();

      const stream2Promise = (async () => {
        const messages: string[] = [];
        for await (const msg of client.generateMessages("concurrent", 3)) {
          messages.push(msg);
        }
        return messages;
      })();

      const [numbers, messages] = await Promise.all([stream1Promise, stream2Promise]);

      expect(numbers).toEqual([0, 1, 2]);
      expect(messages).toEqual(["concurrent-0", "concurrent-1", "concurrent-2"]);

      closeClient();
      closeServer();
    });

    it("should handle streaming input to methods", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Create an async generator to send
      async function* generateNumbers() {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
        yield 5;
      }

      const sum = await client.sumStream(generateNumbers());
      expect(sum).toBe(15);

      closeClient();
      closeServer();
    });

    it("should handle multiple streaming input calls", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      async function* gen1() {
        yield 1;
        yield 2;
        yield 3;
      }

      async function* gen2() {
        yield 10;
        yield 20;
      }

      const sum1 = await client.sumStream(gen1());
      const sum2 = await client.sumStream(gen2());

      expect(sum1).toBe(6);
      expect(sum2).toBe(30);

      closeClient();
      closeServer();
    });

    it("should handle mixed regular and streaming calls", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Regular call
      const sum1 = await client.add(5, 3);
      expect(sum1).toBe(8);

      // Streaming call
      const numbers: number[] = [];
      for await (const num of client.generateNumbers(0, 3)) {
        numbers.push(num);
      }
      expect(numbers).toEqual([0, 1, 2]);

      // Another regular call
      const product = await client.multiply(4, 5);
      expect(product).toBe(20);

      // Another streaming call
      const messages: string[] = [];
      for await (const msg of client.generateMessages("test", 2)) {
        messages.push(msg);
      }
      expect(messages).toEqual(["test-0", "test-1"]);

      closeClient();
      closeServer();
    });

    it("should handle errors in regular methods", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      await expect(client.throwError()).rejects.toThrow("Test error");

      // Should still work after error
      const result = await client.add(1, 2);
      expect(result).toBe(3);

      closeClient();
      closeServer();
    });

    it("should handle errors during streaming", async () => {
      const { port1, port2 } = new MessageChannel();

      const serviceWithErrorStream = {
        async *generateWithError(count: number) {
          for (let i = 0; i < count; i++) {
            if (i === 2) {
              throw new Error("Stream error at index 2");
            }
            yield i;
          }
        },
      };

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, serviceWithErrorStream);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      type ErrorStreamService = typeof serviceWithErrorStream;
      const [client, closeClient] = await getServiceClient<ErrorStreamService>(port2);

      const numbers: number[] = [];
      try {
        for await (const num of client.generateWithError(5)) {
          numbers.push(num);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Stream error at index 2");
      }

      expect(numbers).toEqual([0, 1]);

      closeClient();
      closeServer();
    });

    it("should handle rapid sequential calls", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Make 20 rapid sequential calls
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(client.add(i, i));
      }

      const results = await Promise.all(promises);

      // Verify all results
      for (let i = 0; i < 20; i++) {
        expect(results[i]).toBe(i + i);
      }

      closeClient();
      closeServer();
    });

    it("should handle large streaming data", async () => {
      const { port1, port2 } = new MessageChannel();
      const service = createTestService();

      const { exposeService } = await import("../../src/rpc/index.js");
      const closeServer = exposeService(port1, service);

      const { getServiceClient } = await import("../../src/rpc/index.js");
      const [client, closeClient] = await getServiceClient<TestService>(port2);

      // Stream 1000 numbers
      const numbers: number[] = [];
      for await (const num of client.generateNumbers(0, 1000)) {
        numbers.push(num);
      }

      expect(numbers.length).toBe(1000);
      expect(numbers[0]).toBe(0);
      expect(numbers[999]).toBe(999);

      closeClient();
      closeServer();
    });
  });

  describe("waitForWebSocketOpen", () => {
    it("should resolve immediately if WebSocket is already open", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockWs.readyState = WebSocket.OPEN;

      await expect(waitForWebSocketOpen(mockWs)).resolves.toBeUndefined();
    });

    it("should wait for WebSocket to open", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");

      const promise = waitForWebSocketOpen(mockWs);

      await new Promise((resolve) => setTimeout(resolve, 20));

      await expect(promise).resolves.toBeUndefined();
    });

    it("should reject if WebSocket is closed", async () => {
      const mockWs = newMockWebSocket("ws://localhost:8080");
      mockWs.readyState = WebSocket.CLOSED;

      await expect(waitForWebSocketOpen(mockWs)).rejects.toThrow("WebSocket is closed or closing");
    });
  });
});
