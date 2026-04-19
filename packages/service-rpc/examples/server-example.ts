/**
 * Example: WebSocket RPC Server
 *
 * This example shows how to create a WebSocket server that exposes
 * an RPC service to clients.
 */

import { calculatorService } from "./calculator-service.js";

// Example using Node.js ws library (or browser WebSocket in browser context)
// import { WebSocketServer } from 'ws';

/**
 * Example server setup
 */
export function startRpcServer(port: number = 8080) {
  console.log(`Starting WebSocket RPC server on port ${port}...`);

  // Create WebSocket server
  // const wss = new WebSocketServer({ port });

  // Handle new connections
  // wss.on('connection', (ws) => {
  //   console.log('Client connected');

  //   // Create RPC server for this connection
  //   const server = createWebSocketRpcServer(ws, calculatorService, {
  //     onConnect: () => {
  //       console.log('RPC server ready');
  //
  //       // Send service descriptor to client
  //       ws.send(JSON.stringify({
  //         type: 'descriptor',
  //         data: server.descriptor
  //       }));
  //     },
  //     onDisconnect: () => {
  //       console.log('Client disconnected');
  //     },
  //     onError: (error) => {
  //       console.error('RPC server error:', error);
  //     }
  //   });
  // });

  // wss.on('error', (error) => {
  //   console.error('WebSocket server error:', error);
  // });

  // console.log(`WebSocket RPC server running on ws://localhost:${port}`);
  // console.log('Available methods:', Object.keys(calculatorService));
}

/**
 * Example with multiple services
 */
export function startMultiServiceServer() {
  // const wss = new WebSocketServer({ port: 8081 });

  // Map of service names to service objects
  const _services = {
    calculator: calculatorService,
    // Add more services here
  };

  // wss.on('connection', (ws) => {
  //   // Send available services to client
  //   ws.send(JSON.stringify({
  //     type: 'services',
  //     data: Object.keys(services)
  //   }));
  //
  //   // Client sends service name, then we expose that service
  //   ws.once('message', (data) => {
  //     const msg = JSON.parse(data.toString());
  //
  //     if (msg.type === 'selectService') {
  //       const serviceName = msg.data;
  //       const service = services[serviceName];
  //
  //       if (service) {
  //         const server = createWebSocketRpcServer(ws, service, {
  //           onConnect: () => {
  //             ws.send(JSON.stringify({
  //               type: 'descriptor',
  //               data: server.descriptor
  //             }));
  //           }
  //         });
  //       }
  //     }
  //   });
  // });
}

// Run if this file is executed directly
// if (import.meta.url === `file://${process.argv[1]}`) {
//   startRpcServer();
// }
