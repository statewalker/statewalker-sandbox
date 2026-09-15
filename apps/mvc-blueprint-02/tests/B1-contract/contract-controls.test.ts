import { describe, expect, it } from "vitest";
import { CONTRACT_CHECKS, type ContractSubject } from "./model-contract.js";

interface Defects {
  noImmediate?: boolean;
  notifyOnEqual?: boolean;
  twoPerIntention?: boolean;
  noIsolation?: boolean;
  freshSnapshot?: boolean;
  noDispose?: boolean;
}

/** A plain listener-set model with switchable defects — the suite must catch each one. */
function naive(defects: Defects = {}): ContractSubject<{ readonly n: number }> {
  return {
    make() {
      let value: Readonly<{ n: number }> = Object.freeze({ n: 0 });
      let disposed = false;
      const listeners = new Set<() => void>();
      const notify = () => {
        for (const l of [...listeners]) {
          if (!listeners.has(l)) continue;
          if (defects.noIsolation) l();
          else
            try {
              l();
            } catch (error) {
              console.error(error);
            }
        }
      };
      const write = (n: number) => {
        if (disposed && !defects.noDispose) return;
        if (n === value.n && !defects.notifyOnEqual) return;
        value = Object.freeze({ n });
        notify();
        if (defects.twoPerIntention) notify();
      };
      return {
        read: () => (defects.freshSnapshot ? { ...value } : value),
        subscribe(listener) {
          if (disposed && !defects.noDispose) return () => {};
          const entry = () => listener();
          listeners.add(entry);
          if (!defects.noImmediate) entry();
          return () => {
            listeners.delete(entry);
          };
        },
        change: () => write(value.n + 1),
        changeEqual: () => write(value.n),
        dispose: () => {
          disposed = true;
        },
      };
    },
  };
}

const check = (id: string) => {
  const found = CONTRACT_CHECKS.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};

describe("B1 · the contract suite can fail", () => {
  it("a correct plain model passes every check", () => {
    for (const c of CONTRACT_CHECKS) expect(() => c.run(naive()), c.title).not.toThrow();
  });

  for (const [defect, id] of [
    ["noImmediate", "1"],
    ["twoPerIntention", "2"],
    ["notifyOnEqual", "3"],
    ["noIsolation", "6"],
    ["freshSnapshot", "7"],
    ["noDispose", "8"],
  ] as const) {
    it(`check ${id} rejects a model with ${defect}`, () => {
      expect(() => check(id).run(naive({ [defect]: true }))).toThrow();
    });
  }
});
