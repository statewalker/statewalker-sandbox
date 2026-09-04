// RECOVERED-FROM-ARCHIVE: notes/drive/2026-09-02.Httpeers-Shell/
//   17-prototype-08-biscuit-enablement.tar.gz -> proto8-biscuit/src/enablement.ts
// Verbatim apart from this header. Nothing in the body was rewritten.
/**
 * Enablement: the `when` evaluator, behind an interface.
 *
 * WHY AN INTERFACE. The production evaluator is Biscuit's Datalog engine,
 * which reuses the SAME fact set as capability checks -- so "hidden because
 * you lack the right" and "hidden because nothing is selected" collapse into
 * one code path. But biscuit-wasm measures 2.35 MB of WASM plus 96 KB of
 * glue (~0.9-1 MB gzipped), which is far too much to load eagerly into a
 * bootstrap shell served from dumb static hosting merely to grey out a menu
 * item.
 *
 * So: this interface is the contract, `factSetEnablement()` is the stub used
 * by prototypes 1-5, and the Biscuit-backed implementation is lazy-loaded at
 * the rung where mesh capabilities first arrive. Callers never change.
 *
 * A fact is a predicate name plus terms, mirroring Datalog so the stub's
 * vocabulary is forward-compatible with the real engine.
 */

export interface Fact {
  readonly predicate: string;
  readonly terms: readonly (string | number | boolean)[];
}

export interface Enablement {
  /** Replace the whole fact set. */
  setFacts(facts: readonly Fact[]): void;
  assert(fact: Fact): void;
  retract(fact: Fact): void;
  /** Evaluate a `when` expression against the current facts. */
  evaluate(when: string | undefined): boolean;
  /** Fires when the fact set changes, so menus can re-render. */
  onChange(cb: () => void): () => void;
}

export function fact(
  predicate: string,
  ...terms: readonly (string | number | boolean)[]
): Fact {
  return Object.freeze({ predicate, terms: Object.freeze([...terms]) });
}

/** Canonical string form, matching the `when` clause syntax exactly. */
function factId(f: Fact): string {
  return `${f.predicate}(${f.terms.map((t) => JSON.stringify(t)).join(", ")})`;
}

/** One fact pattern: `predicate("a", "b")`, optionally negated. */
const CLAUSE = /^[a-z_][a-zA-Z0-9_]*\(\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false)?(?:\s*,\s*(?:"[^"]*"|-?\d+(?:\.\d+)?|true|false))*\s*\)$/;

/** Normalise whitespace inside a pattern so `a("x","y")` matches `a("x", "y")`. */
function normalise(pattern: string): string {
  const open = pattern.indexOf("(");
  const name = pattern.slice(0, open);
  const inner = pattern.slice(open + 1, pattern.lastIndexOf(")")).trim();
  if (!inner) return `${name}()`;
  const terms = inner.split(",").map((t) => t.trim());
  return `${name}(${terms.join(", ")})`;
}

/**
 * Stub evaluator for prototypes 1-5.
 *
 * Grammar is deliberately confined to the subset that survives translation
 * to Datalog: a conjunction of positive or negated ground fact patterns.
 *
 *   selection("file")
 *   mesh("connected"), focus("explorer")
 *   !selection("file")
 *
 * Comma means AND; a leading `!` negates. An absent or empty `when` is
 * always enabled -- an unconditional contribution.
 *
 * NOT supported, on purpose: disjunction, comparison operators, variables,
 * rules. Needing any of those is the signal to swap in the real engine
 * rather than to grow this stub into a second policy language.
 */
export function factSetEnablement(initial: readonly Fact[] = []): Enablement {
  let facts = new Set(initial.map(factId));
  const listeners = new Set<() => void>();

  const fire = () => {
    for (const cb of [...listeners]) cb();
  };

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
      return when
        .split(",")
        // a pattern may itself contain commas between terms, so re-join
        // and parse properly rather than splitting naively
        .reduce<string[]>((acc, part) => {
          const last = acc[acc.length - 1];
          if (last !== undefined && (last.match(/\(/g)?.length ?? 0) > (last.match(/\)/g)?.length ?? 0)) {
            acc[acc.length - 1] = `${last},${part}`;
          } else {
            acc.push(part);
          }
          return acc;
        }, [])
        .every((raw) => {
          const clause = raw.trim();
          if (!clause) return true;
          const negated = clause.startsWith("!");
          const pattern = (negated ? clause.slice(1) : clause).trim();
          if (!CLAUSE.test(pattern)) {
            throw new Error(`Malformed when clause: ${clause}`);
          }
          const held = facts.has(normalise(pattern));
          return negated ? !held : held;
        });
    },

    onChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
