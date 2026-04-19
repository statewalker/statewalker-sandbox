/**
 * Example: WebSocket RPC Client
 *
 * This example shows how to connect to a WebSocket RPC server
 * and call remote methods.
 */

import { createWebSocketRpcClient } from "../src/websocket-rpc.js";
import type { CalculatorService } from "./calculator-service.js";

/**
 * Example client that connects to calculator service
 */
export async function connectToCalculatorService() {
  console.log("Connecting to WebSocket RPC server...");

  // Create WebSocket connection
  const ws = new WebSocket("ws://localhost:8080");

  return new Promise<void>((resolve, reject) => {
    // Wait for descriptor from server
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "descriptor") {
          console.log("Received service descriptor");

          // Create RPC client
          const client = await createWebSocketRpcClient<CalculatorService>(ws, msg.data, {
            onConnect: () => console.log("Connected to RPC server"),
            onDisconnect: () => console.log("Disconnected from RPC server"),
            onError: (error) => console.error("RPC client error:", error),
          });

          // Use the service
          console.log("Calling remote methods...");

          const sum = await client.service.add(10, 20);
          console.log("10 + 20 =", sum);

          const difference = await client.service.subtract(50, 15);
          console.log("50 - 15 =", difference);

          const product = await client.service.multiply(6, 7);
          console.log("6 * 7 =", product);

          const quotient = await client.service.divide(100, 4);
          console.log("100 / 4 =", quotient);

          const power = await client.service.power(2, 10);
          console.log("2^10 =", power);

          // Cleanup
          client.cleanup();
          resolve();
        }
      } catch (error) {
        reject(error);
      }
    };

    ws.onerror = (_error) => {
      reject(new Error("WebSocket error"));
    };
  });
}

/**
 * Example with error handling
 */
export async function connectWithErrorHandling() {
  const ws = new WebSocket("ws://localhost:8080");

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "descriptor") {
      const client = await createWebSocketRpcClient<CalculatorService>(ws, msg.data);

      try {
        // This will throw an error (division by zero)
        await client.service.divide(10, 0);
      } catch (error) {
        console.error("Remote error:", error);
        // Error was propagated from the server
      }

      // Continue using the service
      const result = await client.service.add(1, 2);
      console.log("1 + 2 =", result);

      client.cleanup();
    }
  };
}

/**
 * Example with streaming data
 */
export async function connectToStreamingService() {
  const ws = new WebSocket("ws://localhost:8080");

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "descriptor") {
      const client = await createWebSocketRpcClient(ws, msg.data);

      // Assuming the service has a streaming method
      if (client.service.generateTimeSeries) {
        console.log("Receiving streaming data...");

        for await (const point of client.service.generateTimeSeries(10, 100)) {
          console.log("Data point:", point);
        }

        console.log("Stream complete");
      }

      client.cleanup();
    }
  };
}

// Run if this file is executed directly
// if (import.meta.url === `file://${process.argv[1]}`) {
//   connectToCalculatorService().catch(console.error);
// }
