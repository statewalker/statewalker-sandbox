import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { getHttpServiceConfig, newHttpServiceDispatcher } from "@statewalker/service-http";
import type { WebSocketLike } from "@statewalker/service-rpc";
import { createWebSocketRpcServer, getRpcRegistry } from "@statewalker/service-rpc";
import { newAdapter } from "@statewalker/shared-adapters";
import { getLogger } from "@statewalker/shared-logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { WSContext } from "hono/ws";

export default (context: Record<string, unknown> = {}) => {
  const logger = getLogger(context);
  const [fetch, close] = newHttpServiceDispatcher(context);
  const config = getHttpServiceConfig(context);

  const app = new Hono();

  // Setup WebSocket support (only in production, not in tests)
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  if (config.cors) {
    app.use("/*", cors(config.cors));
  }

  const [getRpcCleanup, setRpcCleanup] = newAdapter<() => void, WSContext<WebSocketLike>>(
    "__rpcCleanup",
  );
  // WebSocket endpoint for RPC (only if WebSocket support is enabled)
  app.get(
    "/rpc",
    upgradeWebSocket(() => {
      return {
        onOpen: async (_event, ws) => {
          logger.info("WebSocket RPC connection opened");

          if (!ws.raw) {
            logger.error("WebSocket raw connection not available");
            return;
          }

          // Get the RPC registry from context
          const registry = getRpcRegistry(context);
          const cleanup = createWebSocketRpcServer(ws.raw, registry);

          // Create RPC server over this WebSocket connection
          setRpcCleanup(ws, cleanup);
        },
        onMessage: (event) => {
          // RPC messages are handled by createWebSocketRpcServer
          logger.debug("WebSocket RPC message received", { data: event.data });
        },
        onClose: (_event, ws) => {
          logger.info("WebSocket RPC connection closed");

          // Cleanup RPC server
          const cleanup = getRpcCleanup(ws, true);
          if (cleanup) {
            cleanup();
          }
        },
        onError: (event, ws) => {
          logger.error("WebSocket RPC error", { error: event });

          // Cleanup on error
          const cleanup = getRpcCleanup(ws, true);
          if (cleanup) {
            cleanup();
          }
        },
      };
    }),
  );

  // Regular HTTP routes
  app.all("/*", async (c) => fetch(c.req.raw));

  const server = serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
  });

  // Inject WebSocket support after server is created
  injectWebSocket(server);

  logger.info(`Server running at http://localhost:${config.port}/`);
  logger.info(`WebSocket RPC endpoint available at ws://localhost:${config.port}/rpc`);

  return async () => {
    logger.info("HTTP service is shutting down");
    close();
    server.close();
  };
};
