// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/
//   17-prototype-08-biscuit-enablement.tar.gz -> proto8-biscuit/src/biscuit-enablement.ts
// Verbatim apart from this header. Nothing in the body was rewritten.
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
   * MEASURED CONSTRAINT: the WASM Authorizer is SINGLE-USE. A second
   * `query()` on the same instance fails with RunLimit::Timeout rather than
   * returning a result. So one authorizer is built per query, not per
   * evaluation and certainly not once. This is the dominant performance
   * cost of the substitution -- see the functional description.
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
      .query(bis.Rule.fromString(ruleSource))
      .map((f) => f.toString());

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
      return authorizer().query(r).length > 0;
    },
  };
}
