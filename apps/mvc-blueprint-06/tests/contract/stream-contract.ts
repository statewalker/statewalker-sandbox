/**
 * The stream contract — MODELS.md §4 points 1–9 mapped onto a state stream. Any implementation
 * that passes can publish state an actor owns.
 */
import { describe, expect, it } from "vitest";

export interface StreamUnderTest<S> {
  get(): S | undefined;
  subscribe(listener: () => void): () => void;
  publish(value: S): void;
  /** The owner stops. */
  release(): void;
  /** Where out-of-band subscriber errors land. */
  errors: unknown[];
}

type V = { a: number; b?: string };

export function streamContract(name: string, make: () => StreamUnderTest<V>): void {
  describe(`stream contract · ${name}`, () => {
    it("1. subscribe calls back immediately, before returning", () => {
      const s = make();
      s.publish({ a: 1 });
      let seen: V | undefined;
      s.subscribe(() => {
        seen = s.get();
      });
      expect(seen).toEqual({ a: 1 });
    });

    it("1'. a late subscriber gets the current value, not the history", () => {
      const s = make();
      s.publish({ a: 1 });
      s.publish({ a: 2 });
      const seen: (V | undefined)[] = [];
      s.subscribe(() => seen.push(s.get()));
      expect(seen).toEqual([{ a: 2 }]);
    });

    it("2. one notification per publish", () => {
      const s = make();
      let n = 0;
      s.subscribe(() => n++);
      n = 0;
      s.publish({ a: 1, b: "x" });
      expect(n).toBe(1);
    });

    it("3. a shallow-equal publish notifies nobody and keeps the reference", () => {
      const s = make();
      s.publish({ a: 1 });
      const ref = s.get();
      let n = 0;
      s.subscribe(() => n++);
      n = 0;
      s.publish({ a: 1 });
      expect(n).toBe(0);
      expect(s.get()).toBe(ref);
    });

    it("4. notifications are in order and synchronous, before publish returns", () => {
      const s = make();
      const seen: number[] = [];
      s.subscribe(() => {
        const v = s.get();
        if (v) seen.push(v.a);
      });
      s.publish({ a: 1 });
      expect(seen).toEqual([1]);
      s.publish({ a: 2 });
      s.publish({ a: 3 });
      expect(seen).toEqual([1, 2, 3]);
    });

    it("5. unsubscribing inside a callback is final; one removed earlier in a pass is not woken", () => {
      const s = make();
      const calls: string[] = [];
      let offB: () => void = () => {};
      let armed = false;
      const offA = s.subscribe(() => {
        calls.push("a");
        if (armed) {
          offA();
          offB();
        }
      });
      offB = s.subscribe(() => calls.push("b"));
      calls.length = 0;
      armed = true;
      s.publish({ a: 1 });
      s.publish({ a: 2 });
      expect(calls).toEqual(["a"]);
      offA(); // idempotent
    });

    it("6. a throwing subscriber never reaches the publisher and never stops the others", () => {
      const s = make();
      let other = 0;
      let armed = false;
      s.subscribe(() => {
        if (armed) throw new Error("bad subscriber");
      });
      s.subscribe(() => other++);
      armed = true;
      other = 0;
      expect(() => s.publish({ a: 1 })).not.toThrow();
      expect(other).toBe(1);
      expect(s.errors).toHaveLength(1);
    });

    it("7. a value keeps its identity until it changes", () => {
      const s = make();
      s.publish({ a: 1 });
      const first = s.get();
      expect(s.get()).toBe(first);
      s.publish({ a: 1 });
      expect(s.get()).toBe(first);
      expect(structuredClone(s.get())).toEqual(first); // plain data: survives a clone by value
      s.publish({ a: 2 });
      expect(s.get()).not.toBe(first);
    });

    it("8. after the owner releases: absent (undefined), one notification, then silence", () => {
      const s = make();
      s.publish({ a: 1 });
      let n = 0;
      const off = s.subscribe(() => n++);
      n = 0;
      s.release();
      expect(s.get()).toBeUndefined();
      expect(n).toBe(1);
      s.release();
      expect(n).toBe(1);
      off();
      off();
    });

    it("9. a publish replaces the whole value — no patch semantics", () => {
      const s = make();
      s.publish({ a: 1, b: "keep?" });
      s.publish({ a: 2 });
      expect(s.get()).toEqual({ a: 2 });
    });
  });
}
