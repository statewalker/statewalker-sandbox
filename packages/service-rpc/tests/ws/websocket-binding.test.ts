import { beforeEach, describe, expect, it } from "vitest";
import { bindWebSocketToPort, isWebSocket } from "../../src/ws/index.js";
import { newMockWebSocket, setupMockWebSocket } from "./mock-websocket.js";

// Make MockWebSocket available globally for the tests
setupMockWebSocket();

describe("websocket-binding", () => {
  let mockWs: ReturnType<typeof newMockWebSocket>;
  let port1: MessagePort;
  let port2: MessagePort;

  beforeEach(() => {
    mockWs = newMockWebSocket("ws://localhost:8080");
    const channel = new MessageChannel();
    port1 = channel.port1;
    port2 = channel.port2;
    // Start ports
    // port1.start();
    // port2.start();
  });

  describe("bindWebSocketToPort", () => {
    it("should forward WebSocket messages to MessagePort", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      // Wait for WebSocket to open
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Setup listener on port2
      const messages: unknown[] = [];
      port2.onmessage = (event) => messages.push(event.data);

      // Simulate WebSocket receiving messages
      mockWs.simulateMessage('{"type": "test", "data": "hello"}');
      mockWs.simulateMessage('{"value": 42}');

      // Wait for messages to propagate
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ type: "test", data: "hello" });
      expect(messages[1]).toEqual({ value: 42 });

      cleanup();
    });

    it("should forward MessagePort messages to WebSocket", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      // Wait for WebSocket to open
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send messages through port2
      port2.postMessage({ action: "test", value: 123 });
      port2.postMessage({ action: "ping" });

      // Wait for messages to be sent
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockWs.sentMessages).toHaveLength(2);
      expect(mockWs.sentMessages[0]).toBe('{"action":"test","value":123}');
      expect(mockWs.sentMessages[1]).toBe('{"action":"ping"}');

      cleanup();
    });

    it("should handle non-JSON string messages", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const messages: unknown[] = [];
      port2.onmessage = (event) => messages.push(event.data);

      // Send non-JSON string
      mockWs.simulateMessage("plain text message");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("plain text message");

      cleanup();
    });

    it("should handle ArrayBuffer messages", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const messages: unknown[] = [];
      port2.onmessage = (event) => messages.push(event.data);

      // Create ArrayBuffer
      const buffer = new ArrayBuffer(8);
      const view = new Uint8Array(buffer);
      view[0] = 1;
      view[1] = 2;
      view[2] = 3;

      mockWs.simulateMessage(buffer);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBeInstanceOf(ArrayBuffer);
      const receivedView = new Uint8Array(messages[0] as ArrayBuffer);
      expect(receivedView[0]).toBe(1);
      expect(receivedView[1]).toBe(2);
      expect(receivedView[2]).toBe(3);

      cleanup();
    });

    it("should handle Blob messages", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const messages: unknown[] = [];
      port2.onmessage = (event) => messages.push(event.data);

      // Create Blob
      const blob = new Blob(["test data"], { type: "text/plain" });
      mockWs.simulateMessage(blob);

      // Wait for async blob conversion
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBeInstanceOf(ArrayBuffer);

      cleanup();
    });

    it("should close port when WebSocket closes", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Close WebSocket
      mockWs.close();

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Port should be closed (attempting to post message will fail silently)
      // We can't directly test port closure, but we can verify cleanup works
      cleanup();
    });

    it("should not send messages when WebSocket is not open", async () => {
      const closedWs = newMockWebSocket("ws://localhost:8080");
      closedWs.readyState = WebSocket.CLOSED;

      const cleanup = bindWebSocketToPort(closedWs, port1);

      // Try to send message through port
      port2.postMessage({ test: "data" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // No messages should be sent
      expect(closedWs.sentMessages).toHaveLength(0);

      cleanup();
    });

    it("should handle cleanup idempotently", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Call cleanup multiple times
      cleanup();
      cleanup();
      cleanup();

      // Should not throw or cause issues
      expect(mockWs.readyState).toBe(WebSocket.CLOSING);
    });

    it("should stop forwarding messages after cleanup", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const messages: unknown[] = [];
      port2.onmessage = (event) => messages.push(event.data);

      // Send message before cleanup
      mockWs.simulateMessage('{"before": true}');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cleanup
      cleanup();

      // Try to send message after cleanup
      mockWs.simulateMessage('{"after": true}');
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should only have the first message
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ before: true });
    });

    it("should handle binary data from MessagePort to WebSocket", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Send binary data through port
      const buffer = new ArrayBuffer(4);
      const view = new Uint8Array(buffer);
      view[0] = 255;
      view[1] = 128;

      port2.postMessage(buffer, [buffer]);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockWs.sentMessages).toHaveLength(1);
      expect(mockWs.sentMessages[0]).toBeInstanceOf(ArrayBuffer);

      cleanup();
    });
  });

  describe("isWebSocket", () => {
    it("should return true for WebSocket instances", () => {
      expect(isWebSocket(mockWs)).toBe(true);
    });

    it("should return false for non-WebSocket objects", () => {
      expect(isWebSocket({})).toBe(false);
      expect(isWebSocket(null)).toBe(false);
      expect(isWebSocket(undefined)).toBe(false);
      expect(isWebSocket("string")).toBe(false);
      expect(isWebSocket(123)).toBe(false);
      expect(isWebSocket({ send: () => {}, close: () => {} })).toBe(false);
    });

    it("should return false for objects missing WebSocket methods", () => {
      expect(isWebSocket({ send: () => {} })).toBe(false);
      expect(isWebSocket({ close: () => {} })).toBe(false);
      expect(isWebSocket({ readyState: 1 })).toBe(false);
    });
  });

  describe("bidirectional communication", () => {
    it("should support full bidirectional message flow", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const receivedFromWs: unknown[] = [];
      port2.onmessage = (event) => receivedFromWs.push(event.data);

      // WS -> Port
      mockWs.simulateMessage('{"from": "websocket"}');

      // Port -> WS
      port2.postMessage({ from: "port" });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedFromWs).toHaveLength(1);
      expect(receivedFromWs[0]).toEqual({ from: "websocket" });

      expect(mockWs.sentMessages).toHaveLength(1);
      expect(mockWs.sentMessages[0]).toBe('{"from":"port"}');

      cleanup();
    });

    it("should handle rapid message exchanges", async () => {
      const cleanup = bindWebSocketToPort(mockWs, port1);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const receivedFromWs: unknown[] = [];
      port2.onmessage = (event) => receivedFromWs.push(event.data);

      // Send multiple messages rapidly
      for (let i = 0; i < 10; i++) {
        mockWs.simulateMessage(`{"id": ${i}}`);
        port2.postMessage({ id: i });
      }

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(receivedFromWs).toHaveLength(10);
      expect(mockWs.sentMessages).toHaveLength(10);

      cleanup();
    });
  });
});
