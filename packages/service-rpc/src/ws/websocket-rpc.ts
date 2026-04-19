import { exposeService, getServiceClient } from "../rpc/index.js";
import type { WebSocketLike } from "./index.js";
import { bindWebSocketToPort, WS_READY_STATE, waitForWebSocketOpen } from "./index.js";

/**
 * Options for WebSocket RPC server
 */
export interface WebSocketRpcServerOptions {
  /**
   * Callback when client connects
   */
  onConnect?: () => void;

  /**
   * Callback when client disconnects
   */
  onDisconnect?: () => void;

  /**
   * Callback for errors
   */
  onError?: (error: Error) => void;
}

/**
 * Creates a WebSocket RPC server that exposes a service over WebSocket.
 * This combines exposeService and bindWebSocketToPort for easy server setup.
 *
 * @param ws - The WebSocket connection
 * @param service - The service object to expose
 * @param options - Optional callbacks for lifecycle events
 * @returns Cleanup function to close the server
 *
 * @example
 * ```typescript
 * const service = {
 *   async add(a: number, b: number) { return a + b; }
 * };
 *
 * wss.on('connection', (ws) => {
 *   const cleanup = createWebSocketRpcServer(ws, service, {
 *     onConnect: () => console.log('Client connected'),
 *     onDisconnect: () => console.log('Client disconnected'),
 *   });
 *
 *   // Later: cleanup();
 * });
 * ```
 */
export function createWebSocketRpcServer<T>(
  ws: WebSocketLike,
  service: T,
  options: WebSocketRpcServerOptions = {},
): () => void {
  const { onConnect, onDisconnect, onError } = options;

  // Create MessageChannel
  const { port1, port2 } = new MessageChannel();

  // IMPORTANT: Bind WebSocket to port1 FIRST before exposing service
  // This ensures the descriptor message can be forwarded to the client
  const cleanupBinding = bindWebSocketToPort(ws, port1);

  // Expose service on port2 (descriptor is sent automatically as first message)
  const closeService = exposeService(port2, service);

  // Setup event handlers
  const handleOpen = () => {
    onConnect?.();
  };

  const handleClose = () => {
    onDisconnect?.();
  };

  const handleError = () => {
    const error = new Error("WebSocket error in RPC server");
    onError?.(error);
  };

  ws.addEventListener("open", handleOpen);
  ws.addEventListener("close", handleClose);
  ws.addEventListener("error", handleError);

  // Trigger onConnect if already open
  if (ws.readyState === WS_READY_STATE.OPEN) {
    onConnect?.();
  }

  /**
   * Cleanup function
   */
  const cleanup = () => {
    ws.removeEventListener("open", handleOpen);
    ws.removeEventListener("close", handleClose);
    ws.removeEventListener("error", handleError);

    cleanupBinding();
    closeService();
  };

  return cleanup;
}

/**
 * Options for WebSocket RPC client
 */
export interface WebSocketRpcClientOptions {
  /**
   * Callback when connected to server
   */
  onConnect?: () => void;

  /**
   * Callback when disconnected from server
   */
  onDisconnect?: () => void;

  /**
   * Callback for errors
   */
  onError?: (error: Error) => void;

  /**
   * Timeout for waiting for connection (ms)
   */
  connectionTimeout?: number;
}

/**
 * Creates a WebSocket RPC client that connects to a remote service.
 * This combines bindWebSocketToPort and getServiceClient for easy client setup.
 *
 * @param ws - The WebSocket connection
 * @param options - Optional callbacks for lifecycle events
 * @returns Tuple of [service, cleanup] - service proxy and cleanup function
 *
 * @example
 * ```typescript
 * const ws = new WebSocket('ws://localhost:8080');
 *
 * const [service, cleanup] = await createWebSocketRpcClient(ws, {
 *   onConnect: () => console.log('Connected to server'),
 *   onDisconnect: () => console.log('Disconnected from server'),
 * });
 *
 * const result = await service.add(5, 3); // 8
 *
 * // Later: cleanup();
 * ```
 */
export async function createWebSocketRpcClient<T = Record<string, unknown>>(
  ws: WebSocketLike,
  options: WebSocketRpcClientOptions = {},
): Promise<[T, () => void]> {
  const { onConnect, onDisconnect, onError, connectionTimeout = 5000 } = options;

  // Wait for WebSocket to open if needed
  if (ws.readyState === WS_READY_STATE.CONNECTING) {
    await waitForWebSocketOpen(ws, connectionTimeout);
  }

  // Create MessageChannel
  const { port1, port2 } = new MessageChannel();

  // Bind WebSocket to port1
  const cleanupBinding = bindWebSocketToPort(ws, port1);

  // Create service client from port2 (descriptor is received automatically)
  const [service, closeClient] = await getServiceClient<T>(port2);

  // Setup event handlers
  const handleClose = () => {
    onDisconnect?.();
  };

  const handleError = () => {
    const error = new Error("WebSocket error in RPC client");
    onError?.(error);
  };

  ws.addEventListener("close", handleClose);
  ws.addEventListener("error", handleError);

  // Trigger onConnect
  onConnect?.();

  /**
   * Cleanup function
   */
  const cleanup = () => {
    ws.removeEventListener("close", handleClose);
    ws.removeEventListener("error", handleError);

    cleanupBinding();
    closeClient();
  };

  return [service, cleanup];
}
