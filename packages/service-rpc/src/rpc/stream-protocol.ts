/**
 * Stream protocol for sending and receiving AsyncGenerators over RPC.
 *
 * This module provides callback-based utilities to send AsyncGenerator values
 * and reconstruct AsyncGenerators from message streams with backpressure support.
 */

import { newAsyncGenerator } from "@statewalker/shared-generators";

/**
 * Message format for iterator state.
 *
 * @template T - The type of values being streamed
 */
export type IteratorMessage<T> = ({ done: false; value: T } | { done: true; error?: unknown }) &
  Record<string, unknown>;

/**
 * Message format for iterator state with stream ID for multiplexing.
 *
 * @template T - The type of values being streamed
 */
export type StreamIteratorMessage<T> = IteratorMessage<T> & {
  streamId: string;
};

/**
 * Sends values from an AsyncGenerator through a callback function.
 *
 * Iterates over the input AsyncGenerator and calls sendMessage for each value.
 * When the generator completes, sends a done message. If an error occurs,
 * captures it in the done message.
 *
 * @template T - The type of values yielded by the generator
 * @param input - The AsyncGenerator to send
 * @param sendMessage - Callback to send each message
 *
 * @example
 * ```typescript
 * async function* numbers() {
 *   yield 1;
 *   yield 2;
 *   yield 3;
 * }
 *
 * await sendStream(numbers(), async (msg) => {
 *   console.log(msg); // { done: false, value: 1 }, etc.
 * });
 * ```
 */
export async function sendStream<T>(
  input: AsyncGenerator<T>,
  sendMessage: (message: IteratorMessage<T>) => Promise<void>,
): Promise<void> {
  try {
    for await (const value of input) {
      await sendMessage({ done: false, value });
    }
    // Generator completed successfully
    await sendMessage({ done: true });
  } catch (error) {
    // Generator threw an error - send it in the done message
    await sendMessage({ done: true, error });
  }
}

/**
 * Reconstructs an AsyncGenerator from messages delivered via a notify callback.
 *
 * This function creates an AsyncGenerator that receives values through a callback
 * mechanism, similar to the pattern used in newAsyncGenerator. The notify callback
 * is called with a message handler function (onMessage) that should be called
 * whenever a new message arrives.
 *
 * The implementation provides proper backpressure - the onMessage callback returns
 * a Promise that resolves when the value has been consumed, allowing the sender
 * to control flow based on consumer readiness.
 *
 * @template T - The type of values to be yielded
 * @param notify - Callback that receives the message handler and returns cleanup function
 * @returns AsyncGenerator that yields the received values
 * @throws Error if a message contains an error
 *
 * @example
 * ```typescript
 * const gen = receiveMessages<number>((onMessage) => {
 *   // Simulate receiving messages
 *   (async () => {
 *     await onMessage({ done: false, value: 1 });
 *     await onMessage({ done: false, value: 2 });
 *     await onMessage({ done: true });
 *   })();
 *
 *   return () => {
 *     // Cleanup logic
 *   };
 * });
 *
 * for await (const value of gen) {
 *   console.log(value); // 1, 2
 * }
 * ```
 */
export async function* receiveMessages<T>(
  notify: (
    onMessage: (message: IteratorMessage<T>) => Promise<boolean>,
  ) => void | (() => void | Promise<void>),
): AsyncGenerator<T> {
  yield* newAsyncGenerator<T>((next, done) => {
    // Create message handler that routes to next/done
    const onMessage = async (message: IteratorMessage<T>): Promise<boolean> => {
      if (message.done) {
        // Completion or error
        if ("error" in message && message.error !== undefined) {
          // Convert error to Error instance if needed
          const error =
            message.error instanceof Error ? message.error : new Error(String(message.error));
          return done(error);
        }
        return done();
      }
      // Regular value
      return next(message.value);
    };

    // Call notify with our message handler
    return notify(onMessage);
  });
}

/**
 * Registry for managing multiple streams over a single MessagePort.
 *
 * This class provides stream multiplexing by routing messages based on stream IDs.
 * Each stream gets a unique ID, and messages are routed to the appropriate handler
 * based on the streamId property.
 *
 * @example
 * ```typescript
 * const registry = new StreamRegistry();
 *
 * // Register a stream
 * const streamId = registry.generateStreamId();
 * registry.registerStream(streamId, async (message) => {
 *   console.log('Received:', message);
 *   return true;
 * });
 *
 * // Route a message to the stream
 * registry.routeMessage({ streamId, done: false, value: 42 });
 *
 * // Clean up when done
 * registry.unregisterStream(streamId);
 * ```
 */
export class StreamRegistry {
  private streams = new Map<string, (message: IteratorMessage<unknown>) => Promise<boolean>>();

  /**
   * Generates a unique stream ID using UUID v4.
   *
   * @returns A unique stream identifier
   */
  generateStreamId(): string {
    return crypto.randomUUID();
  }

  /**
   * Registers a stream handler for the given stream ID.
   *
   * @template T - The type of values in the stream
   * @param streamId - The unique identifier for this stream
   * @param onMessage - Handler function that processes messages for this stream
   */
  registerStream<T>(
    streamId: string,
    onMessage: (message: IteratorMessage<T>) => Promise<boolean>,
  ): void {
    this.streams.set(
      streamId,
      onMessage as (message: IteratorMessage<unknown>) => Promise<boolean>,
    );
  }

  /**
   * Unregisters a stream handler.
   *
   * @param streamId - The stream identifier to unregister
   */
  unregisterStream(streamId: string): void {
    this.streams.delete(streamId);
  }

  /**
   * Routes a message to the appropriate stream handler based on stream ID.
   *
   * @param message - The message containing streamId and iterator data
   * @returns Promise that resolves when the message is handled
   */
  async routeMessage(message: StreamIteratorMessage<unknown>): Promise<void> {
    const handler = this.streams.get(message.streamId);
    if (handler) {
      const { streamId: _streamId, ...iteratorMessage } = message;
      await handler(iteratorMessage);
    }
  }

  /**
   * Gets the number of registered streams.
   *
   * @returns The count of active streams
   */
  get size(): number {
    return this.streams.size;
  }

  /**
   * Checks if a stream is registered.
   *
   * @param streamId - The stream identifier to check
   * @returns True if the stream is registered
   */
  has(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  /**
   * Clears all registered streams.
   */
  clear(): void {
    this.streams.clear();
  }
}
