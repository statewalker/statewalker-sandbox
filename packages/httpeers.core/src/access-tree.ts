/**
 * A-1: `.access` as a walked tree, not a rules array.
 *
 * The design has said since the beginning that policy lives in `.access`
 * files resolved root to leaf with deny-by-default. Resolution rules:
 *  - walk from `/` down to the resource, collecting every `.access` entry
 *    on the way; a deeper entry overrides a shallower one
 *  - deny by default: no entry anywhere means no access
 *  - an entry grants to capabilities (`anyOf`), or denies outright
 *    (`anyOf: []`)
 *  - `public: true` grants without any token at all
 *  - an optional per-method override replaces the directory entry wholesale
 *    for that method
 *
 * A-3 (`vocabulary.ts`) changed WHAT `anyOf` names: policy checks
 * CAPABILITIES, not roles. `resolveAccess` expands the caller's roles to
 * capabilities via the mesh's vocabulary before comparing — roles describe
 * people, capabilities are what code checks, so renaming a role touches no
 * `.access` entry at all.
 *
 * DELIBERATELY NOT A FilesApi. The tree is a plain map, so this file needs
 * no disk, no network and no async I/O, and its tests run in milliseconds.
 * Loading a tree FROM real `.access` files is a separate concern and a
 * separate prototype — one that must establish that a malformed policy
 * file fails CLOSED. Nothing here tests that.
 */

import { lookupClaims } from "./peer-context.js";
import type { FetchHandler, MeshClaims, UsesTransportIdentity } from "./types.js";
import { json } from "./types.js";
import { assertValid, expandRoles, validateVocabulary } from "./vocabulary.js";
import type { Vocabulary } from "./vocabulary.js";

export interface AccessEntry {
  /**
   * Any one of these CAPABILITIES suffices. An empty array denies outright.
   *
   * Policy is written against capabilities, not role names: roles describe
   * people, capabilities are what code checks. Renaming a role, or
   * splitting one in two, then touches no `.access` entry at all.
   */
  anyOf?: string[];
  /** Grant without a membership token. Use sparingly; see the bootstrap paths. */
  public?: boolean;
  /** Per-method override, e.g. { GET: { anyOf: ['std:mesh.read'] }, PUT: { anyOf: ['std:mesh.admin'] } }. */
  methods?: Record<string, Omit<AccessEntry, "methods">>;
}

/** Directory path (always ending in `/`, always starting at `/`) → entry. */
export type AccessTree = Record<string, AccessEntry>;

export interface Decision {
  allowed: boolean;
  /** Which directory supplied the governing entry; null when nothing did. */
  source: string | null;
  reason: string;
}

/** Every directory prefix of `pathname`, shallowest first: / , /a/ , /a/b/ … */
export function ancestors(pathname: string): string[] {
  const out = ["/"];
  const parts = pathname.split("/").filter(Boolean);
  // The final segment is the resource, not a directory — drop it.
  let acc = "";
  for (const p of parts.slice(0, -1)) {
    acc += `/${p}`;
    out.push(`${acc}/`);
  }
  return out;
}

/**
 * Returns WHICH directory governed and WHY, not just a boolean. That is
 * what makes a policy debuggable by someone who did not write it, and it
 * costs nothing.
 */
export function resolveAccess(
  tree: AccessTree,
  pathname: string,
  method: string,
  claims: MeshClaims | null,
  vocab: Vocabulary,
): Decision {
  let governing: AccessEntry | null = null;
  let source: string | null = null;

  // Deeper overrides shallower: last one wins.
  for (const dir of ancestors(pathname)) {
    const entry = tree[dir];
    if (entry != null) {
      governing = entry;
      source = dir;
    }
  }

  if (governing == null) {
    return { allowed: false, source: null, reason: "no .access entry governs this path" };
  }

  // A per-method override replaces the directory entry wholesale.
  const effective = governing.methods?.[method] ?? governing;

  if (effective.public === true) {
    return { allowed: true, source, reason: "public" };
  }

  if (claims == null) {
    return { allowed: false, source, reason: "membership token required" };
  }

  const anyOf = effective.anyOf ?? [];
  if (anyOf.length === 0) {
    return { allowed: false, source, reason: "denied by policy" };
  }

  // The caller's ROLES expand to CAPABILITIES; policy checks capabilities.
  const held = expandRoles(vocab, claims.roles);
  const granted = anyOf.find((c) => held.has(c));
  return granted !== undefined
    ? { allowed: true, source, reason: `granted by capability '${granted}'` }
    : { allowed: false, source, reason: `requires one of: ${anyOf.join(", ")}` };
}

/**
 * Structural problems with a policy tree, given a vocabulary: every
 * capability named in `anyOf` (directory-level or under a method override)
 * must be declared. Catches, in particular, a ROLE name written where a
 * capability belongs — the exact mistake the pre-vocabulary design invited.
 */
export function validateAccessTree(vocab: Vocabulary, tree: AccessTree): string[] {
  const problems: string[] = [];

  const checkCapabilities = (dir: string, entry: Omit<AccessEntry, "methods">, method?: string): void => {
    for (const cap of entry.anyOf ?? []) {
      if (!(cap in vocab.capabilities)) {
        const where = method != null ? `${dir} [${method}]` : dir;
        problems.push(`${where}: undeclared capability '${cap}'`);
      }
    }
  };

  for (const [dir, entry] of Object.entries(tree)) {
    checkCapabilities(dir, entry);
    for (const [method, override] of Object.entries(entry.methods ?? {})) {
      checkCapabilities(dir, override, method);
    }
  }

  return problems;
}

export interface AccessTreeInit {
  tree: AccessTree;
  /**
   * Required, not defaulted: a caller who forgets to pass a vocabulary must
   * see a compile error, not silently get `DEFAULT_VOCABULARY` applied to a
   * policy written against a different one. A default here would fail
   * closed only when the wrong vocabulary happens to lack a capability the
   * policy names — the same class of silent misconfiguration this whole
   * module exists to refuse.
   */
  vocabulary: Vocabulary;
  usesTransportIdentity: UsesTransportIdentity;
}

/**
 * Drop-in replacement for the removed withAccessPolicy, backed by a walked
 * tree.
 *
 * FAIL FAST, NOT CLOSED. Validates the vocabulary and the policy against it
 * at construction, throwing `VocabularyError` with every problem found, not
 * just the first — a policy that denies everyone through a typo is
 * indistinguishable at runtime from one that works, so refusing to start is
 * the better failure.
 */
export function withAccessTree(init: AccessTreeInit) {
  const { vocabulary: vocab } = init;
  assertValid([...validateVocabulary(vocab), ...validateAccessTree(vocab, init.tree)]);

  return (next: FetchHandler): FetchHandler =>
    async (req) => {
      if (await init.usesTransportIdentity(req)) return next(req);

      const { pathname } = new URL(req.url);
      const claims = (lookupClaims(req) ?? null) as MeshClaims | null;
      const decision = resolveAccess(init.tree, pathname, req.method, claims, vocab);

      if (!decision.allowed) {
        const status = claims == null && decision.reason.includes("token") ? 401 : 403;
        return json({ error: decision.reason }, status);
      }
      return next(req);
    };
}

/**
 * The default mesh policy, expressed as a tree. Decision-for-decision
 * equivalent to the DEFAULT_ACCESS_RULES array it replaced — see the
 * equivalence table in access-tree.test.ts.
 *
 * Capability names here come from `DEFAULT_VOCABULARY` in vocabulary.ts.
 */
export const DEFAULT_ACCESS_TREE: AccessTree = {
  "/": { anyOf: [] }, // deny by default
  "/.well-known/": { anyOf: ["std:mesh.read"] },
  "/test/": { anyOf: ["std:test"] },
  "/admin/": { anyOf: ["std:mesh.admin"] },
};
