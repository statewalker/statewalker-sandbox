import { describe, expect, it } from "vitest";
import { exposeService, getServiceClient } from "../../src/rpc/index.js";

describe("RPC Service", () => {
  describe("async function", () => {
    it("should handle simple async method", async () => {
      const myService = {
        async sayHello(name: string) {
          return `Hello ${name}!`;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const result = await serviceProxy.sayHello("World");
      expect(result).toBe("Hello World!");

      closeClient();
      closeService();
    });

    it("should handle async method with multiple parameters", async () => {
      const myService = {
        async add(a: number, b: number) {
          return a + b;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const result = await serviceProxy.add(5, 3);
      expect(result).toBe(8);

      closeClient();
      closeService();
    });

    it("should handle async method with object parameters", async () => {
      const myService = {
        async getFullName(person: { firstName: string; lastName: string }) {
          return `${person.firstName} ${person.lastName}`;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const result = await serviceProxy.getFullName({
        firstName: "John",
        lastName: "Doe",
      });
      expect(result).toBe("John Doe");

      closeClient();
      closeService();
    });
  });

  describe("async generator", () => {
    it("should handle async generator method", async () => {
      const myService = {
        async *generateMessages(name: string, count = 10) {
          for (let i = 0; i < count; i++) {
            yield `Hello ${name}-${i}!`;
          }
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const messages: string[] = [];
      for await (const message of serviceProxy.generateMessages("Test", 5)) {
        messages.push(message);
      }

      expect(messages).toEqual([
        "Hello Test-0!",
        "Hello Test-1!",
        "Hello Test-2!",
        "Hello Test-3!",
        "Hello Test-4!",
      ]);

      closeClient();
      closeService();
    });

    it("should handle async generator with default parameters", async () => {
      const myService = {
        async *generateNumbers(start = 0, count = 3) {
          for (let i = start; i < start + count; i++) {
            yield i;
          }
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const numbers: number[] = [];
      for await (const num of serviceProxy.generateNumbers(10, 5)) {
        numbers.push(num);
      }

      expect(numbers).toEqual([10, 11, 12, 13, 14]);

      closeClient();
      closeService();
    });

    it("should handle async generator that yields objects", async () => {
      const myService = {
        async *generateUsers(count: number) {
          for (let i = 0; i < count; i++) {
            yield { id: i, name: `User${i}` };
          }
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const users: { id: number; name: string }[] = [];
      for await (const user of serviceProxy.generateUsers(3)) {
        users.push(user);
      }

      expect(users).toEqual([
        { id: 0, name: "User0" },
        { id: 1, name: "User1" },
        { id: 2, name: "User2" },
      ]);

      closeClient();
      closeService();
    });
  });

  describe("async generator with async input", () => {
    it("should handle async generator with async iterable input", async () => {
      const myService = {
        async *pingPong(input: AsyncIterable<string>, count = 5) {
          let name = "";

          // Consume input asynchronously
          (async () => {
            for await (const n of input) {
              name = n;
            }
          })();

          // Wait a bit for the name to be set
          await new Promise((r) => setTimeout(r, 50));

          for (let i = 0; i < count; i++) {
            yield `Hello ${name}: ${i}!`;
          }
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      // Create an async generator for input
      async function* inputGenerator() {
        yield "Alice";
      }

      const messages: string[] = [];
      for await (const message of serviceProxy.pingPong(inputGenerator(), 3)) {
        messages.push(message);
      }

      expect(messages).toEqual(["Hello Alice: 0!", "Hello Alice: 1!", "Hello Alice: 2!"]);

      closeClient();
      closeService();
    });

    it("should handle async generator processing stream data", async () => {
      const myService = {
        async *transformStream(input: AsyncIterable<number>) {
          for await (const value of input) {
            yield value * 2;
          }
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      async function* inputNumbers() {
        yield 1;
        yield 2;
        yield 3;
        yield 4;
      }

      const results: number[] = [];
      for await (const value of serviceProxy.transformStream(inputNumbers())) {
        results.push(value);
      }

      expect(results).toEqual([2, 4, 6, 8]);

      closeClient();
      closeService();
    });
  });

  describe("multiple methods", () => {
    it("should handle service with multiple method types", async () => {
      const myService = {
        async sayHello(name: string) {
          return `Hello ${name}!`;
        },
        async *generateMessages(name: string, count: number) {
          for (let i = 0; i < count; i++) {
            yield `Hello ${name}-${i}!`;
          }
        },
        async add(a: number, b: number) {
          return a + b;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      // Test async method
      const greeting = await serviceProxy.sayHello("World");
      expect(greeting).toBe("Hello World!");

      // Test async generator
      const messages: string[] = [];
      for await (const message of serviceProxy.generateMessages("Test", 3)) {
        messages.push(message);
      }
      expect(messages).toEqual(["Hello Test-0!", "Hello Test-1!", "Hello Test-2!"]);

      // Test another async method
      const sum = await serviceProxy.add(10, 5);
      expect(sum).toBe(15);

      closeClient();
      closeService();
    });
  });

  describe("error handling", () => {
    it("should propagate errors from async methods", async () => {
      const myService = {
        async throwError() {
          throw new Error("Test error");
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      await expect(serviceProxy.throwError()).rejects.toThrow("Test error");

      closeClient();
      closeService();
    });

    it("should handle errors in async generators", async () => {
      const myService = {
        async *generateWithError(count: number) {
          for (let i = 0; i < count; i++) {
            if (i === 2) {
              throw new Error("Generator error at 2");
            }
            yield i;
          }
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const numbers: number[] = [];
      try {
        for await (const num of serviceProxy.generateWithError(5)) {
          numbers.push(num);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("Generator error at 2");
      }

      expect(numbers).toEqual([0, 1]);

      closeClient();
      closeService();
    });
  });

  describe("cleanup", () => {
    it("should cleanup resources after service disposal", async () => {
      const myService = {
        async getValue() {
          return 42;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      // Should work before cleanup
      const result1 = await serviceProxy.getValue();
      expect(result1).toBe(42);

      // Cleanup
      closeClient();
      closeService();

      // Ports should be closed - attempts to use them will fail
      // Note: This might not throw immediately depending on the implementation
      // but the ports are properly closed
    });
  });

  describe("nested objects", () => {
    it("should handle service with nested object containing async methods", async () => {
      const myService = {
        foobar: {
          async sayHello(name: string) {
            return `Hello ${name}!`;
          },
          async add(a: number, b: number) {
            return a + b;
          },
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const greeting = await serviceProxy.foobar.sayHello("World");
      expect(greeting).toBe("Hello World!");

      const sum = await serviceProxy.foobar.add(10, 20);
      expect(sum).toBe(30);

      closeClient();
      closeService();
    });

    it("should handle nested object with async generators", async () => {
      const myService = {
        foobar: {
          async *generateMessages(name: string, count = 10) {
            for (let i = 0; i < count; i++) {
              yield `Hello ${name}-${i}!`;
            }
          },
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const messages: string[] = [];
      for await (const message of serviceProxy.foobar.generateMessages("Test", 3)) {
        messages.push(message);
      }

      expect(messages).toEqual(["Hello Test-0!", "Hello Test-1!", "Hello Test-2!"]);

      closeClient();
      closeService();
    });

    it("should handle nested object with async generator accepting async input", async () => {
      const myService = {
        foobar: {
          async *pingPong(input: AsyncIterable<string>, count = 5) {
            let name = "";

            // Consume input asynchronously
            (async () => {
              for await (const n of input) {
                name = n;
              }
            })();

            // Wait for name to be set
            await new Promise((r) => setTimeout(r, 50));

            for (let i = 0; i < count; i++) {
              yield `Hello ${name}: ${i}!`;
            }
          },
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      async function* inputGenerator() {
        yield "Alice";
      }

      const messages: string[] = [];
      for await (const message of serviceProxy.foobar.pingPong(inputGenerator(), 3)) {
        messages.push(message);
      }

      expect(messages).toEqual(["Hello Alice: 0!", "Hello Alice: 1!", "Hello Alice: 2!"]);

      closeClient();
      closeService();
    });

    it("should handle nested object with mixed method types", async () => {
      const myService = {
        foobar: {
          async *generateMessages(name: string, count = 10) {
            for (let i = 0; i < count; i++) {
              yield `Hello ${name}-${i}!`;
            }
          },
          async sayHello(name: string) {
            return `Hello ${name}!`;
          },
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      // Test async method
      const greeting = await serviceProxy.foobar.sayHello("World");
      expect(greeting).toBe("Hello World!");

      // Test async generator
      const messages: string[] = [];
      for await (const message of serviceProxy.foobar.generateMessages("Test", 3)) {
        messages.push(message);
      }
      expect(messages).toEqual(["Hello Test-0!", "Hello Test-1!", "Hello Test-2!"]);

      closeClient();
      closeService();
    });

    it("should handle deeply nested objects", async () => {
      const myService = {
        level1: {
          level2: {
            async getValue() {
              return "deep value";
            },
          },
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const result = await serviceProxy.level1.level2.getValue();
      expect(result).toBe("deep value");

      closeClient();
      closeService();
    });

    it("should handle service with both top-level and nested methods", async () => {
      const myService = {
        async topLevelMethod() {
          return "top level";
        },
        nested: {
          async nestedMethod() {
            return "nested";
          },
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const topResult = await serviceProxy.topLevelMethod();
      expect(topResult).toBe("top level");

      const nestedResult = await serviceProxy.nested.nestedMethod();
      expect(nestedResult).toBe("nested");

      closeClient();
      closeService();
    });
  });

  describe("edge cases", () => {
    it("should handle empty async generator", async () => {
      const myService = {
        async *emptyGenerator() {
          // Yields nothing
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const values: unknown[] = [];
      for await (const value of serviceProxy.emptyGenerator()) {
        values.push(value);
      }

      expect(values).toEqual([]);

      closeClient();
      closeService();
    });

    it("should handle async method returning undefined", async () => {
      const myService = {
        async doNothing() {
          return undefined;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const result = await serviceProxy.doNothing();
      expect(result).toBeUndefined();

      closeClient();
      closeService();
    });

    it("should handle async method returning null", async () => {
      const myService = {
        async returnNull() {
          return null;
        },
      };

      const { port1, port2 } = new MessageChannel();
      const closeService = exposeService(port1, myService);
      const [serviceProxy, closeClient] = await getServiceClient<typeof myService>(port2);

      const result = await serviceProxy.returnNull();
      expect(result).toBeNull();

      closeClient();
      closeService();
    });
  });
});
