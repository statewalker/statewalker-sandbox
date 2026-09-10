// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/
//   17-prototype-08-biscuit-enablement.tar.gz -> proto8-biscuit/src/biscuit-enablement.ts
// Verbatim apart from this header and ONE correction, made 2026-09-09 by the
// Track SH audit and marked in place: every query now goes through
// `queryWithLimits(rule, RUN_LIMITS)` instead of `query(rule)`, because the
// default 1 ms `max_time` made `evaluate()` throw an uncatchable bare object
// under CPU contention. See `RUN_LIMITS` below, `tests/constraints.test.ts`,
// and the "Corrections to the notes" entry in `PROVENANCE.md`. The archive's
// own text for the two changed lines is quoted at each site.
import type { Enablement, Fact } from "./enablement.js";

/**
 * PROTOTYPE 8 — Biscuit-backed `Enablement`.
 *
 * The production evaluator. Reuses the SAME Datalog engine already used for
 * capability checks, so "hidden because you lack the right" and "hidden
 * because nothing is selected" become one code path over one fact set.
 *
 * Loading is async and the payload is ~2.35 MB of WASM, so the module is
 * dynamically imported and memoised. Nothing above this file changes: the
 * exported object satisfies `Enablement` exactly as the stub does.
 */

type BiscuitModule = typeof import("@biscuit-auth/biscuit-wasm");

let loading: Promise<BiscuitModule> | undefined;

/**
 * Load and memoise the WASM module.
 *
 * NOTE the memo is NOT cleared on rejection here, unlike prototype 5's
 * activation. A missing WASM binary is not a transient condition, and
 * retrying a failed load on every menu render would be pathological. If
 * retry is ever wanted it should be explicit, not implicit.
 */
export function loadBiscuit(): Promise<BiscuitModule> {
  loading ??= import("@biscuit-auth/biscuit-wasm");
  return loading;
}

/**
 * The `RunLimits` argument every query in this module passes.
 *
 * CORRECTION 2026-09-09 (audit) — see `tests/constraints.test.ts`, which
 * measures all of the below. Two layers, and it matters which does the work.
 *
 * WHAT WAS WRONG. `query(rule)` charges its elapsed time against a budget
 * that is CUMULATIVE ACROSS THE INSTANCE and trips permanently once spent.
 * So:
 *  - the Authorizer is not single-use. Warm, one instance answers ~430
 *    successive queries over a 20-fact world and ~24 over an 8,000-fact one:
 *    the budget tracks WORK. Cold merely spends it all on the first query,
 *    which is what made it look structural to note 18.
 *  - the budget is wall clock, and a descheduled thread spends wall clock
 *    without doing work. On a machine loaded to 3x its cores, a query whose
 *    median is 0.033 ms measured a p99 of 12 ms and a max of 53 ms. That is
 *    what made `evaluate()` throw `{RunLimit:"Timeout"}` — a bare object
 *    `catch (e) { log(e.message) }` reads as `undefined` — on a fresh
 *    authorizer, which is why the rung's per-query rebuild never fixed it.
 *
 * WHY THE FIX WORKS, AND IT IS NOT THE NUMBERS BELOW. `queryWithLimits` does
 * not consult that cumulative budget at all: measured, it answers on an
 * already-exhausted instance, and 60,000 successive queries on one instance
 * never trip it. Nor does it honour its own argument — `{}`, `{nope:1}` and
 * `max_time_micro: 1` all behave identically to this struct, while `null` or
 * a non-object throws. In `@biscuit-auth/biscuit-wasm@0.6.0` the limits are
 * INERT for queries; what the call buys is the door that does not charge the
 * shared budget.
 *
 * THE TRADE, stated because it is real: this removes an engine-side runaway
 * guard from query evaluation and nothing replaces it. That is acceptable
 * HERE and only here — `evaluate()` interpolates nothing that has not passed
 * `CLAUSE` (ground literal patterns), `query`/`queryAny` take shell-authored
 * source, and `matchesTerm` binds untrusted values as parameters. A caller
 * that widens the `when` grammar, or admits foreign rule SOURCE, is taking
 * that guard's absence on and must bound evaluation itself.
 *
 * The values are biscuit's own documented defaults with `max_time_micro`
 * raised to one second. They are kept, inert, so that the intent is on the
 * record and a biscuit-wasm that honours them needs no change here — not
 * because they currently do anything. A test asserts the inertness, so this
 * paragraph stops being true loudly rather than silently.
 */
export const RUN_LIMITS = Object.freeze({
  max_facts: 1000,
  max_iterations: 100,
  max_time_micro: 1_000_000,
});

/** Canonical string form of a fact, matching the `when` clause syntax. */
function factId(f: Fact): string {
  return `${f.predicate}(${f.terms.map((t) => JSON.stringify(t)).join(", ")})`;
}

/** One fact pattern: `predicate("a", "b")`, optionally negated. */
const CLAUSE =
  /^[a-z_][a-zA-Z0-9_]*\(\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false)?(?:\s*,\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false))*\s*\)$/;

/** Split a `when` string on top-level commas, respecting parentheses. */
function clauses(when: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of when) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current);
  return out;
}

export interface BiscuitEnablement extends Enablement {
  /** Run a Datalog rule and return the first term of each result. */
  query(ruleSource: string): string[];
  /** True if ANY of the given rules produces a result -- disjunction. */
  queryAny(ruleSources: string[]): boolean;
  /**
   * Match a predicate against an untrusted term value, injected as a
   * PARAMETER rather than interpolated into source.
   */
  matchesTerm(predicate: string, value: string): boolean;
}

export async function createBiscuitEnablement(
  initial: readonly Fact[] = [],
): Promise<BiscuitEnablement> {
  const bis = await loadBiscuit();
  let facts = new Set(initial.map(factId));
  const listeners = new Set<() => void>();

  const fire = () => {
    for (const cb of [...listeners]) cb();
  };

  /**
   * Build a fresh authorizer over the current fact set.
   *
   * The archive's comment here read:
   *
   *   "MEASURED CONSTRAINT: the WASM Authorizer is SINGLE-USE. A second
   *   query() on the same instance fails with RunLimit::Timeout rather than
   *   returning a result."
   *
   * It is not single-use; `RUN_LIMITS` above has the measurement. One
   * instance shares one time budget across every query it answers, so reuse
   * is bounded by work rather than by count. The per-query rebuild STAYS,
   * because resetting the budget per query is still the right shape and
   * three of the recovered contract tests depend on it — but it is no longer
   * the whole mitigation, since the budget is wall clock. Raising
   * `max_time` is the other half.
   */
  const authorizer = () => {
    const builder = new bis.AuthorizerBuilder();
    for (const f of facts) builder.addCode(`${f};`);
    return builder.buildUnauthenticated();
  };

  /**
   * Query a rule whose SOURCE is trusted (validated by CLAUSE, or authored
   * by the shell). A rule head must carry at least one term -- `_m()` is a
   * parse error -- hence `_m(true)`.
   */
  const ask = (ruleSource: string): string[] =>
    authorizer()
      .queryWithLimits(bis.Rule.fromString(ruleSource), RUN_LIMITS)
      .map((f) => String(f));

  return {
    setFacts(next) {
      facts = new Set(next.map(factId));
      fire();
    },

    assert(f) {
      const id = factId(f);
      if (!facts.has(id)) {
        facts.add(id);
        fire();
      }
    },

    retract(f) {
      if (facts.delete(factId(f))) fire();
    },

    evaluate(when) {
      if (!when || !when.trim()) return true;
      return clauses(when).every((raw) => {
        const clause = raw.trim();
        if (!clause) return true;
        const negated = clause.startsWith("!");
        const pattern = (negated ? clause.slice(1) : clause).trim();
        // Structural validation happens BEFORE the pattern reaches the
        // engine, so only ground literal patterns are ever interpolated.
        if (!CLAUSE.test(pattern)) {
          throw new Error(`Malformed when clause: ${clause}`);
        }
        const held = ask(`_m(true) <- ${pattern}`).length > 0;
        return negated ? !held : held;
      });
    },

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    query(ruleSource) {
      return ask(ruleSource).map((s) => {
        const inner = s.slice(s.indexOf("(") + 1, s.lastIndexOf(")"));
        return inner.replace(/^"|"$/g, "");
      });
    },

    queryAny(ruleSources) {
      // Each rule needs its own authorizer, so disjunction costs one build
      // per branch. Acceptable for menu-sized rule counts.
      return ruleSources.some((r) => ask(r).length > 0);
    },

    matchesTerm(predicate, value) {
      // `value` is UNTRUSTED -- it may come from a foreign peer's manifest.
      // The tagged template is invoked manually with a synthetic strings
      // array so the predicate (trusted, from shell code) is part of the
      // source while the value becomes a bound PARAMETER. Biscuit escapes
      // it, so Datalog syntax inside it is data, never code.
      const r = bis.rule([`_m(true) <- ${predicate}(`, `)`] as never, value);
      return authorizer().queryWithLimits(r, RUN_LIMITS).length > 0;
    },
  };
}
