import { describe, expect, it, vi } from "vitest";

/**
 * B1 · MODELS.md §4, as executable checks. A subject hands the suite ONE group
 * of a model: how to read it, subscribe to it, change it, write an equal value,
 * write a different group, and dispose the model. Point 9 (patch semantics) is
 * model-specific and lives with each model's own tests.
 */
export interface ContractHandle<T> {
  read(): T;
  subscribe(listener: () => void): () => void;
  /** One intention that changes the group to a value not shallow-equal to the last. */
  change(): void;
  /** A write shallow-equal to what the group holds. */
  changeEqual(): void;
  /** A write to a different group of the same model, if it has one. */
  changeOther?(): void;
  dispose(): void;
}

export interface ContractSubject<T> {
  make(): ContractHandle<T>;
}

interface Check {
  readonly id: string;
  readonly title: string;
  run<T>(subject: ContractSubject<T>): void;
}

/** Counts calls after subscribing — the immediate call is excluded. */
function counted<T>(m: ContractHandle<T>): { readonly n: number; off: () => void } {
  let n = -1;
  const off = m.subscribe(() => {
    n++;
  });
  return {
    get n() {
      return n;
    },
    off,
  };
}

export const CONTRACT_CHECKS: readonly Check[] = [
  {
    id: "1",
    title: "calls back immediately on subscribe, before returning",
    run(subject) {
      const m = subject.make();
      let calls = 0;
      const off = m.subscribe(() => {
        calls++;
      });
      expect(calls, "the immediate call").toBe(1);
      off();
    },
  },
  {
    id: "2",
    title: "one notification per intention",
    run(subject) {
      const m = subject.make();
      const c = counted(m);
      m.change();
      expect(c.n).toBe(1);
      m.change();
      expect(c.n).toBe(2);
    },
  },
  {
    id: "3",
    title: "a write equal to the held group notifies nobody",
    run(subject) {
      const m = subject.make();
      const c = counted(m);
      m.changeEqual();
      m.changeEqual();
      expect(c.n).toBe(0);
    },
  },
  {
    id: "4",
    title: "delivers synchronously and in order; each listener sees its own change",
    run(subject) {
      const m = subject.make();
      const seen: unknown[] = [];
      m.subscribe(() => seen.push(m.read()));
      seen.length = 0;
      m.change();
      expect(seen, "delivered before change() returned").toHaveLength(1);
      expect(seen[0]).toBe(m.read());
      m.change();
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBe(m.read());
      expect(seen[0]).not.toBe(seen[1]);
    },
  },
  {
    id: "5",
    title:
      "unsubscribing inside a callback is safe and final; a listener removed earlier in the pass is not woken",
    run(subject) {
      const m = subject.make();
      // Order-independent: listener order within a pass is not part of the
      // contract, so each listener removes the OTHER — whichever runs first must
      // leave the other unwoken.
      let offA: () => void = () => {};
      let offB: () => void = () => {};
      let a = 0;
      let b = 0;
      let armed = false;
      offA = m.subscribe(() => {
        if (!armed) return;
        a++;
        offB();
      });
      offB = m.subscribe(() => {
        if (!armed) return;
        b++;
        offA();
      });
      armed = true;
      expect(() => m.change()).not.toThrow();
      expect(a + b, "whichever ran first removed the other before its turn").toBe(1);
      let self = 0;
      let offSelf: () => void = () => {};
      offSelf = m.subscribe(() => {
        self++;
        offSelf();
      });
      self = 0;
      m.change();
      m.change();
      expect(self, "a listener that removed itself hears nothing more").toBe(1);
    },
  },
  {
    id: "6",
    title: "a throwing listener never reaches the writer, never stops the others, and is reported",
    run(subject) {
      const m = subject.make();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let armed = false;
        let others = 0;
        m.subscribe(() => {
          if (armed) throw new Error("listener failed");
        });
        m.subscribe(() => {
          others++;
        });
        others = 0;
        armed = true;
        expect(() => m.change()).not.toThrow();
        expect(others).toBe(1);
        expect(errors).toHaveBeenCalled();
      } finally {
        errors.mockRestore();
      }
    },
  },
  {
    id: "7",
    title:
      "a snapshot keeps its identity until its value changes — including across an unrelated write",
    run(subject) {
      const m = subject.make();
      const first = m.read();
      expect(m.read()).toBe(first);
      if (m.changeOther) {
        m.changeOther();
        expect(m.read(), "an unrelated write kept the identity").toBe(first);
      }
      m.changeEqual();
      expect(m.read(), "an equal write kept the identity").toBe(first);
      m.change();
      expect(m.read()).not.toBe(first);
    },
  },
  {
    id: "8",
    title:
      "after dispose: the last value reads, nothing notifies, mutators are no-ops, unsubscribe is idempotent",
    run(subject) {
      const m = subject.make();
      const c = counted(m);
      const last = m.read();
      m.dispose();
      m.change();
      expect(c.n).toBe(0);
      expect(m.read()).toBe(last);
      c.off();
      c.off();
      let late = 0;
      m.subscribe(() => {
        late++;
      })();
      expect(late, "subscribing after dispose delivers nothing").toBe(0);
    },
  },
];

export function modelContract<T>(name: string, subject: ContractSubject<T>): void {
  describe(`B1 · model contract — ${name}`, () => {
    for (const check of CONTRACT_CHECKS) {
      it(`${check.id}. ${check.title}`, () => check.run(subject));
    }
  });
}
