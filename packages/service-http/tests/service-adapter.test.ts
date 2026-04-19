import { describe, expect, it, vi } from "vitest";
import { newContextServiceAdapter, newServiceAdapter } from "../src/service-adapter.js";

describe("newContextServiceAdapter", () => {
  describe("basic functionality", () => {
    it("should create service consumer, provider, and cleanup functions", () => {
      const [newServiceConsumer, newServiceProvider, removeContextService] =
        newContextServiceAdapter<string>("test-service");

      expect(typeof newServiceConsumer).toBe("function");
      expect(typeof newServiceProvider).toBe("function");
      expect(typeof removeContextService).toBe("function");
    });

    it("should attach service to context object", () => {
      const [newServiceConsumer, _newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);

      expect(callback).toHaveBeenCalledWith([]);
    });

    it("should share service state within same context", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      callback.mockClear();

      const [provideService] = newServiceProvider(context);
      provideService("test-value");

      expect(callback).toHaveBeenCalledWith(["test-value"]);
    });

    it("should isolate service state across different contexts", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context1 = {};
      const context2 = {};

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      newServiceConsumer(context1, callback1);
      newServiceConsumer(context2, callback2);

      callback1.mockClear();
      callback2.mockClear();

      const [provide1] = newServiceProvider(context1);
      const [provide2] = newServiceProvider(context2);

      provide1("context1-value");
      provide2("context2-value");

      expect(callback1).toHaveBeenLastCalledWith(["context1-value"]);
      expect(callback2).toHaveBeenLastCalledWith(["context2-value"]);
    });
  });

  describe("consumer management", () => {
    it("should support multiple consumers on same context", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      newServiceConsumer(context, callback1);
      newServiceConsumer(context, callback2);

      callback1.mockClear();
      callback2.mockClear();

      const [provideService] = newServiceProvider(context);
      provideService("test");

      expect(callback1).toHaveBeenCalledWith(["test"]);
      expect(callback2).toHaveBeenCalledWith(["test"]);
    });

    it("should allow selective consumer cleanup", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const cleanup1 = newServiceConsumer(context, callback1);
      newServiceConsumer(context, callback2);

      const [provideService] = newServiceProvider(context);

      callback1.mockClear();
      callback2.mockClear();
      cleanup1();

      provideService("after-cleanup");

      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith(["after-cleanup"]);
    });
  });

  describe("provider management", () => {
    it("should support multiple providers on same context", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      callback.mockClear();

      const [_provide1] = newServiceProvider(context, "value1");
      const [_provide2] = newServiceProvider(context, "value2");

      expect(callback).toHaveBeenLastCalledWith(["value1", "value2"]);
    });

    it("should allow provider to update values", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      const [provideService] = newServiceProvider(context);

      callback.mockClear();
      provideService("value1");

      expect(callback).toHaveBeenCalledWith(["value1"]);

      provideService("value2");

      expect(callback).toHaveBeenLastCalledWith(["value2"]);
    });

    it("should allow provider cleanup", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      const [_provideService, removeService] = newServiceProvider(context, "initial");

      callback.mockClear();
      removeService();

      expect(callback).toHaveBeenCalledWith([]);
    });
  });

  describe("context cleanup", () => {
    it("should remove all services from context", () => {
      const [newServiceConsumer, newServiceProvider, removeContextService] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      newServiceProvider(context, "value1");
      newServiceProvider(context, "value2");

      callback.mockClear();
      removeContextService(context);

      // After removal, new consumers should see empty state
      const newCallback = vi.fn();
      newServiceConsumer(context, newCallback);

      expect(newCallback).toHaveBeenCalledWith([]);
    });
  });

  describe("initial values", () => {
    it("should notify consumer immediately with initial value", () => {
      const [newServiceConsumer, newServiceProvider] =
        newContextServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      callback.mockClear();

      newServiceProvider(context, "initial-value");

      expect(callback).toHaveBeenCalledWith(["initial-value"]);
    });

    it("should handle undefined as initial value", () => {
      const [newServiceConsumer, newServiceProvider] = newContextServiceAdapter<string | undefined>(
        "test-service",
      );

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      callback.mockClear();

      newServiceProvider(context);

      // Should not notify until value is provided
      expect(callback).not.toHaveBeenCalled();
    });
  });
});

describe("newServiceAdapter", () => {
  describe("basic functionality with default root context finder", () => {
    it("should work with simple flat contexts", () => {
      const [newServiceConsumer, newServiceProvider] = newServiceAdapter<string>("test-service");

      const context = {};
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      callback.mockClear();

      const [provideService] = newServiceProvider(context);
      provideService("test");

      expect(callback).toHaveBeenCalledWith(["test"]);
    });

    it("should find root context in parent chain", () => {
      const [newServiceConsumer, newServiceProvider] = newServiceAdapter<string>("test-service");

      const rootContext = {};
      const childContext = { parent: rootContext };
      const grandchildContext = { parent: childContext };

      const callback = vi.fn();

      // Register consumer at grandchild level
      newServiceConsumer(grandchildContext, callback);
      callback.mockClear();

      // Provide service at child level
      const [provideService] = newServiceProvider(childContext);
      provideService("test");

      // Should notify because they share the same root
      expect(callback).toHaveBeenCalledWith(["test"]);
    });

    it("should share services across hierarchy levels", () => {
      const [newServiceConsumer, newServiceProvider] = newServiceAdapter<string>("test-service");

      const rootContext = {};
      const child1 = { parent: rootContext };
      const child2 = { parent: rootContext };

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      newServiceConsumer(child1, callback1);
      newServiceConsumer(child2, callback2);

      callback1.mockClear();
      callback2.mockClear();

      const [provideService] = newServiceProvider(child1);
      provideService("shared-value");

      // Both should be notified
      expect(callback1).toHaveBeenCalledWith(["shared-value"]);
      expect(callback2).toHaveBeenCalledWith(["shared-value"]);
    });
  });

  describe("custom root context finder", () => {
    it("should use custom getRootContext function", () => {
      interface CustomContext {
        id: string;
        root?: CustomContext;
      }

      const getRootContext = (context: CustomContext): CustomContext => {
        let current = context;
        while (current.root) {
          current = current.root;
        }
        return current;
      };

      const [newServiceConsumer, newServiceProvider] = newServiceAdapter<string, CustomContext>(
        "test-service",
        getRootContext,
      );

      const rootContext: CustomContext = { id: "root" };
      const childContext: CustomContext = { id: "child", root: rootContext };

      const callback = vi.fn();

      newServiceConsumer(childContext, callback);
      callback.mockClear();

      const [provideService] = newServiceProvider(childContext);
      provideService("custom-root-test");

      expect(callback).toHaveBeenCalledWith(["custom-root-test"]);
    });

    it("should allow forcing flat context behavior", () => {
      const [newServiceConsumer, newServiceProvider] = newServiceAdapter<string>(
        "test-service",
        (context) => context, // Don't traverse parents
      );

      const rootContext = {};
      const childContext = { parent: rootContext };

      const callbackRoot = vi.fn();
      const callbackChild = vi.fn();

      newServiceConsumer(rootContext, callbackRoot);
      newServiceConsumer(childContext, callbackChild);

      callbackRoot.mockClear();
      callbackChild.mockClear();

      const [provideService] = newServiceProvider(childContext);
      provideService("isolated");

      // Only child should be notified
      expect(callbackRoot).not.toHaveBeenCalled();
      expect(callbackChild).toHaveBeenCalledWith(["isolated"]);
    });
  });

  describe("context cleanup with hierarchy", () => {
    it("should clean up services at root level", () => {
      const [newServiceConsumer, newServiceProvider, removeContextService] =
        newServiceAdapter<string>("test-service");

      const rootContext = {};
      const childContext = { parent: rootContext };

      const callback = vi.fn();

      newServiceConsumer(childContext, callback);
      newServiceProvider(childContext, "test");

      callback.mockClear();
      removeContextService(childContext);

      // New consumer should see empty state
      const newCallback = vi.fn();
      newServiceConsumer(childContext, newCallback);

      expect(newCallback).toHaveBeenCalledWith([]);
    });
  });

  describe("edge cases with parent traversal", () => {
    it("should handle context without parent property", () => {
      const [newServiceConsumer, newServiceProvider] = newServiceAdapter<string>("test-service");

      const context = { someOtherProp: "value" };
      const callback = vi.fn();

      newServiceConsumer(context, callback);
      callback.mockClear();

      const [provideService] = newServiceProvider(context);
      provideService("test");

      expect(callback).toHaveBeenCalledWith(["test"]);
    });
  });

  describe("multiple service adapters", () => {
    it("should keep different service adapters isolated", () => {
      const [consume1, provide1] = newServiceAdapter<string>("service-1");
      const [consume2, provide2] = newServiceAdapter<number>("service-2");

      const context = {};
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      consume1(context, callback1);
      consume2(context, callback2);

      callback1.mockClear();
      callback2.mockClear();

      const [provideStr] = provide1(context);
      const [provideNum] = provide2(context);

      provideStr("string-value");
      provideNum(42);

      expect(callback1).toHaveBeenCalledWith(["string-value"]);
      expect(callback2).toHaveBeenCalledWith([42]);
    });
  });
});
