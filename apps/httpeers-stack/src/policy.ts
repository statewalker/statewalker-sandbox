/**
 * This stack's own rules and policies, in Datalog — Task 8, ported to
 * ADR-0019.
 *
 * `httpeers.core`'s `DEFAULT_RULES` is the LIBRARY's default, generic enough
 * to exercise `createPeer` with no application behind it at all
 * (`std:mesh.read`, `std:presence.write`, `std:test`). This is different: it
 * is the policy of the actual application `httpeers-stack` builds — the design
 * record's own §8 (see
 * `docs/superpowers/specs/2026-08-18-httpeers-stack-design.md`) names it
 * exactly this way, with exactly these two roles. `hub/main.ts`'s production
 * peer is wired against THIS module, not the library defaults; the
 * archived/promoted E2E suites (`tests/support/mesh.ts`, `tests/hub.test.ts`)
 * intentionally keep using `DEFAULT_RULES` unchanged — this module has no
 * effect on them.
 *
 * WHAT ADR-0019 CHANGED HERE. This file used to hold two values: a
 * `Vocabulary` (roles, capabilities, and a transitive `implies`) and an
 * `AccessTree` (a walked map of directory entries with per-method overrides).
 * They are one value now. The vocabulary is not lost in that move; it stops
 * being a separate structure and becomes what it always described — rules
 * deriving capabilities from roles. `implies` disappears as a FEATURE because
 * transitivity is what a rule does: `role("member") <- role("admin")` and
 * `capability("std:mesh.admin") <- role("admin")` are the same mechanism.
 *
 * POLICY NAMES CAPABILITIES, NEVER ROLES (P7). `std:` stays reserved for the
 * mesh protocol itself (`std:mesh.admin`); this application's own capabilities
 * take the `app:` prefix.
 *
 * `hidden` is carried over unchanged (derives `member`, confers nothing of its
 * own) — `mesh-view.ts`'s `buildMeshView` already consumes it (M-1, Task 7a)
 * and nothing about ADR-0019 changes that feature; dropping the role here
 * would make it un-grantable, since `roleNames()` now reads the role registry
 * off these very rules and both `MemberStore.setRoles` and
 * `InvitationStore.create` validate against it.
 *
 * WHY `/.well-known/mesh` (AND EVERY OTHER ORDINARY `/.well-known/*` READ) IS
 * GATED BY `app:search.query`, NOT A SEPARATE "READ THE MESH" CAPABILITY:
 * these rules derive exactly two application capabilities for `member`
 * (`app:search.query`, `app:images.read` — the design record's own choice, §8).
 * There is no third "ordinary member" capability to reuse, and inventing one
 * only to gate diagnostic/registry reads that every member should see anyway
 * would multiply capabilities without adding a real distinction.
 * `app:search.query` already means "an ordinary, unrevoked member of this
 * mesh" for every member (search is the mesh's first and, so far, only real
 * service), so it does that job for the `.well-known` surface and `/test/*`
 * too.
 *
 * A PATH GOVERNS ITSELF AND ITS SUBTREE, AND NOTHING ELSE. The tree said that
 * with one key; Datalog says it with an `or` variant, because
 * `$r.starts_with("/test")` alone would also match `/testing`, which the tree
 * never did. Every policy below is written that way — see `rules.ts`'s module
 * comment in `httpeers.core`.
 */
import type { RuleSet } from "@statewalker/httpeers.core";
import { ruleSet } from "@statewalker/httpeers.core";

/**
 * The vocabulary, as rules: what each role of THIS application derives.
 *
 * Exported as raw Datalog rather than as a built `RuleSet` because every peer
 * in this mesh must share this derivation while holding its own policies — the
 * hub, the image provider and the browser app all serve different resources,
 * and all of them verify tokens minted by `hub/main.ts` against these roles.
 * `appRules()` below is how a peer combines the two, and taking only the
 * policies from a caller is what keeps the derivation from being substitutable
 * (the fail-open the old paired `accessTree`/`vocabulary` check existed to
 * rule out).
 */
export const APP_RULES: readonly string[] = [
  'capability("app:search.query") <- role("member");',
  'capability("app:images.read")  <- role("member");',
  'capability("app:proxy.use")    <- role("member");',
  'capability("std:mesh.admin")   <- role("admin");',
  // Implication. Transitive for free, because that is what a rule does.
  'role("member") <- role("admin");',
  'role("member") <- role("hidden");',
];

/**
 * Build a rule set for one peer of THIS mesh: its own policies, always over
 * this application's own derivation.
 *
 * Throws `RuleSetError` listing every problem — a policy naming a capability
 * no rule derives, a predicate nothing supplies, Datalog that does not parse.
 * Refusing to start beats denying every request forever with no error
 * anywhere.
 */
export function appRules(policies: readonly string[], version = 1): RuleSet {
  return ruleSet({ version, rules: APP_RULES, policies });
}

/**
 * The hub's own policy.
 *
 * The two bootstrap paths are ALSO redundant in practice:
 * `usesTransportIdentity()` (`hub/endpoints.ts`) bypasses policy entirely for
 * `POST /.well-known/invite` and `POST /.well-known/presence` before the
 * authorizer ever runs. They are kept anyway as this file's own honest,
 * self-contained documentation of bootstrap's intent — a reader of this file
 * alone, with no memory of `usesTransportIdentity`, should not conclude those
 * two routes are ordinarily gated.
 */
export const HUB_RULES: RuleSet = appRules([
  // Bootstrap: no token exists yet.
  'allow if resource("/.well-known/invite");',
  'allow if resource("/.well-known/presence"), operation("POST");',
  // Every ordinary `.well-known` read, `/test/*` and `/search`.
  'allow if capability("app:search.query"), resource("/.well-known")' +
    ' or capability("app:search.query"), resource($r), $r.starts_with("/.well-known/");',
  'allow if capability("app:search.query"), resource("/test")' +
    ' or capability("app:search.query"), resource($r), $r.starts_with("/test/");',
  'allow if capability("app:search.query"), resource("/search")' +
    ' or capability("app:search.query"), resource($r), $r.starts_with("/search/");',
  'allow if capability("std:mesh.admin"), resource("/admin")' +
    ' or capability("std:mesh.admin"), resource($r), $r.starts_with("/admin/");',
]);

/** A peer that serves nothing: no policy, so deny by default answers everything. */
export const SERVES_NOTHING: RuleSet = appRules([]);
