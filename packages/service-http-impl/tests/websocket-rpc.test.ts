import { getHttpServiceConfig, setHttpServiceConfig } from "@statewalker/service-http";
import { createWebSocketRpcClient, newRpcAdapter } from "@statewalker/service-rpc";
import { newRegistry } from "@statewalker/shared-registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import createHttpService from "../src/index.js";

describe("WebSocket RPC Integration with Real Server", () => {
  let context: Record<string, unknown>;
  let port: number;
  let cleanup: (() => Promise<void>) | undefined;
  let wsUrl: string;

  beforeEach(async () => {
    context = {};
    port = 9000 + Math.floor(Math.random() * 1000); // Random port to avoid conflicts
    wsUrl = `ws://localhost:${port}/rpc`;
  });

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
    // Wait for server to fully shut down
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  describe("Basic RPC communication", () => {
    it("should expose RPC services over WebSocket", async () => {
      // Setup HTTP server with RPC services
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      // Register a calculator service
      const [, setCalculator] = newRpcAdapter<{
        add: (a: number, b: number) => number;
        subtract: (a: number, b: number) => number;
      }>("calculator");

      setCalculator(context, {
        add: (a, b) => a + b,
        subtract: (a, b) => a - b,
      });

      // Start HTTP server
      const shutdown = createHttpService(context);
      register(shutdown);

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Connect WebSocket client
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
      });

      try {
        // Create RPC client
        const [service, cleanup] = await createWebSocketRpcClient<{
          calculator: {
            add: (a: number, b: number) => number;
            subtract: (a: number, b: number) => number;
          };
        }>(ws);
        register(cleanup);

        // Wait for RPC to be ready
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Test calculator methods
        const sumResult = await service.calculator.add(5, 3);
        expect(sumResult).toBe(8);

        const diffResult = await service.calculator.subtract(10, 4);
        expect(diffResult).toBe(6);
      } finally {
        ws.close();
      }
    }, 10000);

    it("should handle multiple services", async () => {
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      // Register calculator service
      type Calculator = {
        multiply: (a: number, b: number) => number;
      };
      const [, setCalculator] = newRpcAdapter<Calculator>("calculator");

      setCalculator(context, {
        multiply: (a, b) => a * b,
      } as Calculator);

      // Register user service
      type UserService = {
        getUser: (id: string) => { id: string; name: string };
      };
      const [, setUser] = newRpcAdapter<UserService>("user");

      setUser(context, {
        getUser: (id) => ({ id, name: `User ${id}` }),
      } as UserService);

      // Start server
      const shutdown = createHttpService(context);
      register(shutdown);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Connect client
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
      });

      try {
        const [service, cleanup] = await createWebSocketRpcClient<{
          calculator: { multiply: (a: number, b: number) => number };
          user: { getUser: (id: string) => { id: string; name: string } };
        }>(ws);
        register(cleanup);

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Test calculator
        const product = await service.calculator.multiply(7, 6);
        expect(product).toBe(42);

        // Test user service
        const user = await service.user.getUser("123");
        expect(user).toEqual({ id: "123", name: "User 123" });
      } finally {
        ws.close();
      }
    }, 10000);

    it("should handle async methods", async () => {
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      // Register async service
      type AsyncService = {
        delayedAdd: (a: number, b: number) => Promise<number>;
        fetchData: (id: string) => Promise<{ id: string; data: string }>;
      };
      const [, setAsync] = newRpcAdapter<AsyncService>("async");

      setAsync(context, {
        delayedAdd: async (a, b) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return a + b;
        },
        fetchData: async (id) => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { id, data: `Data for ${id}` };
        },
      } as AsyncService);

      const shutdown = createHttpService(context);
      register(shutdown);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
      });

      try {
        const [service, cleanup] = await createWebSocketRpcClient<{
          async: {
            delayedAdd: (a: number, b: number) => Promise<number>;
            fetchData: (id: string) => Promise<{ id: string; data: string }>;
          };
        }>(ws);
        register(cleanup);

        await new Promise((resolve) => setTimeout(resolve, 200));

        const result = await service.async.delayedAdd(10, 20);
        expect(result).toBe(30);

        const data = await service.async.fetchData("test-id");
        expect(data).toEqual({ id: "test-id", data: "Data for test-id" });
      } finally {
        ws.close();
      }
    }, 10000);
  });

  describe("Connection lifecycle", () => {
    it("should handle multiple sequential connections", async () => {
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      const [, setCalculator] = newRpcAdapter<{
        add: (a: number, b: number) => number;
      }>("calculator");

      setCalculator(context, {
        add: (a, b) => a + b,
      });

      const shutdown = createHttpService(context);
      register(shutdown);
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First connection
      {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          ws.on("open", resolve);
          ws.on("error", reject);
          setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
        });

        const [service, cleanup] = await createWebSocketRpcClient<{
          calculator: { add: (a: number, b: number) => number };
        }>(ws);

        await new Promise((resolve) => setTimeout(resolve, 200));

        const result = await service.calculator.add(1, 2);
        expect(result).toBe(3);

        cleanup();
        ws.close();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Second connection
      {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
          ws.on("open", resolve);
          ws.on("error", reject);
          setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
        });

        const [service, cleanup] = await createWebSocketRpcClient<{
          calculator: { add: (a: number, b: number) => number };
        }>(ws);

        await new Promise((resolve) => setTimeout(resolve, 200));

        const result = await service.calculator.add(5, 5);
        expect(result).toBe(10);

        cleanup();
        ws.close();
      }
    }, 15000);

    it("should handle concurrent RPC calls from same client", async () => {
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      const [, setCalculator] = newRpcAdapter<{
        multiply: (a: number, b: number) => Promise<number>;
        add: (a: number, b: number) => Promise<number>;
        subtract: (a: number, b: number) => Promise<number>;
      }>("calculator");

      setCalculator(context, {
        multiply: async (a, b) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return a * b;
        },
        add: async (a, b) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return a + b;
        },
        subtract: async (a, b) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return a - b;
        },
      });

      const shutdown = createHttpService(context);
      register(shutdown);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
      });

      try {
        const [service, cleanup] = await createWebSocketRpcClient<{
          calculator: {
            multiply: (a: number, b: number) => Promise<number>;
            add: (a: number, b: number) => Promise<number>;
            subtract: (a: number, b: number) => Promise<number>;
          };
        }>(ws);
        register(cleanup);

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Test multiple concurrent RPC calls
        const results = await Promise.all([
          service.calculator.multiply(2, 3),
          service.calculator.add(10, 20),
          service.calculator.subtract(100, 50),
          service.calculator.multiply(4, 5),
        ]);

        expect(results).toEqual([6, 30, 50, 20]);
      } finally {
        ws.close();
      }
    }, 10000);
  });

  describe("Error handling", () => {
    it("should handle connection to invalid endpoint", async () => {
      const ws = new WebSocket(`ws://localhost:${port + 1}/rpc`);

      await expect(
        new Promise((resolve, reject) => {
          ws.on("open", resolve);
          ws.on("error", reject);
          setTimeout(() => reject(new Error("Connection timeout")), 2000);
        }),
      ).rejects.toThrow();
    }, 5000);

    it("should handle service errors gracefully", async () => {
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      const [, setCalculator] = newRpcAdapter<{
        divide: (a: number, b: number) => number;
      }>("calculator");

      setCalculator(context, {
        divide: (a, b) => {
          if (b === 0) {
            throw new Error("Division by zero");
          }
          return a / b;
        },
      });

      const shutdown = createHttpService(context);
      register(shutdown);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
      });

      try {
        const [service, cleanup] = await createWebSocketRpcClient<{
          calculator: { divide: (a: number, b: number) => number };
        }>(ws);
        register(cleanup);

        await new Promise((resolve) => setTimeout(resolve, 200));

        // Valid division
        const validResult = await service.calculator.divide(10, 2);
        expect(validResult).toBe(5);

        // Division by zero should throw
        await expect(service.calculator.divide(10, 0)).rejects.toThrow();
      } finally {
        ws.close();
      }
    }, 10000);
  });

  describe("Complex data types", () => {
    it("should handle complex objects", async () => {
      const httpConfig = getHttpServiceConfig(context);
      const [register, cleanupRegistry] = newRegistry();
      cleanup = cleanupRegistry;

      setHttpServiceConfig(context, { ...httpConfig, port });

      interface User {
        id: string;
        name: string;
        email: string;
        metadata: Record<string, unknown>;
      }

      const [, setUserService] = newRpcAdapter<{
        createUser: (data: Omit<User, "id">) => User;
        updateUser: (id: string, updates: Partial<User>) => User;
      }>("userService");

      const users = new Map<string, User>();

      setUserService(context, {
        createUser: (data) => {
          const user: User = { id: `user-${Date.now()}`, ...data };
          users.set(user.id, user);
          return user;
        },
        updateUser: (id, updates) => {
          const user = users.get(id);
          if (!user) throw new Error("User not found");
          const updated = { ...user, ...updates };
          users.set(id, updated);
          return updated;
        },
      });

      const shutdown = createHttpService(context);
      register(shutdown);
      await new Promise((resolve) => setTimeout(resolve, 200));

      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
      });

      try {
        const [service, cleanup] = await createWebSocketRpcClient<{
          userService: {
            createUser: (data: Omit<User, "id">) => User;
            updateUser: (id: string, updates: Partial<User>) => User;
          };
        }>(ws);
        register(cleanup);

        await new Promise((resolve) => setTimeout(resolve, 200));

        const newUser = await service.userService.createUser({
          name: "John Doe",
          email: "john@example.com",
          metadata: { role: "admin", active: true },
        });

        expect(newUser.name).toBe("John Doe");
        expect(newUser.email).toBe("john@example.com");
        expect(newUser.metadata).toEqual({ role: "admin", active: true });

        const updatedUser = await service.userService.updateUser(newUser.id, {
          email: "john.doe@example.com",
        });

        expect(updatedUser.email).toBe("john.doe@example.com");
        expect(updatedUser.name).toBe("John Doe");
      } finally {
        ws.close();
      }
    }, 10000);
  });
});
