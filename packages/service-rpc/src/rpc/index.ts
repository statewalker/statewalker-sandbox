// Polyfill for MessagePort.start() in Node.js environment
// Must be before Comlink import since Comlink uses MessagePort
if (typeof MessagePort !== "undefined" && !MessagePort.prototype.start) {
  MessagePort.prototype.start = () => {
    // No-op: In Node.js, ports work without calling start()
  };
}

import * as comlink from "comlink";
import {
  type IteratorMessage,
  receiveMessages,
  type StreamIteratorMessage,
  StreamRegistry,
  sendStream,
} from "./stream-protocol.js";

type FieldDescription =
  | {
      args: string[];
      type: "method" | "stream";
    }
  | {
      type: "object";
      descriptor: Record<string, FieldDescription>;
    };

/**
 * Exposes a service over a MessagePort with automatic descriptor exchange.
 * The descriptor is sent automatically as the first message.
 * AsyncGenerators are wrapped to use the stream protocol with multiplexing.
 *
 * @param port - MessagePort to expose the service on
 * @param obj - Service object to expose
 * @returns Cleanup function to close the port
 *
 * @example
 * ```typescript
 * const { port1, port2 } = new MessageChannel();
 *
 * // Server side
 * const cleanup = exposeService(port1, {
 *   async sayHello(name: string) {
 *     return `Hello ${name}!`;
 *   }
 * });
 *
 * // Client side
 * const [client, closeClient] = await getServiceClient<MyService>(port2);
 * ```
 */
export function exposeService<T>(port: MessagePort, service: T): () => void {
  const obj = service as Record<string, unknown>;
  const descriptor = getServiceDescriptor(obj);
  const registry = new StreamRegistry();

  // Wrap the service to intercept AsyncGenerator methods
  const wrappedService = wrapServiceWithStreams(obj, descriptor, registry, port);

  // Send descriptor as the very first message before Comlink takes over
  port.postMessage({ __service_descriptor: descriptor });

  // Set up listener for incoming stream messages from client
  const handleMessage = (event: MessageEvent) => {
    const data = event.data as { __stream_message?: StreamIteratorMessage<unknown> };
    if (data.__stream_message) {
      void registry.routeMessage(data.__stream_message);
    }
  };
  port.addEventListener("message", handleMessage);

  // Then expose the wrapped service normally
  comlink.expose(wrappedService, port);

  return () => {
    port.removeEventListener("message", handleMessage);
    registry.clear();
    port.close();
  };
}

/**
 * Wraps a service object to replace AsyncGenerator methods with stream protocol handlers.
 */
function wrapServiceWithStreams(
  obj: Record<string, unknown>,
  descriptor: Record<string, FieldDescription>,
  registry: StreamRegistry,
  port: MessagePort,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  const pendingStreams = new Map<string, AsyncGenerator<unknown>>();

  // Listen for stream ready signals from client
  const handleMessage = (event: MessageEvent) => {
    const data = event.data as { __stream_ready?: string };
    if (data.__stream_ready) {
      const streamId = data.__stream_ready;
      const generator = pendingStreams.get(streamId);
      if (generator) {
        pendingStreams.delete(streamId);
        // Client is ready, start sending stream
        // sendStream already handles errors internally, so no need for catch
        void sendStream(generator, async (message: IteratorMessage<unknown>) => {
          port.postMessage({
            __stream_message: { ...message, streamId } satisfies StreamIteratorMessage<unknown>,
          });
        });
      }
    }
  };
  port.addEventListener("message", handleMessage);

  for (const [fieldName, fieldInfo] of Object.entries(descriptor)) {
    if (fieldInfo.type === "object") {
      // Nested object - recurse
      wrapped[fieldName] = wrapServiceWithStreams(
        obj[fieldName] as Record<string, unknown>,
        fieldInfo.descriptor,
        registry,
        port,
      );
    } else if (fieldInfo.type === "stream") {
      // AsyncGenerator method - wrap with stream protocol
      const originalMethod = obj[fieldName] as (...args: unknown[]) => AsyncGenerator<unknown>;
      wrapped[fieldName] = async (...args: unknown[]) => {
        // Check if any arguments are client stream markers (bidirectional streaming)
        const processedArgs: unknown[] = [];

        for (const arg of args) {
          if (
            arg !== null &&
            typeof arg === "object" &&
            "__client_stream" in arg &&
            typeof (arg as { __client_stream: unknown }).__client_stream === "string"
          ) {
            // Replace with reconstructed AsyncIterable
            const streamId = (arg as { __client_stream: string }).__client_stream;

            // Create AsyncIterable from incoming stream messages
            const asyncIterable = receiveMessages((onMessage) => {
              // Register handler for this stream
              registry.registerStream(streamId, onMessage);

              // Return cleanup function
              return () => {
                registry.unregisterStream(streamId);
              };
            });

            processedArgs.push(asyncIterable);
          } else {
            processedArgs.push(arg);
          }
        }

        const streamId = registry.generateStreamId();
        const generator = originalMethod(...processedArgs);

        // Store generator and wait for client to signal ready
        pendingStreams.set(streamId, generator);

        // Return the stream ID so client knows which stream this is
        return streamId;
      };
    } else {
      // Regular method - but need to handle client streaming arguments
      const originalMethod = obj[fieldName] as (...args: unknown[]) => Promise<unknown>;
      wrapped[fieldName] = async (...args: unknown[]) => {
        // Check if any arguments are client stream markers
        const processedArgs: unknown[] = [];

        for (const arg of args) {
          if (
            arg !== null &&
            typeof arg === "object" &&
            "__client_stream" in arg &&
            typeof (arg as { __client_stream: unknown }).__client_stream === "string"
          ) {
            // Replace with reconstructed AsyncIterable
            const streamId = (arg as { __client_stream: string }).__client_stream;

            // Create AsyncIterable from incoming stream messages
            const asyncIterable = receiveMessages((onMessage) => {
              // Register handler for this stream
              registry.registerStream(streamId, onMessage);

              // Return cleanup function
              return () => {
                registry.unregisterStream(streamId);
              };
            });

            processedArgs.push(asyncIterable);
          } else {
            processedArgs.push(arg);
          }
        }

        // Call the original method with reconstructed arguments
        return originalMethod(...processedArgs);
      };
    }
  }

  return wrapped;
}

// Helper to check if value is an AsyncIterable
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

// Build a client that properly handles different field types
function buildServiceClient<T>(
  desc: Record<string, FieldDescription>,
  proxy: Record<string, unknown>,
  registry: StreamRegistry,
  port: MessagePort,
): T {
  const client: Record<string, unknown> = {};

  for (const [fieldName, fieldInfo] of Object.entries(desc)) {
    if (fieldInfo.type === "object") {
      // Nested object - recurse
      client[fieldName] = buildServiceClient(
        fieldInfo.descriptor,
        proxy[fieldName] as Record<string, unknown>,
        registry,
        port,
      );
    } else if (fieldInfo.type === "stream") {
      // AsyncGenerator - call remote method to get stream ID, then reconstruct from messages
      client[fieldName] = async function* (...args: unknown[]) {
        const proxyField = proxy[fieldName] as (...args: unknown[]) => Promise<string>;

        // Check if any arguments are AsyncIterable (bidirectional streaming)
        const processedArgs: unknown[] = [];
        const streamGenerators: Array<{ streamId: string; generator: AsyncGenerator<unknown> }> =
          [];

        for (const arg of args) {
          if (isAsyncIterable(arg)) {
            // Replace with stream ID marker
            const streamId = registry.generateStreamId();
            processedArgs.push({ __client_stream: streamId });
            streamGenerators.push({ streamId, generator: arg as AsyncGenerator<unknown> });
          } else {
            processedArgs.push(arg);
          }
        }

        // Call the remote method to get the output stream ID
        const outputStreamId = await proxyField(...processedArgs);

        // Start streaming input data if any
        if (streamGenerators.length > 0) {
          // Give the server a moment to register handlers
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Stream all input generators concurrently (don't await - stream in background)
          void Promise.all(
            streamGenerators.map(({ streamId, generator }) =>
              sendStream(generator, async (message: IteratorMessage<unknown>) => {
                port.postMessage({
                  __stream_message: {
                    ...message,
                    streamId,
                  } satisfies StreamIteratorMessage<unknown>,
                });
              }),
            ),
          );
        }

        // Reconstruct output AsyncGenerator from incoming messages
        try {
          yield* receiveMessages((onMessage) => {
            // Register handler first
            registry.registerStream(outputStreamId, onMessage);

            // Signal to server that we're ready to receive
            port.postMessage({ __stream_ready: outputStreamId });

            // Return cleanup function
            return () => {
              registry.unregisterStream(outputStreamId);
            };
          });
        } catch (error) {
          // If error is undefined, don't throw it
          if (error !== undefined) {
            throw error;
          }
          // Otherwise just complete normally
        }
      };
    } else {
      // Regular async method - but need to handle AsyncIterable arguments
      const originalProxyField = proxy[fieldName] as (...args: unknown[]) => Promise<unknown>;
      client[fieldName] = async (...args: unknown[]) => {
        // Check if any arguments are AsyncIterable
        const processedArgs: unknown[] = [];
        const streamGenerators: Array<{ streamId: string; generator: AsyncGenerator<unknown> }> =
          [];

        for (const arg of args) {
          if (isAsyncIterable(arg)) {
            // Replace with stream ID marker
            const streamId = registry.generateStreamId();
            processedArgs.push({ __client_stream: streamId });
            streamGenerators.push({ streamId, generator: arg as AsyncGenerator<unknown> });
          } else {
            processedArgs.push(arg);
          }
        }

        // Start the method call (this will register stream handlers on server)
        const resultPromise = originalProxyField(...processedArgs);

        // After the call is initiated, start streaming the data
        // The server will have registered the handlers by now
        if (streamGenerators.length > 0) {
          // Give the server a moment to register handlers
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Stream all generators concurrently
          await Promise.all(
            streamGenerators.map(({ streamId, generator }) =>
              sendStream(generator, async (message: IteratorMessage<unknown>) => {
                port.postMessage({
                  __stream_message: {
                    ...message,
                    streamId,
                  } satisfies StreamIteratorMessage<unknown>,
                });
              }),
            ),
          );
        }

        // Return the result
        return resultPromise;
      };
    }
  }

  return client as T;
}

/**
 * Creates a client for a remote service with automatic descriptor reception.
 * Waits for the descriptor message sent by exposeService.
 *
 * @param port - MessagePort connected to the service
 * @param timeout - Timeout in milliseconds (default: 5000)
 * @returns Promise resolving to [client, cleanup]
 * @throws Error if descriptor is not received within timeout
 *
 * @example
 * ```typescript
 * const { port1, port2 } = new MessageChannel();
 *
 * // Server side
 * exposeService(port1, myService);
 *
 * // Client side
 * const [client, cleanup] = await getServiceClient<MyService>(port2);
 * const result = await client.sayHello('World');
 * ```
 */
export async function getServiceClient<T>(
  port: MessagePort,
  timeout = 5000,
): Promise<[T, () => void]> {
  // Start the port to receive messages
  // Check if start method exists (it should on MessagePort)
  if (typeof port.start === "function") {
    port.start();
  }

  // Wait for the first message which should be the descriptor
  const descriptor = await new Promise<Record<string, FieldDescription>>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      port.removeEventListener("message", handleMessage);
      reject(new Error("Timeout waiting for service descriptor"));
    }, timeout);

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.__service_descriptor) {
        clearTimeout(timeoutId);
        port.removeEventListener("message", handleMessage);
        resolve(event.data.__service_descriptor);
      }
    };

    port.addEventListener("message", handleMessage);
  });

  // Create stream registry for multiplexing
  const registry = new StreamRegistry();

  // Set up listener for incoming stream messages from server
  const handleStreamMessage = (event: MessageEvent) => {
    const data = event.data as { __stream_message?: StreamIteratorMessage<unknown> };
    if (data.__stream_message) {
      void registry.routeMessage(data.__stream_message);
    }
  };
  port.addEventListener("message", handleStreamMessage);

  // Now create the client with the received descriptor
  const comlinkProxy = comlink.wrap(port);

  const client = buildServiceClient<T>(
    descriptor,
    comlinkProxy as unknown as Record<string, unknown>,
    registry,
    port,
  );

  const close = () => {
    port.removeEventListener("message", handleStreamMessage);
    registry.clear();
    port.close();
  };

  return [client, close];
}

function getServiceDescriptor(obj: Record<string, unknown>) {
  const AsyncGenerator = async function* () {}.constructor;
  const descriptor = {} as Record<string, FieldDescription>;
  for (const fieldName in obj) {
    const fieldValue = obj[fieldName];
    if (typeof fieldValue === "object") {
      descriptor[fieldName] = {
        type: "object",
        descriptor: getServiceDescriptor(fieldValue as Record<string, unknown>),
      };
    }
    if (typeof fieldValue === "function") {
      const args = [] as string[];
      fieldValue
        .toString()
        .replaceAll(/[\r\n]/gim, " ")
        .replace(/^[^(]*\(([^)]*?)\).*$/gim, (_: string, a: string) => {
          args.push(...a.split(/\s*,\s*/gi));
          return "";
        });
      descriptor[fieldName] = {
        args,
        type: fieldValue instanceof AsyncGenerator ? "stream" : "method",
      };
    }
  }
  return descriptor;
}

export * from "./stream-protocol.js";

// NOTE: AsyncGenerator transfer handler is DISABLED for WebSocket compatibility
// When used over WebSocket, MessagePorts get JSON-serialized and lose methods like start()
// This would break client streaming (AsyncGenerator → Promise) and bidirectional streaming
//
// Instead, we rely on the stream protocol for ALL streaming cases:
// - Server streaming (JSON → AsyncGenerator): Detected by descriptor, uses stream protocol
// - Client streaming (AsyncGenerator → JSON): Detected at runtime, uses stream protocol
// - Bidirectional streaming (AsyncGenerator → AsyncGenerator): Combines both approaches
//
// Client streaming is implemented by:
// 1. Detecting AsyncIterable arguments at runtime when methods are called
// 2. Replacing them with { __client_stream: streamId } markers
// 3. Streaming the data using the stream protocol
// 4. Reconstructing the AsyncIterable on the server side

// const asyncGeneratorTransferHandler: comlink.TransferHandler<AsyncGenerator<unknown>, unknown> = {
//   canHandle(obj: unknown): obj is AsyncGenerator<unknown> {
//     if (!obj || typeof obj !== 'object') {
//       return false;
//     }
//     const o = obj as Record<string | symbol, unknown>;
//     return !!(
//       typeof (o as { next?: () => void }).next === 'function' &&
//       (typeof o[Symbol.iterator] === 'function' || typeof o[Symbol.asyncIterator] === 'function')
//     );
//   },
//   serialize(obj) {
//     return proxyTransferHandler.serialize(proxy(obj));
//   },
//   async *deserialize(obj) {
//     const iterator = proxyTransferHandler.deserialize(obj) as AsyncIterator<unknown>;
//
//     while (true) {
//       const { value, done } = await iterator.next();
//
//       if (done) {
//         break;
//       }
//
//       yield value;
//     }
//   },
// };
// comlink.transferHandlers.set('asyncGenerator', asyncGeneratorTransferHandler);
