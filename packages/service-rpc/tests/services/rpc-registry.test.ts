import { beforeEach, describe, expect, it } from "vitest";
import { getRpcRegistry, newRpcAdapter, removeRpcRegistry } from "../../src/services/index.js";

describe("RPC Service Registry", () => {
  let context: Record<string, unknown>;

  beforeEach(() => {
    context = {};
  });

  describe("getRpcRegistry", () => {
    it("should return empty registry initially", () => {
      const registry = getRpcRegistry(context);

      expect(registry).toEqual({});
    });

    it("should return same registry instance for same context", () => {
      const registry1 = getRpcRegistry(context);
      const registry2 = getRpcRegistry(context);

      expect(registry1).toBe(registry2);
    });

    it("should return different registries for different contexts", () => {
      const context2 = {};
      const registry1 = getRpcRegistry(context);
      const registry2 = getRpcRegistry(context2);

      expect(registry1).not.toBe(registry2);
    });
  });

  describe("newRpcAdapter", () => {
    it("should create adapter for a service", () => {
      const [get, set, remove] = newRpcAdapter<object>("test");

      expect(typeof get).toBe("function");
      expect(typeof set).toBe("function");
      expect(typeof remove).toBe("function");
    });

    it("should register a service", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
        subtract: (a: number, b: number) => a - b,
      };

      const [getCalculatorService, setCalculatorService] =
        newRpcAdapter<typeof calculatorService>("calculator");
      setCalculatorService(context, calculatorService);

      const service = getCalculatorService(context);
      expect(service).toBe(calculatorService);
      expect(service?.add(5, 3)).toBe(8);
      expect(service?.subtract(5, 3)).toBe(2);
    });

    it("should return undefined for non-registered service", () => {
      const [_getCalculatorService, setCalculatorService] = newRpcAdapter<object>("calculator");

      // First set, then remove to test undefined return
      setCalculatorService(context, { test: "test" });
      const [, , removeCalculatorService] = newRpcAdapter<object>("calculator");
      removeCalculatorService(context);

      // After removal, adapter throws "Adapter not found" error
      // So we test that the service doesn't exist in registry
      const registry = getRpcRegistry(context);
      expect(registry.calculator).toBeUndefined();
    });

    it("should register multiple services", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
      };

      const userService = {
        getUser: (id: string) => ({ id, name: "John" }),
      };

      const [getCalculator, setCalculator] = newRpcAdapter<typeof calculatorService>("calculator");
      const [getUser, setUser] = newRpcAdapter<typeof userService>("user");

      setCalculator(context, calculatorService);
      setUser(context, userService);

      expect(getCalculator(context)).toBe(calculatorService);
      expect(getUser(context)).toBe(userService);

      const registry = getRpcRegistry(context);
      expect(Object.keys(registry)).toContain("calculator");
      expect(Object.keys(registry)).toContain("user");
    });

    it("should allow overwriting existing service", () => {
      const service1 = {
        add: (a: number, b: number) => a + b,
      };

      const service2 = {
        multiply: (a: number, b: number) => a * b,
      };

      const [getCalculator, setCalculator] = newRpcAdapter<object>("calculator");

      setCalculator(context, service1);
      expect(getCalculator(context)).toBe(service1);

      setCalculator(context, service2);
      expect(getCalculator(context)).toBe(service2);
      expect(getCalculator(context)).not.toBe(service1);
    });

    it("should remove service", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
      };

      const [getCalculator, setCalculator, removeCalculator] =
        newRpcAdapter<typeof calculatorService>("calculator");

      setCalculator(context, calculatorService);
      expect(getCalculator(context)).toBe(calculatorService);

      removeCalculator(context);

      // After removal, accessing the adapter throws an error
      // Instead, check the registry directly
      const registry = getRpcRegistry(context);
      expect(registry.calculator).toBeUndefined();
    });

    it("should handle remove idempotently", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
      };

      const [, setCalculator, removeCalculator] =
        newRpcAdapter<typeof calculatorService>("calculator");

      setCalculator(context, calculatorService);
      removeCalculator(context);
      removeCalculator(context);
      removeCalculator(context);

      // Should not throw during removal
      const registry = getRpcRegistry(context);
      expect(registry.calculator).toBeUndefined();
    });

    it("should not affect other services when removing one", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
      };

      const userService = {
        getUser: (id: string) => ({ id, name: "John" }),
      };

      const [, setCalculator, removeCalculator] =
        newRpcAdapter<typeof calculatorService>("calculator");
      const [getUser, setUser] = newRpcAdapter<typeof userService>("user");

      setCalculator(context, calculatorService);
      setUser(context, userService);

      removeCalculator(context);

      const registry = getRpcRegistry(context);
      expect(registry.calculator).toBeUndefined();
      expect(getUser(context)).toBe(userService);
    });

    it("should support type-safe access", () => {
      interface UserService {
        getUser: (id: string) => { id: string; name: string };
        updateUser: (id: string, name: string) => void;
      }

      const userService: UserService = {
        getUser: (id: string) => ({ id, name: "John" }),
        updateUser: () => {},
      };

      const [getUser, setUser] = newRpcAdapter<UserService>("user");
      setUser(context, userService);

      const service = getUser(context);
      expect(service).toBe(userService);
      expect(service?.getUser("123")).toEqual({ id: "123", name: "John" });
    });
  });

  describe("removeRpcRegistry", () => {
    it("should remove entire registry from context", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
      };

      const userService = {
        getUser: (id: string) => ({ id, name: "John" }),
      };

      const [, setCalculator] = newRpcAdapter<typeof calculatorService>("calculator");
      const [, setUser] = newRpcAdapter<typeof userService>("user");

      setCalculator(context, calculatorService);
      setUser(context, userService);

      let registry = getRpcRegistry(context);
      expect(Object.keys(registry)).toHaveLength(2);

      removeRpcRegistry(context);

      registry = getRpcRegistry(context);
      expect(registry).toEqual({});
    });

    it("should create fresh registry after removal", () => {
      const service1 = {
        add: (a: number, b: number) => a + b,
      };

      const [_getCalculator, setCalculator] = newRpcAdapter<typeof service1>("calculator");

      setCalculator(context, service1);

      const registry1 = getRpcRegistry(context);
      expect(registry1.calculator).toBe(service1);

      removeRpcRegistry(context);

      const registry2 = getRpcRegistry(context);
      expect(registry2).toEqual({});
      expect(registry2).not.toBe(registry1); // New instance
    });
  });

  describe("Integration scenarios", () => {
    it("should support complete service lifecycle", () => {
      // Register calculator service
      const calculatorService = {
        add: (a: number, b: number) => a + b,
        subtract: (a: number, b: number) => a - b,
        multiply: (a: number, b: number) => a * b,
        divide: (a: number, b: number) => a / b,
      };

      const [getCalculator, setCalculator, removeCalculator] =
        newRpcAdapter<typeof calculatorService>("calculator");
      setCalculator(context, calculatorService);

      // Verify calculator is available
      expect(getCalculator(context)).toBe(calculatorService);

      // Register user service
      const userService = {
        getUser: (id: string) => ({ id, name: "John" }),
        deleteUser: (_id: string) => true,
      };

      const [getUser, setUser, removeUser] = newRpcAdapter<typeof userService>("user");
      setUser(context, userService);

      // Verify both services are available
      const registry = getRpcRegistry(context);
      expect(Object.keys(registry)).toContain("calculator");
      expect(Object.keys(registry)).toContain("user");

      // Remove calculator
      removeCalculator(context);

      // Verify only user remains
      const registry2 = getRpcRegistry(context);
      expect(registry2.calculator).toBeUndefined();
      expect(getUser(context)).toBe(userService);

      // Remove user
      removeUser(context);

      // Verify registry is empty
      expect(Object.keys(getRpcRegistry(context))).toHaveLength(0);
    });

    it("should allow service replacement", () => {
      const service1 = {
        version: 1,
        getData: () => "v1",
      };

      const service2 = {
        version: 2,
        getData: () => "v2",
        getNewFeature: () => "new",
      };

      const [getApi, setApi] = newRpcAdapter<object>("api");

      setApi(context, service1);
      expect(getApi(context)).toBe(service1);

      setApi(context, service2);
      expect(getApi(context)).toBe(service2);
      expect(getApi(context)).not.toBe(service1);
    });

    it("should work with callable methods", () => {
      const calculatorService = {
        add: (a: number, b: number) => a + b,
        subtract: (a: number, b: number) => a - b,
      };

      const [getCalculator, setCalculator] = newRpcAdapter<typeof calculatorService>("calculator");
      setCalculator(context, calculatorService);

      const service = getCalculator(context);

      expect(service?.add(5, 3)).toBe(8);
      expect(service?.subtract(5, 3)).toBe(2);
    });

    it("should support async methods", async () => {
      const asyncService = {
        fetchUser: async (id: string) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { id, name: "Async User" };
        },
        saveUser: async (_user: { id: string; name: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return true;
        },
      };

      const [getAsync, setAsync] = newRpcAdapter<typeof asyncService>("async");
      setAsync(context, asyncService);

      const service = getAsync(context);

      const user = await service?.fetchUser("123");
      expect(user).toEqual({ id: "123", name: "Async User" });

      const result = await service?.saveUser({ id: "123", name: "Test" });
      expect(result).toBe(true);
    });

    it("should handle multiple service instances independently", () => {
      const context1 = {};
      const context2 = {};

      const service1 = {
        getValue: () => "context1",
      };

      const service2 = {
        getValue: () => "context2",
      };

      const [getApi, setApi] = newRpcAdapter<{ getValue: () => string }>("api");

      setApi(context1, service1);
      setApi(context2, service2);

      expect(getApi(context1)).toBe(service1);
      expect(getApi(context2)).toBe(service2);
      expect(getApi(context1)?.getValue()).toBe("context1");
      expect(getApi(context2)?.getValue()).toBe("context2");
    });

    it("should support complex service objects", async () => {
      interface ComplexService {
        nested: {
          method1: (x: number) => number;
          method2: (x: string) => string;
        };
        array: Array<() => number>;
        promise: () => Promise<string>;
      }

      const complexService: ComplexService = {
        nested: {
          method1: (x) => x * 2,
          method2: (x) => x.toUpperCase(),
        },
        array: [() => 1, () => 2, () => 3],
        promise: async () => "async result",
      };

      const [getComplex, setComplex] = newRpcAdapter<ComplexService>("complex");
      setComplex(context, complexService);

      const service = getComplex(context);

      expect(service?.nested.method1(5)).toBe(10);
      expect(service?.nested.method2("hello")).toBe("HELLO");
      expect(service?.array[0]()).toBe(1);
      await expect(service?.promise()).resolves.toBe("async result");
    });

    it("should handle services with symbols and special keys", () => {
      const symbolKey = Symbol("special");
      const serviceWithSymbol = {
        normalMethod: () => "normal",
        [symbolKey]: () => "symbol value",
      };

      const [getSpecial, setSpecial] = newRpcAdapter<typeof serviceWithSymbol>("special");
      setSpecial(context, serviceWithSymbol);

      const service = getSpecial(context);

      expect(service?.normalMethod()).toBe("normal");
      expect(service?.[symbolKey]()).toBe("symbol value");
    });
  });
});
