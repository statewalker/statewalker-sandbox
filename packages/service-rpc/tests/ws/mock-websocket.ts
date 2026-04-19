/**
 * Mock WebSocket implementation for testing
 *
 * Provides bidirectional message passing between paired WebSockets,
 * similar to how MessageChannel connects two ports.
 */
export class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = MockWebSocket.CONNECTING;
  readonly OPEN = MockWebSocket.OPEN;
  readonly CLOSING = MockWebSocket.CLOSING;
  readonly CLOSED = MockWebSocket.CLOSED;

  readyState: number = MockWebSocket.CONNECTING;
  sentMessages: unknown[] = [];

  // Peer connection for paired WebSockets
  private peer: MockWebSocket | null = null;

  // Buffer for messages received before listener is attached
  private messageBuffer: unknown[] = [];
  private hasMessageListener = false;

  constructor(public url: string) {
    super();
    // Simulate async connection
    setTimeout(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      }
    }, 0);
  }

  /** Connect this WebSocket to a peer for bidirectional communication */
  connectToPeer(peer: MockWebSocket): void {
    this.peer = peer;
  }

  /** Override addEventListener to track message listeners and flush buffer */
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);

    if (type === "message" && !this.hasMessageListener) {
      this.hasMessageListener = true;
      // Flush buffered messages
      this.flushMessageBuffer();
    }
  }

  private flushMessageBuffer(): void {
    while (this.messageBuffer.length > 0) {
      const data = this.messageBuffer.shift();
      queueMicrotask(() => {
        const event = new MessageEvent("message", { data });
        this.dispatchEvent(event);
      });
    }
  }

  send(data: unknown): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sentMessages.push(data);

    // Forward message to peer if connected
    if (this.peer && this.peer.readyState === MockWebSocket.OPEN) {
      // Use queueMicrotask to simulate async message delivery
      queueMicrotask(() => {
        this.peer?.receiveFromPeer(data);
      });
    }
  }

  /** Called by peer to deliver a message */
  private receiveFromPeer(data: unknown): void {
    if (this.hasMessageListener) {
      // Dispatch immediately if listener exists
      const event = new MessageEvent("message", { data });
      this.dispatchEvent(event);
    } else {
      // Buffer message until listener is attached
      this.messageBuffer.push(data);
    }
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSING;
    setTimeout(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }, 0);
  }

  // Helper method to simulate receiving a message (for tests)
  simulateMessage(data: unknown): void {
    this.receiveFromPeer(data);
  }

  // Helper method to simulate an error
  simulateError(): void {
    this.dispatchEvent(new Event("error"));
  }
}

export type MockWebSocketWithHelpers = WebSocket & {
  simulateMessage(data: unknown): void;
  simulateError(): void;
  connectToPeer(peer: MockWebSocket): void;
  sentMessages: unknown[];
  readyState: number;
};

/**
 * Factory function to create a new MockWebSocket with proper typing
 */
export function newMockWebSocket(url: string): MockWebSocketWithHelpers {
  return new MockWebSocket(url) as unknown as MockWebSocketWithHelpers;
}

/**
 * Creates a pair of connected MockWebSockets for integration testing.
 * Similar to MessageChannel creating connected port1/port2.
 * Messages sent on one side are received by the other.
 */
export function createMockWebSocketPair(): {
  client: MockWebSocketWithHelpers;
  server: MockWebSocketWithHelpers;
  waitForOpen: () => Promise<void>;
} {
  const client = new MockWebSocket("ws://mock/client");
  const server = new MockWebSocket("ws://mock/server");

  // Connect them bidirectionally
  client.connectToPeer(server);
  server.connectToPeer(client);

  // Helper to wait for both to be open
  const waitForOpen = async (): Promise<void> => {
    const waitForOne = (ws: MockWebSocket): Promise<void> => {
      if (ws.readyState === MockWebSocket.OPEN) return Promise.resolve();
      return new Promise((resolve) => {
        ws.addEventListener("open", () => resolve(), { once: true });
      });
    };
    await Promise.all([waitForOne(client), waitForOne(server)]);
  };

  return {
    client: client as unknown as MockWebSocketWithHelpers,
    server: server as unknown as MockWebSocketWithHelpers,
    waitForOpen,
  };
}

/**
 * Setup MockWebSocket as global WebSocket for tests
 */
export function setupMockWebSocket(): void {
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
}
