/**
 * A-1: `.access` as a walked tree, not a rules array.
 *
 * The design has said since the beginning that policy lives in `.access`
 * files resolved root to leaf with deny-by-default. Resolution rules:
 *  - ONE SEMANTIC: A KEY GOVERNS ITS OWN PATH *AND* ITS SUBTREE. Walk every
 *    prefix of the request path, shallowest first — `/`, `/a`, `/a/b`, …,
 *    down to the full path itself — and take the DEEPEST prefix that has an
 *    entry. `/x` and `/x/` are the same key (a trailing slash is stripped
 *    before lookup, except for root `/` itself), so a policy author writes
 *    ONE entry for "this resource and everything under it," not two that
 *    might silently diverge. `{ "/": deny, "/images": grant }` therefore
 *    governs `GET /images` (the collection) AND `GET /images/{id}` (a
 *    member) from the same single entry — no separate directory key needed.
 *  - THIS WAS NOT ALWAYS TRUE, AND GETTING IT WRONG COST TASK 12 REAL TIME
 *    (see PROVENANCE.md). An earlier version of this resolver treated `/x`
 *    (no trailing slash) as an EXACT-ONLY match and `/x/` (trailing slash)
 *    as the ONLY way to govern anything nested under `x` — two distinct
 *    keys, and `withAccessTree` refused a tree declaring both, "ambiguous,
 *    pick one." That refusal was correct in spirit (silent divergence
 *    between two spellings of "the same policy" is a real risk) but wrong
 *    in effect: `/x` and `/x/` are not two spellings of the SAME scope
 *    under the old semantic, they are two DIFFERENT scopes (the resource
 *    itself vs. everything strictly inside it), and a policy author who
 *    needed both — "gate the collection AND every member the same way" —
 *    had no way to write that at all. A fixture-backed image service found
 *    this directly: `{ "/": deny, "/images": grant }` granted `GET /images`
 *    but silently denied every `GET /images/{id}`, with no error at
 *    construction or request time to say so. See `access-tree.test.ts`'s
 *    "a key governs both its own path and every path beneath it".
 *  - THE DUPLICATE-KEY REJECTION SURVIVES, AND IS NOW HONEST. Canonicalizing
 *    `/x`/`/x/` to one key means declaring BOTH in the same tree is a
 *    genuine duplicate of one scope (two conflicting entries for the same
 *    thing), not a forced choice between two scopes that were never
 *    actually the same. `withAccessTree` still refuses this at
 *    construction — fail fast, not fail closed — but the refusal no longer
 *    forecloses an author's actual intent.
 *  - A DEEPER ENTRY STILL OVERRIDES A SHALLOWER ONE, including the resource's
 *    own exact path over an ancestor's: `/admin/`: grant, `/admin/secret`:
 *    deny still denies `/admin/secret` specifically while `/admin/anything-
 *    else` stays granted — see "an exact-leaf deny overrides a granting
 *    ancestor" below, unchanged by this fix.
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
import type { Vocabulary } from "./vocabulary.js";
import { assertValid, expandRoles, validateVocabulary } from "./vocabulary.js";

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

/**
 * Every directory prefix of `pathname`, shallowest first: / , /a/ , /a/b/ …
 * -- the resource's OWN final segment is deliberately excluded (dropped as
 * "the resource, not a directory"). Used by `resolveAccess` below as the
 * first half of its full prefix walk; kept as its own exported, separately
 * tested function because it predates (and is reused by) that walk, and a
 * caller debugging a policy benefits from being able to ask "what are this
 * path's ancestor directories" without also pulling in canonicalization.
 */
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

/** Strips exactly one trailing slash, except for root itself (`/` stays `/`). The canonical spelling every tree key is compared against. */
function canonicalPath(path: string): string {
  if (path === "/") return "/";
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * Looks up `canonicalKey` in `tree`, trying BOTH spellings a policy author
 * might have used (`/images` or `/images/`) since `/x`/`/x/` canonicalize to
 * the same key — see the module comment. Returns the entry AND the actual
 * key the tree used, so `resolveAccess`'s reported `source` reflects what a
 * reader of the tree would recognize, not a synthesized canonical string
 * that might not appear in the tree at all.
 */
function lookupCanonical(
  tree: AccessTree,
  canonicalKey: string,
): { entry: AccessEntry; key: string } | undefined {
  if (canonicalKey === "/") {
    const entry = tree["/"];
    return entry != null ? { entry, key: "/" } : undefined;
  }
  if (tree[canonicalKey] != null) return { entry: tree[canonicalKey]!, key: canonicalKey };
  const withSlash = `${canonicalKey}/`;
  if (tree[withSlash] != null) return { entry: tree[withSlash]!, key: withSlash };
  return undefined;
}

/**
 * Returns WHICH entry governed and WHY, not just a boolean. That is
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

  // Every prefix of the request path, shallowest first, ending with the
  // resource itself: `ancestors()` gives every proper ancestor DIRECTORY
  // (ending in `/`), canonicalized here to strip that trailing slash; the
  // resource's own canonical path is appended last, so it is checked last
  // and — deeper overrides shallower, same rule as always — wins over
  // whatever a shallower prefix granted or denied. This is what makes a key
  // govern BOTH its own path and its subtree in one walk: a match found at
  // a shallow prefix keeps governing every deeper prefix that has no entry
  // of its own, all the way down to the resource itself.
  const chain = [...ancestors(pathname).map(canonicalPath), canonicalPath(pathname)];

  for (const key of chain) {
    const found = lookupCanonical(tree, key);
    if (found != null) {
      governing = found.entry;
      source = found.key;
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
 *
 * Also catches a tree that declares both `/x` and `/x/` — as of the module
 * comment's "ONE SEMANTIC" fix, these are the SAME canonical key (both
 * govern resource `x` AND its subtree), so declaring both is a genuine
 * duplicate of one scope with two conflicting entries, not a forced choice
 * between two different scopes. Silently letting both live would mean
 * whichever object-key iteration happens to run last silently wins — this
 * module refuses to start rather than resolve that at request time.
 */
export function validateAccessTree(vocab: Vocabulary, tree: AccessTree): string[] {
  const problems: string[] = [];

  const checkCapabilities = (
    dir: string,
    entry: Omit<AccessEntry, "methods">,
    method?: string,
  ): void => {
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

  const seen = new Set<string>();
  for (const key of Object.keys(tree)) {
    // "/" has no bare counterpart (stripping its trailing slash leaves ""),
    // and is not itself a directory nested under anything -- exempt.
    if (key === "/" || !key.endsWith("/")) continue;
    const bare = key.slice(0, -1);
    if (bare in tree && !seen.has(bare)) {
      seen.add(bare);
      problems.push(`both '${bare}' and '${key}' are declared -- ambiguous: pick one`);
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
