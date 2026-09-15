// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/
//   17-prototype-08-biscuit-enablement.tar.gz -> proto8-biscuit/src/biscuit-enablement.ts
// ADAPTED 2026-09-15 — no longer verbatim. The engine is `@statewalker/webrun-biscuit`
// (pure TypeScript), not `@biscuit-auth/biscuit-wasm`. The recovered body survives
// unchanged at statewalker-sandbox `cd5bb00`, this same path. The `Enablement`
// surface, the clause grammar and the parameter-injection rule did not change; what
// did, and why, is in PROVENANCE.md.
import {
  type Evaluation,
  evaluate as evaluateProgram,
  type Predicate,
  type Term,
} from "@statewalker/webrun-biscuit";
import type { Enablement, Fact } from "./enablement.js";

/**
 * PROTOTYPE 8 — Biscuit-backed `Enablement`.
 *
 * The production evaluator. Reuses the SAME Datalog engine already used for
 * capability checks, so "hidden because you lack the right" and "hidden
 * because nothing is selected" become one code path over one fact set.
 *
 * Loading stays async and memoised, so nothing above this file changes: the
 * exported object satisfies `Enablement` exactly as the stub does. The payload
 * that made that necessary — ~2.35 MB of WASM — is gone; the engine is about
 * 100 KB of JavaScript.
 */

type BiscuitModule = typeof import("@statewalker/webrun-biscuit");

let loading: Promise<BiscuitModule> | undefined;

/**
 * Load and memoise the engine module.
 *
 * NOTE the memo is NOT cleared on rejection here, unlike prototype 5's
 * activation. A missing module is not a transient condition, and retrying a
 * failed load on every menu render would be pathological. If retry is ever
 * wanted it should be explicit, not implicit.
 */
export function loadBiscuit(): Promise<BiscuitModule> {
  loading ??= import("@statewalker/webrun-biscuit");
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

/** A term as Datalog prints it — the form the wasm `Fact.toString()` returned. */
function printTerm(term: Term): string {
  switch (term.t) {
    case "str":
      return JSON.stringify(term.v);
    case "int":
    case "bool":
      return String(term.v);
    default:
      return JSON.stringify(term);
  }
}

const printFact = (fact: Predicate): string =>
  `${fact.name}(${fact.terms.map(printTerm).join(", ")})`;

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
  await loadBiscuit();
  let facts = new Set(initial.map(factId));
  const listeners = new Set<() => void>();

  /**
   * ONE evaluation per fact set, reused by every query until the facts change.
   *
   * The recovered adapter built a fresh authorizer PER QUERY, because a wasm
   * Authorizer failed on reuse with a bare `{RunLimit: "Timeout"}` (note 18
   * §4.1, which constraints.test.ts had shown to be a cold-engine timing
   * artefact). The TypeScript engine has no such limit: an evaluation is a plain
   * world any number of queries read. So the mitigation becomes a cache, and the
   * dominant cost of the substitution goes with it.
   */
  let evaluation: Evaluation | undefined;
  const world = (): Evaluation => {
    evaluation ??= evaluateProgram(null, [...facts].map((f) => `${f};`).join("\n"));
    return evaluation;
  };

  const fire = () => {
    evaluation = undefined;
    for (const cb of [...listeners]) cb();
  };

  /**
   * Query a rule whose SOURCE is trusted (validated by CLAUSE, or authored
   * by the shell). A rule head must carry at least one term -- `_m()` is a
   * parse error -- hence `_m(true)`.
   */
  const ask = (ruleSource: string): string[] => world().query(ruleSource).map(printFact);

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
      // One evaluation serves every branch now, so disjunction costs one query
      // per branch rather than one authorizer build.
      return ruleSources.some((r) => ask(r).length > 0);
    },

    matchesTerm(predicate, value) {
      // `value` is UNTRUSTED -- it may come from a foreign peer's manifest. The
      // predicate (trusted, from shell code) is part of the source; the value is
      // a bound `{value}` PARAMETER, so Datalog syntax inside it is data, never
      // code.
      return (
        world().query(`_m(true) <- ${predicate}({value})`, { params: { value } }).length > 0
      );
    },
  };
}
