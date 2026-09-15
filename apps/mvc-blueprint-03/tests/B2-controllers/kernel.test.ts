import { Commands } from "@statewalker/shared-commands";
import { Slots } from "@statewalker/shared-slots";
import { attempt, describeError } from "@sys/attempt";
import { type AppContext, getCommands, getSlots, setCommands, setSlots } from "@sys/context";
import { newChannels, shallowEqual, stableGroup } from "@sys/model-kit";
import { signal } from "@sys/signals";
import { newUpdateLoop } from "@sys/update-loop";
import { describe, expect, it, vi } from "vitest";
import { newRecordingLogger } from "../support/logging.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("B2 · kernel", () => {
  describe("context adapters", () => {
    it("throw when a service was never set, and return what was set", () => {
      const ctx: AppContext = {};
      expect(() => getCommands(ctx)).toThrow(/Adapter not found: sys:commands/);
      expect(() => getSlots(ctx)).toThrow(/Adapter not found: sys:slots/);
      const commands = new Commands();
      const slots = new Slots();
      setCommands(ctx, commands);
      setSlots(ctx, slots);
      expect(getCommands(ctx)).toBe(commands);
      expect(getSlots(ctx)).toBe(slots);
    });
  });

  describe("model kit", () => {
    it("shallowEqual compares one level deep, by identity", () => {
      const item = { id: 1 };
      expect(shallowEqual([item], [item])).toBe(true);
      expect(shallowEqual([item], [{ id: 1 }])).toBe(false);
      expect(shallowEqual({ a: 1, b: item }, { b: item, a: 1 })).toBe(true);
      expect(shallowEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
      expect(shallowEqual([1], { 0: 1 })).toBe(false);
    });

    it("stableGroup keeps its reference while the derived value is shallow-equal", () => {
      const a = signal(1);
      const b = signal(2);
      const group = stableGroup(() => ({ a: a(), b: b() }));
      const first = group();
      b(2);
      a(1);
      expect(group()).toBe(first);
      a(3);
      expect(group()).not.toBe(first);
      expect(group()).toEqual({ a: 3, b: 2 });
    });

    it("a channel calls back immediately, then once per change", () => {
      const value = signal(0);
      const channels = newChannels();
      const listener = vi.fn();
      const off = channels.channel(value)(listener);
      expect(listener).toHaveBeenCalledTimes(1);
      value(1);
      value(1);
      expect(listener).toHaveBeenCalledTimes(2);
      off();
      value(2);
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("isDisposed silences every channel synchronously, before dispose() stops them", () => {
      let disposed = false;
      const value = signal(0);
      const channels = newChannels(() => disposed);
      const listener = vi.fn();
      channels.channel(value)(listener);
      disposed = true;
      value(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(channels.channel(value)(listener)).toBeTypeOf("function");
      expect(listener).toHaveBeenCalledTimes(1);
      channels.dispose();
    });

    it("a throwing listener is reported and does not reach the writer or the other listeners", () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const value = signal(0);
      const channels = newChannels();
      const other = vi.fn();
      channels.channel(value)(() => {
        if (value() > 0) throw new Error("boom");
      });
      channels.channel(value)(other);
      expect(() => value(1)).not.toThrow();
      expect(other).toHaveBeenCalledTimes(2);
      expect(errors).toHaveBeenCalledTimes(1);
      errors.mockRestore();
    });
  });

  describe("update loop", () => {
    it("coalesces kicks in one tick into one pass, in a microtask", async () => {
      const pass = vi.fn(async () => {});
      const loop = newUpdateLoop(pass, { isDisposed: () => false, onError: () => {} });
      loop.kick();
      loop.kick();
      expect(pass).not.toHaveBeenCalled();
      await loop.idle();
      expect(pass).toHaveBeenCalledTimes(1);
    });

    it("a kick during a pass earns exactly one more pass", async () => {
      let release: () => void = () => {};
      let calls = 0;
      const loop = newUpdateLoop(
        async () => {
          calls++;
          if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
        },
        { isDisposed: () => false, onError: () => {} },
      );
      loop.kick();
      await tick();
      loop.kick();
      loop.kick();
      release();
      await loop.idle();
      expect(calls).toBe(2);
    });

    it("ignores kicks once disposed and reports a failing pass without stopping", async () => {
      let disposed = false;
      const onError = vi.fn();
      let calls = 0;
      const loop = newUpdateLoop(
        async () => {
          calls++;
          throw new Error("pass failed");
        },
        { isDisposed: () => disposed, onError },
      );
      loop.kick();
      await loop.idle();
      expect(onError).toHaveBeenCalledTimes(1);
      loop.kick();
      await loop.idle();
      expect(calls).toBe(2);
      disposed = true;
      loop.kick();
      await loop.idle();
      expect(calls).toBe(2);
    });
  });

  describe("attempt", () => {
    it("returns the value, or a message naming the work, and logs the failure", async () => {
      const { logger, calls } = newRecordingLogger();
      expect(await attempt(logger, "load", async () => 7)).toEqual({ ok: true, value: 7 });
      const failed = await attempt(logger, "load", async () => {
        throw new Error("disk full");
      });
      expect(failed).toMatchObject({ ok: false, message: "load failed: disk full" });
      expect(calls).toEqual([{ level: "error", args: ["load failed: disk full"], metadata: {} }]);
    });

    it("describeError unwraps a listener's error from the bus wrapper", () => {
      const wrapped = Object.assign(
        new Error("listener-threw: todos:edit:open", { cause: new Error("todo not found: t9") }),
        {
          kind: "listener-threw",
        },
      );
      expect(describeError(wrapped)).toBe("todo not found: t9");
      expect(
        describeError(Object.assign(new Error("no-handlers: x"), { kind: "no-handlers" })),
      ).toBe("no-handlers: x");
      expect(describeError("plain")).toBe("plain");
    });
  });
});
