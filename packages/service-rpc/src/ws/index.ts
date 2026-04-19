/**
 * Interface for WebSocket-like objects that work with both browser and Node.js environments.
 * This allows compatibility with the browser WebSocket API and the 'ws' package.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | ArrayBuffer | Blob): void;
  close(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "open", listener: () => void): void;
  removeEventListener(type: "error", listener: () => void): void;
}

/** WebSocket readyState constants */
export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/**
 * Binds a WebSocket to a MessagePort, creating a bidirectional message bridge.
 * Messages sent through the MessagePort will be forwarded to the WebSocket,
 * and messages received from the WebSocket will be forwarded to the MessagePort.
 *
 * Note: This function assumes the WebSocket is already open. Use waitForWebSocketOpen()
 * if you need to wait for the connection to open first.
 *
 * @param ws - The WebSocket instance to bind (must be OPEN)
 * @param port - The MessagePort instance to bind
 * @returns Cleanup function that removes all event listeners and closes connections
 *
 * @example
 * ```typescript
 * const ws = new WebSocket('ws://localhost:8080');
 * await waitForWebSocketOpen(ws);
 * const { port1, port2 } = new MessageChannel();
 * const cleanup = bindWebSocketToPort(ws, port1);
 * // port2 can now be used with getServiceClient
 * // Later: cleanup();
 * ```
 */
export function bindWebSocketToPort(ws: WebSocketLike, port: MessagePort): () => void {
  let isCleanedUp = false;

  /**
   * Handle messages from the WebSocket and forward to the MessagePort
   */
  const handleWebSocketMessage = (event: MessageEvent) => {
    if (isCleanedUp) return;

    let data: unknown;

    // Handle different message types
    if (typeof event.data === "string") {
      // Parse JSON string messages
      try {
        data = JSON.parse(event.data);
      } catch {
        // If not JSON, send as-is
        data = event.data;
      }
    } else if (event.data instanceof ArrayBuffer) {
      // Send ArrayBuffer directly (transferable)
      port.postMessage(event.data, [event.data]);
      return;
    } else if (event.data instanceof Blob) {
      // Convert Blob to ArrayBuffer
      event.data.arrayBuffer().then((buffer) => {
        if (!isCleanedUp) {
          port.postMessage(buffer, [buffer]);
        }
      });
      return;
    } else {
      // Other types (already parsed objects)
      data = event.data;
    }

    port.postMessage(data);
  };

  /**
   * Handle messages from the MessagePort and forward to the WebSocket
   */
  const handlePortMessage = (event: MessageEvent) => {
    if (isCleanedUp) return;

    // Check if WebSocket is ready
    if (ws.readyState !== WS_READY_STATE.OPEN) {
      return;
    }

    const data = event.data;

    // Send binary data as-is
    if (data instanceof ArrayBuffer || data instanceof Blob) {
      ws.send(data);
    } else {
      // Send as JSON string
      ws.send(JSON.stringify(data));
    }
  };

  /**
   * Handle WebSocket close
   */
  const handleWebSocketClose = () => {
    if (!isCleanedUp) {
      cleanup();
    }
  };

  /**
   * Cleanup function that removes all event listeners and closes connections
   */
  const cleanup = () => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    // Remove all event listeners
    ws.removeEventListener("message", handleWebSocketMessage);
    ws.removeEventListener("close", handleWebSocketClose);
    port.removeEventListener("message", handlePortMessage);

    // Close connections if they're still open
    if (ws.readyState === WS_READY_STATE.OPEN || ws.readyState === WS_READY_STATE.CONNECTING) {
      ws.close();
    }
    port.close();
  };

  // Attach event listeners
  ws.addEventListener("message", handleWebSocketMessage);
  ws.addEventListener("close", handleWebSocketClose);
  port.addEventListener("message", handlePortMessage);

  // Start the port (required when using addEventListener)
  // Check if start method exists (it should on MessagePort)
  if (typeof port.start === "function") {
    port.start();
  }

  return cleanup;
}

/**
 * Type guard to check if an object is a WebSocket
 */
export function isWebSocket(obj: unknown): obj is WebSocketLike {
  return (
    obj !== null &&
    typeof obj === "object" &&
    "send" in obj &&
    "close" in obj &&
    "readyState" in obj &&
    "addEventListener" in obj
  );
}

/**
 * Helper to wait for WebSocket to open
 *
 * @param ws - The WebSocket instance
 * @param timeout - Timeout in milliseconds (default: 5000)
 * @returns Promise that resolves when WebSocket is open
 * @throws Error if timeout or connection fails
 */
export async function waitForWebSocketOpen(ws: WebSocketLike, timeout = 5000): Promise<void> {
  if (ws.readyState === WS_READY_STATE.OPEN) {
    return;
  }

  if (ws.readyState === WS_READY_STATE.CLOSED || ws.readyState === WS_READY_STATE.CLOSING) {
    throw new Error("WebSocket is closed or closing");
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("error", handleError);
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket open timeout"));
    }, timeout);

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };

    ws.addEventListener("open", handleOpen);
    ws.addEventListener("error", handleError);
  });
}
