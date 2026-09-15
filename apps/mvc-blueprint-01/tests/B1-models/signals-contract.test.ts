import { describe, expect, it } from "vitest";
import * as alien from "../../src/lib/signals/alien.js";
import type { Signals, SignalsImplementation } from "../../src/lib/signals/contract.js";
import * as preact from "../../src/lib/signals/preact.js";

/**
 * B1 · the signals contract. Every guarantee the app relies on, run against
 * BOTH implementations. The second half records FOUR of the five behaviours
 * the contract leaves open — per library — so an upgrade that changes one
 * fails here, where it is named, instead of somewhere in the controller. The
 * fifth — an effect created inside another effect's run — is normalized
 * instead (`alien.ts` creates every effect untracked) and pinned as
 * guarantee 8 below.
 *
 * This is the only suite that imports the implementations directly; the rest
 * of the ladder reaches them through `@todo/signals` (see signals-binding).
 */
type Impl = Signals & { implementation: SignalsImplementation };
const IMPLEMENTATIONS: Impl[] = [alien, preact];

/** Counts an effect's runs AFTER its first. */
const runsOf = (s: Impl, read: () => void) => {
  let n = -1;
  const stop = s.effect(() => {
    read();
    n++;
  });
  return {
    get n() {
      return n;
    },
    stop,
  };
};

for (const s of IMPLEMENTATIONS) {
  describe(`B1 · signals contract — ${s.implementation}`, () => {
    it("1. an equal write notifies nobody", () => {
      const a = s.signal(1);
      const runs = runsOf(s, () => a());
      a(1);
      expect(runs.n).toBe(0);
      a(2);
      expect(runs.n).toBe(1);
    });

    it("1b. a write of undefined is a write — by argument count, not by value", () => {
      const a = s.signal<number | undefined>(1);
      a(undefined);
      expect(a()).toBeUndefined();
    });

    it("2. an effect runs once on creation", () => {
      let runs = 0;
      s.effect(() => {
        runs++;
      });
      expect(runs).toBe(1);
    });

    it("3. an effect depends on what its last run read; an untracked read is no dependency", () => {
      const tracked = s.signal(0);
      const ignored = s.signal(0);
      const runs = runsOf(s, () => {
        tracked();
        s.untracked(() => ignored());
      });
      ignored(1);
      expect(runs.n, "untracked read").toBe(0);
      tracked(1);
      expect(runs.n, "tracked read").toBe(1);
    });

    it("3b. a dependency not read on the last run no longer wakes the effect", () => {
      const gate = s.signal(true);
      const inner = s.signal(0);
      const runs = runsOf(s, () => {
        if (gate()) inner();
      });
      gate(false);
      expect(runs.n).toBe(1);
      inner(1);
      expect(runs.n, "inner was not read on the last run").toBe(1);
    });

    it("4. two writes in a batch wake an effect once; outside a batch, twice", () => {
      const a = s.signal(0);
      const b = s.signal(0);
      const runs = runsOf(s, () => {
        a();
        b();
      });
      s.batch(() => {
        a(1);
        b(1);
      });
      expect(runs.n, "batched").toBe(1);
      a(2);
      b(2);
      expect(runs.n, "unbatched").toBe(3);
    });

    it("4b. a read inside a batch sees the new value; nested batches flush at the outermost", () => {
      const a = s.signal(0);
      const doubled = s.computed(() => a() * 2);
      const runs = runsOf(s, () => a());
      let seen = -1;
      let insideRuns = -1;
      s.batch(() => {
        s.batch(() => a(2));
        seen = doubled();
        insideRuns = runs.n;
      });
      expect(seen).toBe(4);
      expect(insideRuns, "nothing ran inside the outer batch").toBe(0);
      expect(runs.n, "it ran once the outer batch closed").toBe(1);
    });

    it("4c. batch returns what its function returns", () => {
      expect(s.batch(() => 42)).toBe(42);
      expect(s.untracked(() => "x")).toBe("x");
    });

    it("5. a diamond runs its effect once, with consistent values", () => {
      const a = s.signal(1);
      const b = s.computed(() => a() * 2);
      const c = s.computed(() => a() * 3);
      const seen: string[] = [];
      s.effect(() => {
        seen.push(`${b()}+${c()}`);
      });
      a(2);
      expect(seen).toEqual(["2+3", "4+6"]);
    });

    it("6. a computed returns the same reference until a dependency changes", () => {
      const list = s.signal([1, 2, 3]);
      const evens = s.computed(() => list().filter((n) => n % 2 === 0));
      const first = evens();
      expect(evens()).toBe(first);
      list([1, 2, 3]);
      expect(evens(), "a new source array recomputes").not.toBe(first);
      expect(evens()).toEqual([2]);
    });

    it("7. stop() is final — including when called from inside the effect's own run", () => {
      const a = s.signal(0);
      let runs = 0;
      let stop: () => void = () => {};
      stop = s.effect(() => {
        a();
        runs++;
        if (runs === 2) stop();
      });
      a(1);
      a(2);
      expect(runs).toBe(2);
      const b = s.signal(0);
      const counted = runsOf(s, () => b());
      counted.stop();
      b(1);
      expect(counted.n).toBe(0);
    });

    it("8. an effect created during another effect's run survives that effect's re-run", () => {
      const outer = s.signal(0);
      const inner = s.signal(0);
      let innerRuns = 0;
      let created = false;
      s.effect(() => {
        outer();
        if (created) return;
        created = true;
        s.effect(() => {
          inner();
          innerRuns++;
        });
      });
      outer(1); // re-runs the outer effect; it does not recreate the inner one
      inner(1);
      expect(innerRuns, "the inner effect is still subscribed").toBe(2);
    });

    it("converges: an effect that drains a queue it tracks ends with the queue empty", () => {
      // What the controller does on every edge. Whether the drain re-runs the
      // effect is left open (below); that it converges is not.
      const queue = s.signal<number[]>([]);
      let runs = 0;
      s.effect(() => {
        queue();
        runs++;
        s.untracked(() => {
          if (queue().length > 0) queue([]);
        });
      });
      queue([1, 2]);
      expect(queue()).toEqual([]);
      expect(runs).toBeLessThanOrEqual(3);
    });
  });
}

/**
 * FOUR of the five behaviours the contract leaves open (spec §4.2), recorded
 * per library — the fifth (effect ownership) is normalized and pinned as
 * guarantee 8 above instead. The app relies on none of the five — that is the
 * point of recording these four: when a library changes one, this fails and
 * names it.
 */
describe("B1 · signals — left open, and recorded", () => {
  const recorded: Record<SignalsImplementation, Record<string, unknown>> = {
    alien: { selfWriteReruns: false, nonConverging: "stops", throwingFlush: "skips-the-rest", nestedWriteOrder: "during" },
    preact: { selfWriteReruns: true, nonConverging: "throws", throwingFlush: "runs-the-rest", nestedWriteOrder: "after" },
  };

  for (const s of IMPLEMENTATIONS) {
    it(`${s.implementation}: behaves as recorded`, () => {
      const observed: Record<string, unknown> = {};

      {
        const q = s.signal<number[]>([]);
        let runs = 0;
        s.effect(() => {
          q();
          runs++;
          s.untracked(() => {
            if (q().length > 0) q([]);
          });
        });
        q([1]);
        observed.selfWriteReruns = runs === 3;
      }

      {
        const n = s.signal(0);
        try {
          s.effect(() => {
            const v = n();
            if (v < 1000) n(v + 1);
          });
          observed.nonConverging = "stops";
        } catch (error) {
          observed.nonConverging = /cycle/i.test(String(error)) ? "throws" : String(error);
        }
      }

      {
        const a = s.signal(0);
        let armed = false;
        let otherRuns = 0;
        s.effect(() => {
          a();
          if (armed) throw new Error("boom");
        });
        s.effect(() => {
          a();
          otherRuns++;
        });
        armed = true;
        try {
          a(1);
        } catch {
          // recorded below
        }
        armed = false;
        observed.throwingFlush = otherRuns === 2 ? "runs-the-rest" : "skips-the-rest";
      }

      {
        const a = s.signal(0);
        const b = s.signal(0);
        const log: string[] = [];
        s.effect(() => {
          if (b() > 0) log.push("B ran");
        });
        s.effect(() => {
          const v = a();
          if (v > 0) {
            b(v);
            log.push("A wrote");
          }
        });
        a(1);
        observed.nestedWriteOrder = log[0] === "B ran" ? "during" : "after";
      }

      expect(observed).toEqual(recorded[s.implementation]);
    });
  }
});
