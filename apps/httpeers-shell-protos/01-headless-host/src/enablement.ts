// DERIVED-FROM-NOTE: 11-Prototype 1 API Reference.md §4 (signatures, grammar,
// "Malformed when clause", onChange-only-on-real-change)
// DERIVED-FROM-NOTE: 06-Enablement: When Clauses and the Biscuit Datalog Question.md §5
// (why this is an interface and not a dependency; why the grammar is narrow)
//
// RECONSTRUCTED, NOT RECOVERED. The archive 09-prototype-01-headless-host.tar.gz
// lost all of src/; this file is rebuilt from the signature-level references above.
//
// This interface is the swap point for Biscuit. `factSetEnablement` is the stub
// used by rungs 1-5; the Datalog-backed implementation satisfies the same
// interface and lazy-loads at the rung where mesh capabilities arrive
// (biscuit-wasm measured 2.35 MB of WASM + 96 KB of glue — correct engine,
// wrong load time for a bootstrap shell. Rung 08 now uses webrun-biscuit, about
// 100 KB of JavaScript, which weakens that argument without changing the seam.)

/**
 * A ground Datalog fact. The shape mirrors Datalog deliberately —
 * `right("peer1", "read")` — so the vocabulary is forward-compatible with the
 * real engine.
 */
export interface Fact {
  readonly predicate: string;
  readonly terms: readonly (string | number | boolean)[];
}

/**
 * The enablement adapter. `when` clauses are evaluated against the current
 * fact set at *render* time, never at registration time — that timing is what
 * lets a static, build-time-generated manifest behave dynamically.
 */
export interface Enablement {
  /** Replace the whole fact set. Fires `onChange` only if the set differs. */
  setFacts(facts: readonly Fact[]): void;
  /** Add a fact. Re-asserting an existing fact is a no-op. */
  assert(fact: Fact): void;
  /** Remove a fact. Retracting an absent fact is a no-op. */
  retract(fact: Fact): void;
  /** Absent or empty `when` is always enabled. Malformed `when` throws. */
  evaluate(when: string | undefined): boolean;
  /** Subscribe to fact-set changes. Returns a disposer. */
  onChange(cb: () => void): () => void;
}

/** Construct a `Fact`. Terms are ground: strings, numbers or booleans. */
export function fact(
  predicate: string,
  ...terms: readonly (string | number | boolean)[]
): Fact {
  return Object.freeze({ predicate, terms: Object.freeze([...terms]) });
}

// === Canonical form ===============================================
//
// Facts are matched by canonical string form. `selection("file")` asserted and
// `selection("file")` in a when-clause must produce the same string, so both
// sides go through the same term serialiser.

function canonicalTerm(term: string | number | boolean): string {
  if (typeof term === "string") return JSON.stringify(term);
  return String(term);
}

function canonicalFact(f: Fact): string {
  return `${f.predicate}(${f.terms.map(canonicalTerm).join(",")})`;
}

// === The when-clause parser =======================================
//
// The grammar is confined to what translates cleanly to Datalog: conjunctions
// of positive or negated ground facts, comma as AND, `!` as negation.
// Disjunction, comparison operators and variables throw. Needing any of them
// is the signal to bring in the real engine, not to grow the stub into a
// second policy language.

class MalformedWhenClause extends Error {
  constructor(clause: string, reason: string) {
    super(`Malformed when clause: ${clause} (${reason})`);
    this.name = "MalformedWhenClause";
  }
}

interface Atom {
  readonly negated: boolean;
  readonly canonical: string;
}

/** Operators that belong to a real policy engine, not to this stub. */
const FORBIDDEN = ["||", "&&", "==", "!=", ">=", "<=", ">", "<", "$"] as const;

/**
 * Split on commas that are at paren depth 0 and outside a quoted string.
 * `right("peer1", "read")` is one atom, not two.
 */
function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/** Reject forbidden operators appearing outside a quoted string. */
function rejectForbidden(clause: string): void {
  let quote: string | null = null;
  for (let i = 0; i < clause.length; i++) {
    const ch = clause[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    for (const op of FORBIDDEN) {
      if (clause.startsWith(op, i)) {
        throw new MalformedWhenClause(
          clause,
          `"${op}" is not in the stub grammar — bring in the real engine`,
        );
      }
    }
  }
  if (quote) throw new MalformedWhenClause(clause, "unterminated string");
}

const PREDICATE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/;
const INTEGER = /^-?\d+$/;
const DECIMAL = /^-?\d+\.\d+$/;

function parseTerm(raw: string, clause: string): string | number | boolean {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      throw new MalformedWhenClause(clause, `bad string term ${text}`);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1);
  }
  if (INTEGER.test(text) || DECIMAL.test(text)) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  throw new MalformedWhenClause(
    clause,
    `term ${JSON.stringify(text)} is not a ground string, number or boolean`,
  );
}

function parseWhen(clause: string): Atom[] {
  rejectForbidden(clause);
  const atoms: Atom[] = [];
  for (const rawAtom of splitTopLevel(clause)) {
    let text = rawAtom.trim();
    if (text === "") throw new MalformedWhenClause(clause, "empty conjunct");
    let negated = false;
    if (text.startsWith("!")) {
      negated = true;
      text = text.slice(1).trim();
    }
    const match = PREDICATE.exec(text);
    if (!match) {
      throw new MalformedWhenClause(
        clause,
        `${JSON.stringify(text)} is not a ground fact`,
      );
    }
    const predicate = match[1] as string;
    const args = (match[2] as string).trim();
    const terms =
      args === ""
        ? []
        : splitTopLevel(args).map((term) => parseTerm(term, clause));
    atoms.push({ negated, canonical: canonicalFact({ predicate, terms }) });
  }
  return atoms;
}

/**
 * The stub `Enablement`. Matches ground facts by canonical string form. The
 * production implementation hands the same facts to Biscuit's Datalog engine
 * and satisfies this same interface, so callers never change.
 */
export function factSetEnablement(initial?: readonly Fact[]): Enablement {
  let facts = new Set<string>((initial ?? []).map(canonicalFact));
  const watchers = new Set<() => void>();

  const notify = (): void => {
    for (const cb of [...watchers]) cb();
  };

  return {
    setFacts(next: readonly Fact[]): void {
      const replacement = new Set(next.map(canonicalFact));
      let changed = replacement.size !== facts.size;
      if (!changed) {
        for (const key of replacement) {
          if (!facts.has(key)) {
            changed = true;
            break;
          }
        }
      }
      facts = replacement;
      if (changed) notify();
    },

    assert(f: Fact): void {
      const key = canonicalFact(f);
      if (facts.has(key)) return; // re-asserting is a no-op
      facts.add(key);
      notify();
    },

    retract(f: Fact): void {
      const key = canonicalFact(f);
      if (!facts.delete(key)) return; // retracting an absent fact is a no-op
      notify();
    },

    evaluate(when: string | undefined): boolean {
      if (when === undefined) return true;
      const clause = when.trim();
      if (clause === "") return true;
      for (const atom of parseWhen(clause)) {
        const present = facts.has(atom.canonical);
        if (atom.negated ? present : !present) return false;
      }
      return true;
    },

    onChange(cb: () => void): () => void {
      watchers.add(cb);
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        watchers.delete(cb);
      };
    },
  };
}
