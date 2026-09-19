import { getSlots } from "@p5/kernel";
import { describe, expect, it, vi } from "vitest";

describe("the kernel is a singleton (W8)", () => {
  it("a second copy of @p5/kernel on one context is refused at its first resolution", async () => {
    const context = {};
    const slots = getSlots(context);
    expect(getSlots(context)).toBe(slots); // the same copy: fine
    vi.resetModules();
    const copy = await import("@p5/kernel"); // a fresh module instance: a second copy
    expect(copy.getSlots).not.toBe(getSlots);
    expect(() => copy.getSlots(context)).toThrow(/two copies of @p5\/kernel/);
    expect(copy.getSlots({})).toBeInstanceOf(copy.KernelSlots); // alone, a copy works
  });
});
