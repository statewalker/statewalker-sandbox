/**
 * Roles describe people; capabilities are what code checks.
 *
 * The hub assigns roles and stays deliberately ignorant of what any
 * application can do. Each node owns its own role → capability mapping and
 * takes the **union** of the capabilities of every role in the token.
 *
 * Three rules make that safe:
 *
 *  - the union is purely additive — a role may never remove a capability, so
 *    there is no precedence or ordering to arbitrate;
 *  - role names are namespaced (`std:` for the short reserved list, `<mesh>/`
 *    for custom ones), and because a mesh id derives from its issuer key the
 *    namespace is self-certifying — no central registry;
 *  - **an unknown role grants nothing.** Never a fallback. This is what stops
 *    silent over-granting as the role list grows.
 */

export type Vocabulary = ReadonlyMap<string, readonly string[]>;

export function defineVocabulary(entries: Record<string, string[]>): Vocabulary {
  const bad = Object.keys(entries).filter((r) => !r.startsWith("std:") && !r.includes("/"));
  if (bad.length > 0) {
    throw new Error(
      `defineVocabulary: unnamespaced role(s) ${bad.join(", ")} — use "std:<name>" or "<mesh>/<name>"`,
    );
  }
  return new Map(Object.entries(entries).map(([k, v]) => [k, Object.freeze([...v])]));
}

export interface Resolution {
  capabilities: string[];
  known: string[];
  unknown: string[];
}

export function capabilitiesFor(vocab: Vocabulary, roles: string[]): Resolution {
  const caps = new Set<string>();
  const known: string[] = [];
  const unknown: string[] = [];
  for (const role of roles) {
    const granted = vocab.get(role);
    if (granted === undefined) {
      unknown.push(role);
      continue; // unknown role -> zero capabilities, never a fallback
    }
    known.push(role);
    for (const c of granted) caps.add(c);
  }
  return { capabilities: [...caps].sort(), known, unknown };
}
