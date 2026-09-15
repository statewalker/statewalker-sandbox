import { batch, computed, effect, signal, untracked } from "@sys/signals";
import { describe, expect, it } from "vitest";

describe("B1 · the signals contract resolves through @sys/signals", () => {
  it("signal, computed, effect, batch and untracked behave as the contract says", () => {
    const a = signal(1);
    const b = signal(2);
    const sum = computed(() => a() + b());
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(sum());
    });
    batch(() => {
      a(10);
      b(20);
    });
    a(10); // equal write: silent
    expect(seen).toEqual([3, 30]);
    expect(untracked(() => sum())).toBe(30);
    stop();
  });
});
