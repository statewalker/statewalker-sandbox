/**
 * This stack's own vocabulary and `.access` tree — Task 8.
 *
 * `httpeers.core`'s `DEFAULT_VOCABULARY`/`DEFAULT_ACCESS_TREE` are the
 * LIBRARY's defaults, generic enough to exercise `createPeer` with no
 * application behind it at all (`std:mesh.read`, `std:presence.write`,
 * `std:test`). This is different: it is the vocabulary of the actual
 * application `httpeers-stack` builds — the design record's own §8 (see
 * `docs/superpowers/specs/2026-08-18-httpeers-stack-design.md`) names it
 * exactly this way, with exactly these two roles. `hub/main.ts`'s
 * production peer is wired against THIS module, not the library defaults;
 * the archived/promoted E2E suites (`tests/support/mesh.ts`,
 * `tests/hub.test.ts`) intentionally keep using `DEFAULT_VOCABULARY`/
 * `DEFAULT_ACCESS_TREE` unchanged — this module has no effect on them.
 *
 * POLICY NAMES CAPABILITIES, NEVER ROLES (A-3). `std:` stays reserved for
 * the mesh protocol itself (`std:mesh.admin`, from `DEFAULT_VOCABULARY`);
 * this application's own capabilities take the `app:` prefix, per the
 * design record and the module comment in `httpeers.core`'s `vocabulary.ts`.
 *
 * `hidden` is carried over from `DEFAULT_VOCABULARY` unchanged (implies
 * `member`, confers nothing of its own) — `mesh-view.ts`'s `buildMeshView`
 * already consumes it (M-1, Task 7a) and nothing about this task changes
 * that feature; dropping the role here would make it un-grantable (`
 * MemberStore.setRoles`/`InvitationStore.create` both validate role names
 * against the vocabulary in use) for no reason connected to this task.
 *
 * WHY `/.well-known/mesh` (AND EVERY OTHER ORDINARY `/.well-known/*` READ)
 * IS GATED BY `app:search.query`, NOT A SEPARATE "READ THE MESH"
 * CAPABILITY: this vocabulary declares exactly two application capabilities
 * for `member` (`app:search.query`, `app:images.read` — the design record's
 * own choice, §8). There is no third "ordinary member" capability to reuse,
 * and inventing one only to gate diagnostic/registry reads that every
 * member should see anyway would multiply capabilities without adding a
 * real distinction. `app:search.query` already means "an ordinary,
 * unrevoked member of this mesh" for every member (search is the mesh's
 * first and, so far, only real service), so it does that job for the
 * `.well-known` surface and `/test/*` too.
 */
import type { AccessTree, Vocabulary } from "@statewalker/httpeers.core";
import { DEFAULT_VOCABULARY } from "@statewalker/httpeers.core";

/** This application's own capabilities. `std:mesh.admin` is `httpeers.core`'s — reused, not redeclared. */
export const VOCABULARY: Vocabulary = {
  version: 1,
  capabilities: {
    "app:search.query": { description: "query the hub's search service" },
    "app:images.read": { description: "read a provider's advertised images" },
    "std:mesh.admin": DEFAULT_VOCABULARY.capabilities["std:mesh.admin"]!,
  },
  roles: {
    member: {
      description: "an ordinary peer of the mesh",
      capabilities: ["app:search.query", "app:images.read"],
    },
    admin: {
      description: "may change who is in the mesh",
      implies: ["member"],
      capabilities: ["std:mesh.admin"],
    },
    hidden: DEFAULT_VOCABULARY.roles.hidden!,
  },
};

/**
 * The hub's `.access` tree.
 *
 * `"/.well-known/"` is the directory-level default every ordinary
 * `.well-known` read falls back to; `"/.well-known/mesh"` (and the other
 * two leaf entries below) are written out explicitly anyway, matching the
 * design record's own snippet, even though — for `/mesh` — the leaf grants
 * nothing the directory default does not already grant. The two bootstrap
 * paths' `public`/method-override entries are ALSO redundant in practice:
 * `usesTransportIdentity()` (`hub/endpoints.ts`) already bypasses the
 * access tree entirely for `POST /.well-known/invite` and
 * `POST /.well-known/presence` before `resolveAccess` ever runs. They are
 * kept anyway as the tree's own honest, self-contained documentation of
 * bootstrap's intent — a reader of this file alone, with no memory of
 * `usesTransportIdentity`, should not conclude those two routes are
 * ordinarily gated.
 *
 * `"/search"` is a bare, one-segment top-level resource — the case that
 * exposed `resolveAccess`'s exact-path fix (see `httpeers.core`'s
 * `PROVENANCE.md`, "Task 8 (pre-work)"). It needs no trailing slash: it
 * governs the resource itself, not a directory beneath it.
 */
export const HUB_ACCESS: AccessTree = {
  "/": { anyOf: [] }, // deny by default
  "/.well-known/": { anyOf: ["app:search.query"] },
  "/.well-known/invite": { public: true },
  "/.well-known/presence": { anyOf: ["app:search.query"], methods: { POST: { public: true } } },
  "/.well-known/mesh": { anyOf: ["app:search.query"] },
  "/test/": { anyOf: ["app:search.query"] },
  "/search": { anyOf: ["app:search.query"] },
  "/admin/": { anyOf: ["std:mesh.admin"] },
};
