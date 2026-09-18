import { describe, expect, it } from "vitest";

/** A model group under test: the view reads/subscribes; `write` is the owner's intention. */
export interface Subject<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
  write(value: T): void;
  dispose(): void;
}

/**
 * MODELS.md §4, points 1–9, for any substrate. `sample(i)` returns distinct values; `twin(v)` a
 * shallow-equal copy of `v`. `patch` is optional (point 9 applies to coarse object groups).
 */
export function modelContract<T>(
  name: string,
  make: () => Subject<T>,
  sample: (i: number) => T,
  twin: (value: T) => T,
  options: { patch?: (s: Subject<T>, p: Record<string, unknown>) => void } = {},
) {
  describe(`model contract · ${name}`, () => {
    it("1. subscribe calls back immediately, before returning", () => {
      const s = make();
      let calls = 0;
      s.subscribe(() => calls++);
      expect(calls).toBe(1);
    });
    it("2. one notification per intention", () => {
      const s = make();
      let calls = 0;
      s.subscribe(() => calls++);
      s.write(sample(1));
      expect(calls).toBe(2);
    });
    it("3. a shallow-equal write notifies nobody", () => {
      const s = make();
      s.write(sample(1));
      let calls = 0;
      s.subscribe(() => calls++);
      s.write(twin(s.get()));
      expect(calls).toBe(1);
    });
    it("4. notifications are in order and synchronous", () => {
      const s = make();
      const seen: T[] = [];
      s.subscribe(() => seen.push(s.get()));
      s.write(sample(1));
      s.write(sample(2));
      expect(seen).toEqual([sample(0), sample(1), sample(2)]);
    });
    it("5. unsubscribing inside a callback is safe; one removed by an earlier one is not woken", () => {
      const s = make();
      const calls: string[] = [];
      let offB: () => void = () => {};
      let armed = false;
      const offA = s.subscribe(() => {
        calls.push("a");
        if (armed) {
          offB();
          offA();
        }
      });
      offB = s.subscribe(() => calls.push("b"));
      calls.length = 0;
      armed = true;
      s.write(sample(1));
      expect(calls).toEqual(["a"]);
      s.write(sample(2));
      expect(calls).toEqual(["a"]);
    });
    it("6. a throwing subscriber never reaches the writer and never stops the others", () => {
      const s = make();
      let other = 0;
      s.subscribe(() => {
        throw new Error("boom");
      });
      s.subscribe(() => other++);
      expect(() => s.write(sample(1))).not.toThrow();
      expect(other).toBe(2);
    });
    it("7. a snapshot keeps its identity until its value changes", () => {
      const s = make();
      s.write(sample(1));
      const first = s.get();
      s.write(twin(first));
      expect(s.get()).toBe(first);
      expect(s.get()).toBe(s.get());
    });
    it("8. after dispose: last value readable, nothing notified, writes no-op, unsubscribe idempotent", () => {
      const s = make();
      s.write(sample(1));
      let calls = 0;
      const off = s.subscribe(() => calls++);
      s.dispose();
      s.write(sample(2));
      expect(s.get()).toEqual(sample(1));
      expect(calls).toBe(1);
      off();
      off();
    });
    if (options.patch) {
      const patch = options.patch;
      it("9. a coarse write is a patch; an explicit undefined clears the field", () => {
        const s = make();
        s.write(sample(1));
        patch(s, { extra: "x" });
        expect(s.get()).toMatchObject({ extra: "x" });
        patch(s, { extra: undefined });
        expect((s.get() as Record<string, unknown>).extra).toBeUndefined();
        expect(Object.keys(s.get() as object)).toContain("extra");
      });
    }
  });
}
