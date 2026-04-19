import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWebSocketRpcClient, createWebSocketRpcServer } from "../../src/ws/websocket-rpc.js";
import { createMockWebSocketPair, type MockWebSocketWithHelpers } from "./mock-websocket.js";

/**
 * WebSocket RPC Integration Tests using paired MockWebSockets
 *
 * These tests use bidirectionally connected MockWebSockets (similar to pg-mem for databases)
 * to test the full RPC stack reliably without network timing variability.
 *
 * NOTE: Async generator (streaming) methods are not supported over WebSocket
 * because Comlink's async generator transfer handler requires MessagePort transfer,
 * which doesn't work over WebSocket (WebSocket only supports JSON-serializable data).
 * Streaming operations work fine with MessageChannel (see websocket-rpc.test.ts).
 */
describe("WebSocket RPC Integration Tests", () => {
  let clientWs: MockWebSocketWithHelpers;
  let serverWs: MockWebSocketWithHelpers;
  let waitForOpen: () => Promise<void>;
  let serverCleanup: () => void;

  interface TestService {
    add(a: number, b: number): Promise<number>;
    multiply(a: number, b: number): Promise<number>;
    subtract(a: number, b: number): Promise<number>;
    divide(a: number, b: number): Promise<number>;
    throwError(): Promise<never>;
    echo(message: string): Promise<string>;
  }

  const createTestService = (): TestService => ({
    async add(a: number, b: number) {
      return a + b;
    },
    async multiply(a: number, b: number) {
      return a * b;
    },
    async subtract(a: number, b: number) {
      return a - b;
    },
    async divide(a: number, b: number) {
      if (b === 0) throw new Error("Division by zero");
      return a / b;
    },
    async throwError() {
      throw new Error("Test error from service");
    },
    async echo(message: string) {
      return `Echo: ${message}`;
    },
  });

  beforeEach(async () => {
    // Create paired MockWebSockets (like MessageChannel ports)
    const pair = createMockWebSocketPair();
    clientWs = pair.client;
    serverWs = pair.server;
    waitForOpen = pair.waitForOpen;

    // Wait for both to be open
    await waitForOpen();

    // Setup server side
    const service = createTestService();
    serverCleanup = createWebSocketRpcServer(serverWs, service);
  });

  afterEach(() => {
    serverCleanup?.();
    clientWs?.close();
    serverWs?.close();
  });

  describe("Basic RPC Operations", () => {
    it("should handle multiple sequential calls", async () => {
      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs);

      const result1 = await client.add(5, 3);
      const result2 = await client.multiply(4, 5);
      const result3 = await client.subtract(10, 3);
      const result4 = await client.divide(20, 4);

      expect(result1).toBe(8);
      expect(result2).toBe(20);
      expect(result3).toBe(7);
      expect(result4).toBe(5);

      cleanup();
    });

    it("should handle multiple concurrent calls", async () => {
      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs);

      const [result1, result2, result3, result4] = await Promise.all([
        client.add(5, 3),
        client.multiply(4, 5),
        client.subtract(10, 3),
        client.divide(20, 4),
      ]);

      expect(result1).toBe(8);
      expect(result2).toBe(20);
      expect(result3).toBe(7);
      expect(result4).toBe(5);

      cleanup();
    });

    it("should handle echo method", async () => {
      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs);

      const result = await client.echo("Hello WebSocket RPC!");
      expect(result).toBe("Echo: Hello WebSocket RPC!");

      cleanup();
    });
  });

  describe("Error Handling", () => {
    it("should propagate errors from regular methods", async () => {
      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs);

      await expect(client.throwError()).rejects.toThrow("Test error from service");

      // Should still work after error
      const result = await client.add(1, 2);
      expect(result).toBe(3);

      cleanup();
    });

    it("should handle division by zero error", async () => {
      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs);

      await expect(client.divide(10, 0)).rejects.toThrow("Division by zero");

      // Should still work after error
      const result = await client.divide(10, 2);
      expect(result).toBe(5);

      cleanup();
    });
  });

  describe("Multiple Clients", () => {
    it("should handle multiple concurrent clients", async () => {
      // Create additional client/server pairs
      const pair2 = createMockWebSocketPair();
      const pair3 = createMockWebSocketPair();

      await Promise.all([pair2.waitForOpen(), pair3.waitForOpen()]);

      const service2 = createTestService();
      const service3 = createTestService();
      const cleanup2 = createWebSocketRpcServer(pair2.server, service2);
      const cleanup3 = createWebSocketRpcServer(pair3.server, service3);

      const [client1, clientCleanup1] = await createWebSocketRpcClient<TestService>(clientWs);
      const [client2, clientCleanup2] = await createWebSocketRpcClient<TestService>(pair2.client);
      const [client3, clientCleanup3] = await createWebSocketRpcClient<TestService>(pair3.client);

      const [result1, result2, result3] = await Promise.all([
        client1.add(1, 2),
        client2.multiply(3, 4),
        client3.subtract(10, 5),
      ]);

      expect(result1).toBe(3);
      expect(result2).toBe(12);
      expect(result3).toBe(5);

      clientCleanup1();
      clientCleanup2();
      clientCleanup3();
      cleanup2();
      cleanup3();
      pair2.client.close();
      pair2.server.close();
      pair3.client.close();
      pair3.server.close();
    });
  });

  describe("Stress Tests", () => {
    it("should handle rapid sequential calls", async () => {
      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs);

      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(client.add(i, i));
      }

      const results = await Promise.all(promises);

      for (let i = 0; i < 50; i++) {
        expect(results[i]).toBe(i + i);
      }

      cleanup();
    });

    it("should handle client reconnection", async () => {
      // First connection
      const [client1, cleanup1] = await createWebSocketRpcClient<TestService>(clientWs);

      const result1 = await client1.add(5, 3);
      expect(result1).toBe(8);

      cleanup1();

      // Create new pair for second connection
      const pair2 = createMockWebSocketPair();
      await pair2.waitForOpen();

      const service2 = createTestService();
      const serverCleanup2 = createWebSocketRpcServer(pair2.server, service2);

      const [client2, cleanup2] = await createWebSocketRpcClient<TestService>(pair2.client);

      const result2 = await client2.multiply(4, 5);
      expect(result2).toBe(20);

      cleanup2();
      serverCleanup2();
      pair2.client.close();
      pair2.server.close();
    });
  });

  describe("Connection Lifecycle", () => {
    it("should trigger onConnect callback", async () => {
      const events: string[] = [];

      const [client, cleanup] = await createWebSocketRpcClient<TestService>(clientWs, {
        onConnect: () => events.push("connected"),
        onError: (error) => events.push(`error: ${error.message}`),
      });

      expect(events).toContain("connected");

      const result = await client.add(5, 3);
      expect(result).toBe(8);

      cleanup();
    });
  });
});
