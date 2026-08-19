# Provenance

This package is written fresh, not reconstructed from a lost tree. `task-1-brief.md`
was drafted as if against a `v0.9.0` prototype tree with a numbered `folder 12` and a
run ledger of numbered notes (`note 05`, `note 07`, `note 09`, `note 34`). Neither
exists in this checkout: `apps/httpeers-protos/` has only nine demo folders (`01`
through `09`), and no `note NN` files exist anywhere in the repo. This file is the
reconciliation map the brief asked for, recording what was actually used in place of
those references, in case the real `v0.9.0` tree resurfaces later and needs to be
diffed against this one.

The team lead's task message resolved every place the brief pointed at missing
material — those resolutions are cited below as "ledger" decisions.

| File | Actual basis | Note reference in brief | How resolved |
| --- | --- | --- | --- |
| `src/types.ts` | Written fresh. `MeshClaims` is field-compatible with `Claims` in `apps/httpeers-protos/lib/revocation.ts` (`sub`, `mesh`, `roles`, `iat`, `exp`), with `iss` added. | note 34 §3 (`iat`); note 07 §5.1 (`ANONYMOUS`) | Ledger decision R4: add `iss`, `mesh` becomes the hub's peerId. `ANONYMOUS` designed per the team lead's explicit spec (unique symbol, doc comment, unconsumed in Task 1). |
| `src/tokens.ts` | Written fresh. No `folder 12/src/tokens.ts` exists to reconstruct from. | note 05 §4 (verification chain), note 05 §2 (RSA/no-fetch reasoning) | Ledger decision R9: no `jose` dependency; hand-rolled compact JWS over `@libp2p/crypto`'s Ed25519 primitives and `@libp2p/peer-id` for peerId↔key recovery. Verification chain implemented exactly as summarized by the team lead: recover issuer key from peerId (Ed25519 only) → verify signature → verify expiry → assert `claims.mesh === policy.issuer`. `typ`/`alg` are checked per the team lead's ambiguity resolution #2. |
| `src/store.ts` | Written fresh. No `folder 12/src/store.ts` exists to reconstruct from. Presence's monotonic-write requirement is analogous in spirit to `revocation.ts`'s `iat`-vs-`changedAt` comparison, but presence and revocation are different concerns — the revocation change-list itself is explicitly out of scope for this task (a later task promotes it from `Hub`/`RevocationCache`). | note 09 §7 (monotonic presence) | Ledger decisions: three registries (members durable, presence TTL'd+swept, advertisements a non-expiring bulletin board), all with an injected `clock: () => number`. Presence writes keyed by a caller-supplied per-peer sequence number; a write is accepted only if `seq` is strictly greater than the peer's last accepted `seq` — never wall-clock across peers. |
| `tests/tokens.test.ts` | Written fresh, covering exactly the six required cases plus one incidental (`typ` mismatch) surfaced while implementing ambiguity resolution #2. | — | The RSA-peerId-as-issuer test follows the team lead's fallback explicitly: it asserts on a peerId built from a `sha2-256` multihash (not `identity`) rather than generating a real RSA key, per ambiguity resolution #1. |
| `tests/store.test.ts` | Written fresh. | note 09 §7 | Explicit tests for: replay of the same `seq`, an older `seq` after a newer one, no cross-peer sequence coupling, and "a delayed retry cannot resurrect a peer that has since left." |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `tsdown.config.ts` | Copied in shape from `workspaces/statewalker-sandbox/packages/service-http/` (same script names, `exports` shape, `private: true`, `type: module`). | — | Package named `@statewalker/httpeers.core`. `@libp2p/crypto` (`5.1.22`), `@libp2p/peer-id` (`6.0.14`), and `@libp2p/interface` (`3.2.5`, used only for type imports, pinned to the version those two packages themselves depend on) are pinned exact per ledger decision R9 — no carets, not `catalog:`. Tooling deps (`vitest`, `typescript`, `@types/node`, `tsx`, `rimraf`, `tsdown`) are `catalog:`. `multiformats` (`14.0.5`, pinned exact, matching what `@libp2p/peer-id@6.0.14` itself resolves to) is a test-only `devDependency`, used solely in `tests/tokens.test.ts` to construct a synthetic sha2-256 (RSA-shaped) peerId — it is not imported from `src/`. |

## Design notes not in the brief

- **`iss` vs `mesh`.** Both are minted with the same value (the hub's own peerId) in
  this single-hub-per-mesh reference deployment. They are kept as two fields because
  a later, federated or key-rotating mesh may need "who signed this token" (`iss`) to
  differ from "which mesh this grants membership in" (`mesh`) — but Task 1 does not
  build that scenario, it only leaves the seam open.
- **`mintToken` never takes `mesh` as an argument.** It is always derived from the
  signing `privateKey`'s own peerId, so a correctly-implemented hub cannot mint a
  token that fails its own self-certification check. The "rejects `claims.mesh !==
  issuer`" test therefore has to construct its scenario by minting a normal token and
  then verifying it against a *different* expected issuer — not by trying to mint a
  self-inconsistent token, which the API does not allow.
- **No revocation logic here.** `apps/httpeers-protos/lib/revocation.ts`'s `Hub`
  class (change-list, `policyVersion`) and `RevocationCache` are explicitly out of
  scope — the team lead's brief said a later task promotes only that logic. `store.ts`
  contains none of it.

## Task 2 — the router

Unlike Task 1, the source material for Task 2 actually exists in this checkout, at
the umbrella root (not inside this submodule):
`notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/`. This is genuine
promotion, not reconstruction from a missing tree.

| File | Actual basis | How resolved |
| --- | --- | --- |
| `src/router.ts` | Promoted from `31-httpeers-prototype-v0.6.0-router-hardened/router.ts`, with `createMounts()`'s matching rewritten to normalise a trailing slash (see below) and prose converted to house style (double quotes, semicolons, `import type`). Logic is otherwise unchanged: `looksLikePeerId`, the self-prefix strip + `copyPeerBinding`, the `allowForward` deny-by-default gate, and the longest-prefix mount table are all byte-for-byte the same algorithm as the archive. | Team lead's ruling (this task's dispatch message): normalise the trailing-slash trap instead of leaving it documented, following the `norm()` approach in `apps/httpeers-protos/lib/router.ts` (read for the technique only, not promoted — its own README disclaims it as a substitute for the original 135-test tree). |
| `src/peer-context.ts` | Promoted from `12-httpeers-prototype-validated/src/peer-context.ts` in full: `registerPeer`, `registerAnonymous`, `lookupPeer`, `copyPeerBinding`, `cacheClaims`, `lookupClaims`. Logic unchanged; only formatting and doc comments differ (the archive file had no comments at all — house style in this package documents the "why", so doc comments were added explaining the WeakMap-over-second-parameter design and the re-creation problem `copyPeerBinding` solves). | Team lead's dispatch message: "Promote all of it… you are only landing the carriage" — the binding middleware that consumes this is Task 3. |
| `src/types.ts` additions | `PeerIdStr`, `Anonymous`, `ProvenPeer`, `Remote`, `Mounts`, `json()` taken from `12-httpeers-prototype-validated/src/types.ts`, added alongside Task 1's existing `MeshClaims`/`ANONYMOUS`/store interfaces (untouched). `ProvenPeer` is defined as `PeerIdStr \| Anonymous` per the team lead's message, using Task 1's own `ANONYMOUS`/`Anonymous` rather than redeclaring a second sentinel. | Team lead's dispatch message, explicit type list. |
| `tests/mounts.test.ts` | Promoted from `31-httpeers-prototype-v0.6.0-router-hardened/mounts.test.ts`. The archive's own README/CHANGES call it "sixteen tests"; the file as written actually contains **17** `it(...)` cases (9 in `R-1: mount matching`, 8 in `R-1: peer-prefix routing`) — the archive's prose undercounts its own file by one. All 17 are promoted; 16 unchanged, 1 rewritten (see next row). | Team lead's dispatch message: "promote the other 15 cases unchanged" (the message's own count, off by one from the actual 16 unchanged + 1 rewritten = 17 total; called out here rather than silently reconciled). |
| `tests/mounts.test.ts` — one rewritten case | The archived case `"a trailing-slash mount does NOT match the bare prefix"` asserted `hit(['/api/'], '/api')` is `null` (the TRAP the archive's own header comment flagged and left unresolved). Rewritten as `"a trailing-slash mount is normalised — /api/ and /api are the same mount"`, asserting all three of `/api/x`, `/api/`, and `/api` now resolve to the same mount. This is the **only** promoted-test edit in this task. | Team lead's explicit ruling: normalise, and rewrite this one case to match — "altering promoted tests is otherwise forbidden," called out per the dispatch message's instruction. |
| `tests/router.test.ts` | **Not a promotion — written fresh for this task.** `chain.test.ts` (the archive's R-2 integration suite, C1–C7/C5b, real libp2p peers via `createPeer`) is explicitly out of scope (Task 6). This file instead pins the property Step 3 of the brief asks for at the unit level: a denied forward returns 403 **and never invokes `remote`** (asserted on a `vi.fn()` spy, not just the status code), plus small local-dispatch coverage (404, the `access` wrapper applying to local traffic only) not covered by `mounts.test.ts`. Loosely informed by `12-httpeers-prototype-validated/src/router.ts`'s companion `router.test.ts` (read for contrast, not promoted — no test bodies copied) for which basic cases were worth keeping in scope. | Team lead's dispatch message, "The trailing-slash decision" section and "What is NOT in this task": stubbed `remote`, assert the stub was never called. |
| `tsconfig.tests.json` (new), `package.json` `typecheck:tests` script | Fixes the inherited bug: `typecheck:tests` ran plain `tsc`, which resolves to `tsconfig.json`'s `include: ["./src"]` — test files were never typechecked. `packages/service-http/` (the sibling this package was scaffolded from, per Task 1's provenance row) carries the identical bug and was left alone — out of scope for this task. New `tsconfig.tests.json` extends the base config and adds `"./tests"` to `include`; the script now runs `tsc -p tsconfig.tests.json --noEmit`. Confirmed both `typecheck` (src-only) and `typecheck:tests` (src+tests) pass clean, with zero pre-existing Task 1 type errors surfaced. | Team lead's dispatch message, "One additional fix, unrelated to the router." |

### Design notes not in the dispatch message

- **The `libp2p` grep constraint, read literally vs. in substance.** `grep -l libp2p
  src/router.ts src/peer-context.ts src/types.ts` still matches `src/types.ts`:
  two prose comments from **Task 1** (`"A libp2p `fetch` handler…"` and a
  "pulling in libp2p" mention) describe the module's audience, not an import.
  There is no `import` statement referencing `libp2p` or any `@libp2p/*` package
  in any of the three files — confirmed with `grep -n "^import"`. Task 2's own two
  new doc-comment mentions of "libp2p" (in `router.ts`'s header and
  `peer-context.ts`'s WeakMap rationale) were reworded to "a transport" / "a
  transport's `fetch` handler" specifically so Task 2 does not add new literal
  matches; the one remaining match is pre-existing Task 1 prose, left untouched
  as out of this task's scope.
- **`createMounts()`'s normalisation, and why `provide()` wasn't given an
  additive `provide` top-level export alias.** The dispatch message allowed but
  did not require a top-level `provide` alias for the plan's prose name; since
  the promoted test imports `createMounts` and passes unmodified, no alias was
  added.
- **The router's own `allowForward` default stays `async () => false`,
  unconditionally** — not the ANONYMOUS-vs-proven-peer policy described in
  `task-2-brief.md`'s "Step 2" prose. That policy (forward if the origin is
  `ANONYMOUS`, refuse a proven peer unless it is a relay) is the **caller-supplied**
  policy documented in the archive's own `router.ts` header comment and spelled
  out in `CHANGES-v0.6.0.txt` as something `peer.ts` wires in — and `peer.ts`
  does not exist yet (Task 6). Baking that policy into the router's built-in
  default would couple the pure core to one specific policy the brief itself
  says is supplied by the caller. `router.test.ts`'s new tests exercise the
  router's actual default (unconditional deny) plus an explicitly supplied
  `allowForward`, not the ANONYMOUS-aware policy — that belongs with `peer.ts`.

## Task 3 — the binding middleware

Source material for Task 3 exists at the umbrella root, same location as Task 2's:
`notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/`. Two candidate
`peer-handlers.ts` files exist there; the team lead's dispatch message identified
which one to promote and why (folder `33` postdates the deletion of the policy half
that folder `12` still carries).

| File | Actual basis | How resolved |
| --- | --- | --- |
| `src/peer-handlers.ts` | Promoted from `33-httpeers-prototype-v0.7.0-access-tree/peer-handlers.ts` (45 lines, binding-only), not the older `12-httpeers-prototype-validated/src/peer-handlers.ts` (84 lines, which still carries `withAccessPolicy` and a flat rules-array policy deleted after A-1 proved decision-for-decision equivalence with the walked access tree). Folder `12`'s `binding.test.ts` was read for the seven archived test bodies (all promoted, see below) since folder `33` ships no test file of its own. `isTrustedPath` renamed to `usesTransportIdentity` throughout (function, interface field, and the `IsTrustedPath` type in `types.ts`, renamed to `UsesTransportIdentity`) per the team lead's explicit instruction. The `isRevoked` seam is new — no archived `peer-handlers.ts` has it, since revocation shipped standalone in a later folder (`35-httpeers-prototype-v0.8.0-revocation`) that this task does not promote from; added per the team lead's spec as a fifth optional seam, `(claims: MeshClaims) => Promise<string | null>`, checked after the subject-match check and before `handleEndpoints`, defaulting to `async () => null` when omitted. Prose converted to house style (doc comments explaining the "why," double quotes, semicolons) — logic is otherwise the same algorithm as the archive: resolve `getPeerId`, throw `PeerBindingLostError` on `undefined`, branch on `usesTransportIdentity`, then check claims presence / ANONYMOUS / subject match on the ordinary path. | Team lead's dispatch message: promote folder `33`, not folder `12`; add `isRevoked` and the rename as the two things the archive does not have. |
| `src/types.ts` additions | `GetPeerId`, `GetClaims`, and `UsesTransportIdentity` (renamed from folder `12`'s `IsTrustedPath`) taken from `12-httpeers-prototype-validated/src/types.ts`'s shapes, added alongside Task 1/2's existing types (untouched). `GetPeerId`'s doc comment records the never-`undefined` contract and why the middleware still defends against a caller that violates it. `UsesTransportIdentity`'s doc comment records the rename rationale and the request-level (not path-level) requirement, matching the team lead's message near-verbatim since it stated the reasoning precisely. | Team lead's dispatch message, explicit type list and shapes. |
| `tests/binding.test.ts` | Promoted from `12-httpeers-prototype-validated/src/binding.test.ts`'s seven cases (matching peer+token passes; confused-deputy replay refused; ANONYMOUS-with-valid-token refused; missing token on an ordinary path refused; bootstrap path with no token admitted; bootstrap path from ANONYMOUS refused; lost binding throws), converted from the archive's `isTrustedPath`/`trusted` naming to `usesTransportIdentity`/`bootstrap`, and its `claimsFor` helper updated to include `iat` (this package's `MeshClaims` requires it; the archive's did not). Three cases added, per the team lead's message, for the two pieces the archive does not have: `isRevoked` returning a reason refuses the request and the reason reaches the JSON response body; `isRevoked` omitted from `PeerHandlersInit` entirely (not just `undefined`) still compiles and admits the request, proving the seam is genuinely optional at the type level; and a same-path, method-discriminated case (`usesTransportIdentity` keyed on `req.method`) proving the predicate is request-level, not path-level. Ten cases total (`grep -c '  it('` confirms), not the archive's seven — see "Not promoted" below for the one archived-brief case deliberately left out. | Team lead's dispatch message, required-case list. |
| `src/index.ts` | One-line addition: `export * from "./peer-handlers.js";`, alongside Task 2's existing barrel exports. | Mechanical — new module needs a barrel export like every other `src/*.ts`. |

### Not promoted, and why

- **The 84-line `12-httpeers-prototype-validated/src/peer-handlers.ts`.** Read for
  context only, per the team lead's explicit instruction. Nothing from its
  `AccessRule`/`AccessPolicyInit`/`withAccessPolicy` half came forward — that policy
  logic is superseded by the walked access tree (a later task), and folder `33`'s
  version already reflects its removal.
- **A "forged `x-httpeers-peer` header cannot override the proven peer" test.**
  The auto-extracted `task-3-brief.md` lists this as a required case, but the team
  lead's dispatch message gives an explicit ten-item list that does not include it,
  and no archived `binding.test.ts` (folder `12`, the only one that exists) contains
  it either. Nothing in `peer-handlers.ts` reads request headers — `getPeerId` is a
  fully injected seam, so there is no code path in this file for a forged header to
  reach. A test asserting header-forgery resistance belongs with whatever future
  implementation of `GetPeerId` actually parses transport state (a later task, not
  this one); adding it here would test a stub's own hardcoded return value, not this
  middleware. Followed the team lead's explicit list over the auto-extracted brief's
  stale one, per the dispatch message's own framing ("the brief is auto-extracted
  from the plan and is stale in one respect") — treating the enumerated seven-vs-ten
  case list in the dispatch message itself as the authoritative, current instruction.

### Verification

- `grep -nE "^import.*libp2p" src/peer-handlers.ts src/types.ts` — no matches.
- `pnpm run typecheck` and `pnpm run typecheck:tests` both pass clean (zero errors),
  including on the pre-existing Task 1/2 files.
- `pnpm vitest run --no-file-parallelism` — 6 test files, 60 tests, all passing;
  `tests/binding.test.ts` alone: 10 tests, all passing.
- `npx biome check` on the four touched/added files (`src/peer-handlers.ts`,
  `src/types.ts`, `src/index.ts`, `tests/binding.test.ts`) — no issues.

### Design notes not in the dispatch message

- **The `peer === undefined` check under `strict`.** `ProvenPeer` (`PeerIdStr |
  Anonymous`, i.e. `string | symbol`) has no overlap with `undefined`, so comparing
  a value statically typed `ProvenPeer` to `undefined` trips TS2367 ("this condition
  will always return false") under this package's `strict: true`. The archive's own
  `tsconfig` evidently did not hit this. Resolved by declaring the local binding as
  `const peer: ProvenPeer | undefined = await getPeerId(req);` — a legal widening
  assignment, not a cast — so the runtime defense against a contract-violating
  `GetPeerId` implementation survives strict mode without weakening the seam's
  declared type. The test file's stubs do the mirror-image widening the other way
  (`opts.peer as ProvenPeer`), matching the archive's own test technique, to let a
  test deliberately construct the contract-violating case.

## Task 4 — access tree and role vocabulary

Source material for Task 4 is the same archive as Tasks 2 and 3
(`notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/`), but this time as a
promotion **plus a documented delta**: folder `33` ships the pre-vocabulary tree,
folder `37` ships the vocabulary and a hunk-level changelog describing exactly how
the tree changes on top of folder `33`. No folder ships the already-merged
post-vocabulary `access-tree.ts` — it had to be produced by applying the delta,
not copied.

| File | Actual basis | How resolved |
| --- | --- | --- |
| `src/vocabulary.ts` | Promoted from `37-httpeers-prototype-v0.9.0-role-vocabulary/vocabulary.ts`, as-is: `CapabilityDef`, `RoleDef`, `Vocabulary`, `VocabularyError`, `expandRoles`, `validateVocabulary`, `validateRoles`, `assertValid`, `DEFAULT_VOCABULARY`. Only formatting changed to house style (double quotes, semicolons) — no logic differs from the archive. | Team lead's dispatch message: promote as-is; do not adopt the `apps/httpeers-protos/lib/vocabulary.ts` reimplementation, which additionally rejects unnamespaced role names and has no `implies` (ledger R23) — role names stay plain (`member`, `admin`); only capabilities are namespaced (`std:`, `app:`). |
| `src/access-tree.ts` | Promoted from `33-httpeers-prototype-v0.7.0-access-tree/access-tree.ts`, **then the hunk-level delta in `37-httpeers-prototype-v0.9.0-role-vocabulary/CHANGES-v0.9.0.txt` applied on top**: `resolveAccess` gained a `vocab: Vocabulary` parameter and expands `claims.roles` to capabilities via `expandRoles` before comparing against `anyOf` (`anyOf.some(r => claims.roles.includes(r))` → `expandRoles(vocab, claims.roles)` + `anyOf.find(c => held.has(c))`); a new `validateAccessTree(vocab, tree)` export was added; `withAccessTree` now validates at construction (`assertValid([...validateVocabulary(vocab), ...validateAccessTree(vocab, init.tree)])`) instead of never validating; and `DEFAULT_ACCESS_TREE` was rewritten in capabilities (`std:mesh.read`, `std:test`, `std:mesh.admin`) in place of role names. Two changes beyond the delta text, per the team lead's dispatch message: `AccessTreeInit.isTrustedPath` renamed to `usesTransportIdentity` (matching Task 3's already-renamed `UsesTransportIdentity` type — the old name does not compile against `types.ts`), and `vocabulary` added to `AccessTreeInit` as a **required** field (see "Task 4 — fix round 1" below for why an initial optional-with-default reading was corrected). | Team lead's dispatch message, "two shape facts the brief does not state"; `CHANGES-v0.9.0.txt`'s hunk-level diff. |
| `src/index.ts` | Two-line addition: `export * from "./vocabulary.js"; export * from "./access-tree.js";`, alongside the existing barrel exports. | Mechanical — new modules need barrel exports like every other `src/*.ts`. |
| `tests/vocabulary.test.ts` | Promoted from `37-httpeers-prototype-v0.9.0-role-vocabulary/vocabulary.test.ts` **as-is** (17 tests: 5 role-expansion, 5 vocabulary-validation, 3 policy-validation, 4 fail-fast). Only the `withAccessTree({ tree, isTrustedPath })` call sites were renamed to `usesTransportIdentity` to compile against the renamed type; no assertion changed. | Team lead's dispatch message: promote as-is. |
| `tests/access-tree.test.ts` | Promoted from `33-httpeers-prototype-v0.7.0-access-tree/access-tree.test.ts` (23 tests), **with exactly three tests' ad-hoc trees updated** for the capability switch — see "The three updated tests" below — plus one new describe block (5 tests, not promoted) covering `withAccessTree`'s dispatch behaviour, which no archived test file exercises. `claims()` gained an `iat` field (this package's `MeshClaims` requires it; the archive's did not, matching the same fix Task 3 already made in `binding.test.ts`). **The eleven-case equivalence table is byte-for-byte unmodified** — see "Equivalence table" below. | Team lead's dispatch message: promote, apply the delta, do not touch the equivalence table. |

### The three updated tests

Per `CHANGES-v0.9.0.txt`: "Three access-tree tests, whose ad-hoc trees named roles
where capabilities now belong." Two ad-hoc trees are shared across several `it`
blocks each; only the `it` blocks whose assertions actually depend on which
capability a claim holds needed the literal roles (`'member'`, `'admin'`) in their
tree's `anyOf` replaced with capabilities from `DEFAULT_VOCABULARY`
(`'std:mesh.read'`, held by both `member` and `admin`; `'std:mesh.admin'`, held only
by `admin`). Confirmed by hand-simulating each `it` against the unswapped literal
(`anyOf: ['member']`/`['admin']`, which `expandRoles` never produces — those strings
are role names, not declared capabilities — so every match against them would be a
silent `false`):

1. **`A-1: root-to-leaf override > a deeper entry overrides a shallower one`** — asserts
   `member` is allowed at `/docs/` and `admin` is allowed at `/docs/secret/`; both
   assertions would flip from `true` to `false` without the swap.
2. **`A-1: per-method policy > read is allowed to members, write only to admins`** —
   asserts `member` is allowed on `GET /notes/x` and `admin` is allowed on
   `PUT /notes/x`; both would flip.
3. **`A-1: per-method policy > an unlisted method falls back to the directory entry`** —
   asserts `member` is allowed on `POST /notes/x` (no method override, falls back to
   the directory-level `anyOf`); would flip.

The other `it` blocks that share these two ad-hoc trees (`reports which directory
governed the decision`; `a deeper entry can WIDEN as well as narrow`; `a method can
be denied to everyone`) either assert only `.source`, assert on `null` claims (never
reaching the `anyOf` comparison), or assert a deny that an empty `anyOf` produces
regardless of vocabulary — none of their assertions depend on the swap, so they were
left as literal strings in the shared tree object without affecting their own outcome.

### Equivalence table — confirmed unmodified

The eleven `(path, roles) → allow/deny` triples in
`A-1: equivalence with the rules array it replaces` are unchanged from the archive,
character-for-character (`cases` array, `access-tree.test.ts`). Only
`DEFAULT_ACCESS_TREE` itself (capabilities, not roles — per the delta) and the
`decide` helper (now threading `DEFAULT_VOCABULARY` through the added `vocab`
parameter of `resolveAccess`) changed; the table's inputs and expected outputs did
not. All eleven pass. This is deliberate, per the team lead's instruction: the table
is a falsification test for the port, and the archive states plainly (both
`CHANGES-v0.9.0.txt` and note 36 §4) that it needed no change at all — verified by
hand here (member holds `std:mesh.read`/`std:test` via `DEFAULT_VOCABULARY`'s
`member` role; admin holds those transitively via `implies: ['member']`, plus
`std:mesh.admin` directly) before running the suite, not discovered by trial and
error against a failing assertion.

### Not promoted, and why

- **`apps/httpeers-protos/lib/access-tree.ts`.** Read for cross-check only, per the
  team lead's instruction. It grants on `{ mesh, roles }` directly and never wired a
  vocabulary — the *earlier* shape, superseded by the walked tree this task promotes.
- **`apps/httpeers-protos/lib/vocabulary.ts`.** Read for cross-check only. It rejects
  unnamespaced role names and has no `implies` — over-applying note 36 §2's
  capability-namespacing argument to roles, which the archive being promoted
  (folder 37) deliberately does not do (ledger R23: role names are plain).
- **`store.ts` (`validateRoles` wiring in `createInvitation`/`setRoles`) and
  `endpoints.ts` (`GET /.well-known/vocabulary`, the third heartbeat version-vector
  counter) from `CHANGES-v0.9.0.txt`.** Both belong to later tasks — invitations and
  the hub do not exist yet in this package. Not implemented, not stubbed.

### Verification

- `grep -nE "^import.*libp2p" src/access-tree.ts src/vocabulary.ts tests/access-tree.test.ts tests/vocabulary.test.ts` —
  no matches; `grep -n "libp2p"` (unanchored) also finds none.
- `pnpm run typecheck` and `pnpm run typecheck:tests` both pass clean.
- `pnpm vitest run --no-file-parallelism` — 8 test files, **105** tests, all passing.
  `tests/access-tree.test.ts` alone: 28 tests (23 promoted + 5 new middleware-dispatch
  tests). `tests/vocabulary.test.ts` alone: 17 tests, all promoted.
- `npx biome check` on the four new/touched files (`src/access-tree.ts`,
  `src/vocabulary.ts`, `src/index.ts`, `tests/access-tree.test.ts`,
  `tests/vocabulary.test.ts`) — no issues.

### Design notes not in the dispatch message

- **Why `withAccessTree`'s returned handler gets fresh tests at all.** The archive
  never tests it: folder 33 predates `withAccessTree` validating anything at
  construction, and folder 37's `vocabulary.test.ts` only calls `withAccessTree` to
  assert it throws or does not throw — it never invokes the *returned* handler
  against a `Request`. Since the team lead's dispatch message specifically flagged
  that `withAccessTree` is "a middleware, not a resolver" and that its claims come
  from `lookupClaims`/`cacheClaims` rather than `getClaims`, leaving that half
  completely untested seemed like exactly the gap the message was warning against.
  The five new tests in `tests/access-tree.test.ts`'s `A-1: withAccessTree as
  middleware` block populate the claims cache directly with `cacheClaims` (never
  calling `getClaims`, matching the team lead's explicit instruction not to
  reintroduce token verification into the policy layer) and cover: the
  transport-identity bypass, an admitted request, a 403 (claims present but
  insufficient), a 401 (no claims cached for a path that requires them), and a
  public path admitted with nothing cached.
- **`AccessTreeInit.vocabulary` was originally optional; corrected to required in
  the "Task 4 — fix round 1" section below.** The reasoning that led here at
  first: the brief's "Interfaces" section writes
  `withAccessTree({ tree, vocabulary, usesTransportIdentity })` without marking
  `vocabulary` optional, but every one of folder 37's promoted
  `vocabulary.test.ts` construction calls omits it, so a required field would
  make "promote as-is" a type error. Making it optional resolved that
  particular conflict but reopened the exact failure class this task exists to
  close (see the fix section for why, and how it was resolved instead: keep it
  required, and make the promoted calls pass `DEFAULT_VOCABULARY` explicitly —
  a call-shape change, not a logic change).
- **Grant reason text.** `resolveAccess`'s grant-path reason changed from the
  archive's `` `granted by role` `` to `` `granted by capability '${granted}'` ``
  (naming which capability matched). `CHANGES-v0.9.0.txt` only documents the
  *deny*-path message changing (`requires one of: admin` → `requires one of:
  std:mesh.admin`, which falls out for free since `anyOf` now holds capability
  strings); it says nothing about the grant-path string. No archived or promoted
  test asserts on that exact string, so this is a minor, deliberate improvement
  in the same spirit as the documented deny-message change, not a scope
  addition — flagged here in case a later task's integration test expects the
  older wording.

## Task 4 — fix round 1: `AccessTreeInit.vocabulary` made required

Review finding: `AccessTreeInit.vocabulary` was originally `vocabulary?: Vocabulary`
with `const vocab = init.vocabulary ?? DEFAULT_VOCABULARY;` inside `withAccessTree`.
That default is a silent one — a caller who forgets to pass their own vocabulary
gets no compile error, and `validateAccessTree` only catches the mistake when the
policy names a capability absent from `DEFAULT_VOCABULARY`. A policy naming only
`std:` capabilities that happen to also exist in `DEFAULT_VOCABULARY` would
construct cleanly and then be evaluated, at runtime, against the wrong
role → capability mapping — silently. That is the exact failure class A-3 exists to
refuse (a policy that is broken but looks like it works), reintroduced one layer up
by making the vocabulary itself optional.

**Fix:** `vocabulary` is now **required** on `AccessTreeInit`
(`src/access-tree.ts`); `withAccessTree` reads it directly
(`const { vocabulary: vocab } = init;`), with no `?? DEFAULT_VOCABULARY` fallback.
The now-unused `DEFAULT_VOCABULARY` import was dropped from `src/access-tree.ts`.

This is the second time a "promote `X.test.ts` as-is" instruction has had to be
qualified — the first was the typing fixes Task 4's own note above already
describes for `strict`/`noUncheckedIndexedAccess`. Both times, the archive's
*logic* was reproduced faithfully; its *call shape* was not. Concretely here: three
`withAccessTree(...)` construction calls in the promoted `tests/vocabulary.test.ts`
("A-3: fail fast, not closed") and one in the newly-written
`tests/access-tree.test.ts`'s `A-1: withAccessTree as middleware`'s `subject()`
helper now pass `vocabulary: DEFAULT_VOCABULARY` explicitly, where the archive
(and the original promotion) passed nothing. Per the team lead's boundary on this
fix, only construction-call shape changed — no assertion in either file was
touched, confirmed by diffing against the pre-fix versions:

```
$ git diff -- packages/httpeers.core/src/access-tree.ts packages/httpeers.core/tests/access-tree.test.ts packages/httpeers.core/tests/vocabulary.test.ts
```

shows only the `vocabulary?` → `vocabulary` interface field, the `init.vocabulary ??
DEFAULT_VOCABULARY` → `init.vocabulary` destructure, the dropped import, and the
four `vocabulary: DEFAULT_VOCABULARY,` lines added to construction-call object
literals — every `expect(...)` line is unchanged.

No new runtime test was added for the closed hole: once `vocabulary` is required,
the silent-wrong-default state cannot exist, and the compiler enforces that —
which is the point. Per the team lead's explicit instruction, asserting a
now-impossible state would be a test with no failure mode.

### Verification

```
$ pnpm run typecheck
> tsc --noEmit
(clean, no output)

$ pnpm run typecheck:tests
> tsc -p tsconfig.tests.json --noEmit
(clean, no output)

$ pnpm vitest run --no-file-parallelism
 Test Files  8 passed (8)
      Tests  105 passed (105)
   Duration  1.12s

$ npx biome check src/access-tree.ts tests/access-tree.test.ts tests/vocabulary.test.ts
(clean, no output)
```

Test count unchanged at 105/105 — this fix closes a hole in the type system, not a
runtime behaviour, so no test count moves. The affected tests
(`tests/vocabulary.test.ts`'s three "A-3: fail fast, not closed" cases and
`tests/access-tree.test.ts`'s five "A-1: withAccessTree as middleware" cases,
8 total) all still pass with the same assertions as before the fix.

### Two Minors deferred to final review (not touched, per team lead's instruction)

Both inherited verbatim from archive folder 33, not introduced by this task:

- `withAccessTree`'s 401-vs-403 selection substring-matches the decision reason
  (`decision.reason.includes("token")`) rather than using a typed discriminant.
- The redundant `(lookupClaims(req) ?? null) as MeshClaims | null` cast in
  `withAccessTree`.

## Task 5 — revocation as a pulled, cached deny list

Source material for Task 5 is the same archive as Tasks 2-4
(`notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/`), at
`35-httpeers-prototype-v0.8.0-revocation/`. This one is a near-clean promotion — the
team lead's dispatch message had already confirmed `RevocationCache.check()` takes a
structural `{ sub: PeerIdStr; iat: number }` type (compatible with this package's
`MeshClaims` with zero adaptation) and imports only `PeerIdStr` from `./types.js`.

| File | Actual basis | How resolved |
| --- | --- | --- |
| `src/revocation.ts` | Promoted from `35-httpeers-prototype-v0.8.0-revocation/revocation.ts` in full: `ChangeEntry`, `RevocationRegistryInit`, `RevocationRegistry` (`revoke`, `changeRoles`, `prune`, `policyVersion`, `list`), `RevocationCacheInit`, `StalenessMode`, `RevocationCache` (`update`, `knownVersion`, `staleness`, `check`). Logic is byte-for-byte the same algorithm as the archive — only formatting changed to house style (double quotes, semicolons, braces on `if`/`for` bodies) and the module header gained a paragraph explaining why `check()` stays synchronous (see "The one adaptation" below) plus a doc-comment note on `check`'s structural parameter type. | Team lead's dispatch message: promote as-is; the three properties (revocation-and-role-change-are-one-mechanism, no-clock-synchronisation, self-pruning-without-a-version-bump) are unchanged from the archive's own doc comments, only reworded slightly to fold in the synchronous-`check` rationale. |
| `src/index.ts` | One-line addition: `export * from "./revocation.js";`, alongside the existing barrel exports. | Mechanical — new module needs a barrel export like every other `src/*.ts`. |
| `tests/revocation.test.ts` | The archive's ten unit tests promoted **unchanged in assertion** (four `A-2 unit: registry` cases: role-change-to-empty-set, policy version bumps on every change, self-pruning past the token lifetime, pruning does not bump the version; six `A-2 unit: cache` cases: re-admission via a post-change `iat`, refusal of a pre-change `iat`, role-change-vs-revocation message distinction, no-entry pass-through, staleness refusal, and the never-expires-without-a-bound case named "deliberate and dangerous" in the archive's own test title). Only the cache helper's `any`/`any[]` parameter types were tightened to `ChangeEntry[]` / `{ maxStalenessMs?: number; now?: () => number }` for `noUncheckedIndexedAccess`/`strict` — a typing fix, not an assertion change. The archive's `describe('A-2 end to end', ...)` block (E1-E6) was **not promoted** — see "Not promoted, and why" below. | Team lead's dispatch message: promote `revocation.test.ts`; "Be precise about counts" — confirmed 10 (`grep -c '  it(' tests/revocation.test.ts`), not the archive's combined 16 (10 unit + 6 E2E). |

### The one adaptation: `check()` stays synchronous

The archived `RevocationCache.check()` is `(claims) => string | null` — synchronous.
The `isRevoked` seam Task 3 built on `newPeerHandlers` (`src/peer-handlers.ts`) is
`(claims: MeshClaims) => Promise<string | null>` — async. Per the team lead's explicit
instruction, `check()` was **not** made async to match: it is a pure in-memory `Map`
lookup with nothing to await, and an async signature would invite a future
implementation to do I/O on the request path, which is exactly what this pulled-and-
cached design exists to avoid. The wrap (`isRevoked: async (claims) => revocations.check(claims)`)
is a wiring-point concern that belongs in `peer.ts`, which does not exist in this
package yet — it is Task 6's file (per `task-6-brief.md`'s "Step 2: `peer.ts` — the
composition"). **Left as an open wiring requirement for Task 6**, not stubbed or
anticipated here.

### Not promoted, and why

- **The archive's `describe('A-2 end to end', ...)` block (E1-E6).** These six cases
  (heartbeat carries a version vector; tokens carry `iat` from the hub; a provider
  pulls the list only when the policy version moves; the timed revoked-token-refused
  measurement; a role downgrade invalidates the old token without locking the peer
  out; the hub is never on the critical path — enforcement continues offline) all
  import `createPeer` from `./peer.js` and dial real libp2p nodes via
  `@multiformats/multiaddr`. Neither `peer.ts` nor `createPeer` exists in this
  package — `task-6-brief.md`'s "Step 2" is where `peer.ts` gets built, consuming
  Tasks 1-5. Promoting these tests now would either fail to compile (no `./peer.js`
  to import) or require reaching into Task 6's scope to fabricate a `peer.ts` this
  task was not asked to build. The team lead's dispatch message already anticipated
  this — it names `peer.ts` as "Task 6" when describing the sync-vs-async wrapping
  point — so this is read as an intentional deferral, not a gap. **These six cases
  are Task 6 (or a later integration task)'s responsibility to reconstruct once
  `createPeer`/`heartbeat` exist**, at which point `RevocationRegistry`/`RevocationCache`
  from this task's `src/revocation.ts` are the pieces they exercise end-to-end.
- **`apps/httpeers-protos/lib/revocation.ts`'s `Hub` class.** Per the team lead's
  explicit instruction, not promoted: it is a demo stand-in with no cryptography,
  hardcodes `mesh: "H"`, and mints plain objects via its own `Hub.mint()` — this
  package already has real token minting in `src/tokens.ts`. Its change-list/version
  logic was read only as a cross-check that this task's promoted `RevocationRegistry`
  is sound, not as a source.
- **`store.ts`'s `removeMember`/`setRoles`, `endpoints.ts`'s version vector and
  `GET /.well-known/revocations`, `peer.ts`'s `heartbeat`/cache-wiring — all from
  `CHANGES-v0.8.0.txt`.** All belong to later tasks: this package's `src/store.ts`
  (Task 1) uses three standalone `createXStore()` factories, not the prototype's
  single `Store` class with `revocations: RevocationRegistry` built in, and no
  `endpoints.ts` or `peer.ts` exists yet. Not implemented, not stubbed — consistent
  with how Task 1's `PROVENANCE.md` entry for `src/store.ts` already flagged the
  revocation change-list as explicitly out of scope for that task.

### Verification

```
$ grep -nE "^import.*libp2p" src/revocation.ts tests/revocation.test.ts
(no matches, exit 1)

$ pnpm run typecheck
> tsc --noEmit
(clean, no output)

$ pnpm run typecheck:tests
> tsc -p tsconfig.tests.json --noEmit
(clean, no output)

$ pnpm vitest run --no-file-parallelism
 Test Files  9 passed (9)
      Tests  115 passed (115)

$ pnpm vitest run --no-file-parallelism tests/revocation.test.ts
 Test Files  1 passed (1)
      Tests  10 passed (10)

$ grep -c '  it(' tests/revocation.test.ts
10

$ npx biome check src/revocation.ts tests/revocation.test.ts src/index.ts
(clean, no output; no formatting changes needed on write)
```

Test count moved from 105/105 (end of Task 4) to **115/115** — 10 new cases, all in
`tests/revocation.test.ts`, all promoted from the archive's unit-test block.

## Task 6b — transport adapter and peer assembly over the shared stack

Second of three passes over Task 6 (`task-6-brief.md`'s Steps 1 and 2). Step 0 (null-body
statuses over `Duplex`, in `webrun-wire`) landed separately at `e73717c`. Steps 3a/3b
(promoting `chain.test.ts`'s C1-C7 and the Node↔Node `integration.test.ts`) are Task 6c —
out of scope here, deliberately not written.

A previous, undifferentiated attempt at all of Task 6 timed out; its work survives as a
grade-C reference at `.superpowers/sdd/2026-08-18-httpeers-stack/task-6-wip-gradeC/`
(`transport-duplex.ts`, `peer.ts`). It predates Task 6a (`webrun-streams-libp2p`'s
`maxInboundStreams`/`maxOutboundStreams`/`runOnLimitedConnection`, landed at `837ed72`) and
was never run.

| File | Actual basis | How resolved |
| --- | --- | --- |
| `src/transport-duplex.ts` | The grade-C reference's shape (`serveTransport`/`createRemote` over `serveConnections`/`connect` from `@statewalker/webrun-streams-libp2p`, `PROTOCOL = "/httpeers/1.0.0"`, identity registered per-inbound-stream before `dispatch` runs) is sound and was kept. What it lacked — and what made it untested against Task 6a — was added: `maxInboundStreams`/`maxOutboundStreams` threaded into both `serveConnections` (server) and `connect` (client) from a new `DEFAULT_MAX_STREAMS = 512` constant, and an explicit `DEFAULT_DRAIN_TIMEOUT_MS = 15_000` replacing `webrun-streams-libp2p`'s 5-minute default. Later (after the team lead's second dispatch establishing the `createPeer` contract other archived suites are written against — see below), this file also gained `createNode({ listen })`: a small `createLibp2p` wrapper (TCP + Noise + Yamux + identify) so `peer.ts` can build its own node when the caller doesn't supply one, keeping this file the only one in the package that imports libp2p transport machinery. | Team lead's dispatch: "quarry, not adopt" the grade-C reference; Task 6a's landed commit for the stream-limit fields; team lead's follow-up message establishing `listen`/`createPeer`-owns-its-node. |
| `src/peer.ts` | Also the grade-C reference's shape and composition order (transport → `registerPeer` → binding middleware → access policy → router → mounts; binding outside, policy inside; the deliberate non-null `lookupPeer(req)!` in `getPeerId` preserved verbatim, per explicit instruction not to "improve" it into `?? ANONYMOUS`). Its imports already named the shipped API (`withAccessTree`, `DEFAULT_ACCESS_TREE`, `usesTransportIdentity`) rather than the superseded names the dispatch warned about (`withAccessPolicy`/`DEFAULT_ACCESS_RULES`/`isTrustedPath`) — nothing to replace there. Rewritten on top of that shape per the team lead's follow-up "interface contract" message (see below): `CreatePeerInit` gained `node?`, `listen?`, `selfPeerId?`, `mounts?`, `accessTree?`, `vocabulary?`, `hubPeerId?`, `isHub?` — all optional, matching the four example calls (`{isHub:true, listen}`, `{hubPeerId, listen}`, `{hubPeerId, listen, allowRelay:true}`, `{hubPeerId}` with no listen) a later task's promoted suites are written against. `Peer` gained `peerId`, `libp2p`, `addrs()`, `call(targetPeerId, path, {token, ...RequestInit})` alongside the original `dispatch`/`remote`/`stop`. `mounts`/`accessTree`/`vocabulary` default to a new `defaultMounts()` (one diagnostic `/test/whoami` handler), `DEFAULT_ACCESS_TREE`, `DEFAULT_VOCABULARY` respectively — inferred, not dictated verbatim; see "Open question" below. | Team lead's dispatch (composition order, non-null assertion, `isRevoked` sync wrap, `allowForward` policy) plus a follow-up "interface contract" message giving the exact `createPeer(init)`/`Peer` shape two not-yet-promoted archived suites are written against. |
| `src/index.ts` | Two-line addition: `export * from "./transport-duplex.js";` and `export * from "./peer.js";`. | Mechanical — same barrel-export convention as every prior task. |
| `tests/peer.test.ts` | Not a promotion. Re-derived from folder `26`'s `duplex-identity.test.ts` (D6/D7/D8, "is the recovered identity trustworthy — under concurrency, and against a forged header") against the shipped API rather than that prototype's `vendor/` copies, driven through `createPeer` rather than a bespoke `httpOverLibp2p` helper so it also proves the composition (binding + policy), not just the transport. Two composition-only cases added beyond D6-D8: a valid token reaching the mounted handler, and a `claims.sub` naming a different peer than the connection proved getting 403. The full node↔node suite (headers, query strings, streaming, 40-concurrent, bodiless statuses, non-ASCII) is Task 6c's promoted `integration.test.ts` — deliberately a different filename so that promotion lands without a name collision. | Team lead's dispatch: "re-derive D6, D7, D8" against the shipped API; folder `26`'s test file read for the properties, not promoted (it imports non-existent `vendor/` paths). |
| `package.json` | Added `@multiformats/multiaddr`, `@statewalker/webrun-http-streams` (workspace:*), `@statewalker/webrun-streams-libp2p` (workspace:*) plus the full libp2p family (`libp2p`, `@libp2p/tcp`, `@chainsafe/libp2p-noise`, `@chainsafe/libp2p-yamux`, `@libp2p/identify`) as **dependencies** (not devDependencies) — `transport-duplex.ts`'s `createNode` constructs a real node at runtime, not just under test. `@libp2p/crypto` moved from dev- to a runtime **dependency** in the follow-up once `peer.ts` itself started calling `generateKeyPair` (for the key-retention fix — see below), not just `tests/peer.test.ts`. | Dispatch's exact-pinned version list; moved to `dependencies` once `createNode` became load-bearing rather than test-only (see the interface-contract addition above), and again for `@libp2p/crypto` once `peer.ts` needed it directly. |

### The `createPeer` contract: two dispatches, not one

The team lead's original dispatch specified `createPeer({ node, selfPeerId, mounts,
accessTree, vocabulary, allowRelay?, maxStreams? })` — `node` required, caller-built.
Partway through this task, the team lead sent a second message: two archived test suites
not yet promoted (a later task) were originally written against a **different**
`createPeer` shape — `{ isHub?, hubPeerId?, listen?, allowRelay? }`, all optional, and a
`Peer` with `.peerId`, `.libp2p`, `.addrs()`, `.call(target, path, {token})`, `.stop()` —
and asked that this task's `createPeer` match it, so that later promotion lands cleanly
rather than rediscovering the drift.

Both shapes are satisfied simultaneously: `node` is still accepted (and still what
`tests/peer.test.ts` in this task passes — the team lead was explicit that pass's own
tests do not change), but is now optional. When omitted, `createPeer` builds one itself
via `transport-duplex.ts`'s new `createNode({ listen })`. A caller-supplied node is never
stopped by `Peer.stop()`; a self-built one is. `selfPeerId` now defaults to the node's own
peerId. `hubPeerId` replaces `issuer` as the field name (same semantics: `verifyToken`'s
`issuer`, defaulting to `selfPeerId`); `isHub` is accepted and documents that default
explicitly but has no additional runtime effect.

### Resolved: minting for a self-built hub, and the accessTree/vocabulary pairing guard

Two follow-ups from the team lead, both applied:

**Key retention.** `CreatePeerInit` gained `privateKey?: Ed25519PrivateKey`. When `node`
is not supplied and no `privateKey` is given, `createPeer` — not `createNode` — generates
one via `generateKeyPair("Ed25519")` and passes it to `createNode({ listen, privateKey })`.
The team lead's own read of the archived `29/peer.ts` confirmed this is the only place it
can happen: `createLibp2p` never hands a generated key back out, so generating it inside
`createNode` would make it unreachable the instant that call returns — the exact loss this
task's first pass had. Generating it one scope higher, in `createPeer`, is what will let a
later task's minting logic (Task 7, wiring `createEndpoints`) close over `privateKey`
without threading `createNode`'s internals back out. Per explicit instruction, the key is
**not** exposed on the returned `Peer`, and no `Peer.mint()` convenience was added —
that API belongs with Task 7's endpoint design, not pre-empted here. This is the one
change that adds a fourth import-line hit to the isolation grep — see "Verification"
below; it is the same class of exception already established for `tokens.ts`.

**accessTree/vocabulary pairing.** `createPeer` now throws at construction if exactly one
of `accessTree`/`vocabulary` is supplied — defaulting both together (a matched pair) is
safe and is what the follow-up confirmed is the archive's own design, but inheriting one
while defaulting the other reintroduces the exact fail-open `withAccessTree`'s required
`vocabulary` field was built to rule out (a custom tree evaluated against the wrong
role→capability mapping, valid at construction, silently wrong at runtime). Both cases
(`accessTree` alone, `vocabulary` alone) and the "neither supplied, both default" case are
now covered by `tests/peer.test.ts` — the latter also exercises `defaultMounts()` end to
end for the first time (every other test in this file supplies its own `mounts`).

### `typecheck` — known-blocked, not by this task's own files

`pnpm run typecheck` and `pnpm run typecheck:tests` both fail — identically, since the
tests config only adds `./tests` to `./src`'s root file set and surfaces no new errors of
its own. **Zero of the 25 errors are in this task's files** (`src/transport-duplex.ts`,
`src/peer.ts`, `src/index.ts`, `tests/peer.test.ts`, or any file from Tasks 1-5). All 25
are inside `webrun-wire`'s own source, reached transitively because
`@statewalker/webrun-http-streams` and `@statewalker/webrun-streams-libp2p` export raw
`.ts` (`"exports": {".": "./src/index.ts"}`, no built-declarations fallback), so `tsc`
type-checks their actual files under **this package's** stricter compiler options —
specifically `noUncheckedIndexedAccess` and `noUnusedParameters`, neither of which
`webrun-wire`'s own `tsconfig.base.json` sets. Confirmed by locally toggling
`noUncheckedIndexedAccess` off (scratch tsconfig, not committed): all but one error
disappear; the survivor is the `noUnusedParameters` one.

Per the team lead's explicit instruction: **not** fixed by loosening this package's
tsconfig (it has caught real defects across Tasks 1-5 and would soften scrutiny for every
task still to come), and **not** worked around with a hand-maintained `.d.ts` shim (a
second, driftable source of truth for an API this package doesn't own — the project has
already lost work once to exactly that pattern). The fix is Task 2 of `webrun-wire`'s own
options in a separate pass, in that fragment, its own commit — not folded into this one,
which is the mistake that made the original undifferentiated Task 6 attempt time out.

Full itemised list (file, line, flag violated):

| File | Lines | Flag | Count |
| --- | --- | --- | --- |
| `webrun-http-streams/src/bytes.ts` | 42 | `noUncheckedIndexedAccess` (`parts[0]`) | 1 |
| `webrun-http-streams/src/http1/decode.ts` | 103, 104, 113, 122, 129, 130, 146, 147 | `noUncheckedIndexedAccess` (array-destructured `parts`, `hosts[0]`) | 8 |
| `webrun-http-streams/src/http1/encode.ts` | 57, 58, 59, 62, 63, 64 (×2), 75 | `noUncheckedIndexedAccess` (`match[1]`/`match[2]`, `[...unique][0]`) | 8 |
| `webrun-http-streams/src/http1/encode.ts` | 145 | `noUnusedParameters` (`opts` param of `encodeResponse`, unused) | 1 |
| `webrun-http-streams/src/http1/headers.ts` | 32, 218 | `noUncheckedIndexedAccess` (`bytes[i]`, `[...values][0]`) | 2 |
| `webrun-streams-libp2p/src/duplex-over-stream.ts` | 282, 345, 346 | `noUncheckedIndexedAccess` (`buf[0]`, `buf[i++]` ×2) | 3 |
| `webrun-streams/src/emulate-mux.ts` | 482, 483 | `noUncheckedIndexedAccess` (`buf[i++]` ×2, duplicate `decodeVarint`) | 2 |

**Total: 25 errors, 6 files, 3 packages** (`webrun-http-streams`, `webrun-streams-libp2p`,
`webrun-streams`) — 24 `noUncheckedIndexedAccess`, 1 `noUnusedParameters`. The team lead
noted this class of error is often a latent unchecked-index bug worth finding
deliberately, not a chore to rush.

### Verification

```
$ grep -rlE "^import.*libp2p" src/
src/peer.ts
src/tokens.ts
src/transport-duplex.ts
```

`tokens.ts`'s hit predates this task (Task 1: `@libp2p/peer-id`/`@libp2p/interface` for
Ed25519 peerId derivation, not the transport itself). `peer.ts`'s hit is new in this
follow-up — `import { generateKeyPair } from "@libp2p/crypto/keys"` for the key-retention
fix above — and is the same class of exception: `@libp2p/crypto` is Ed25519 key material,
not the libp2p transport (`node.handle`, `createLibp2p`, stream muxing), which stays
confined to `transport-duplex.ts` alone. Both hits are substring matches on the literal
grep pattern (`"libp2p"` inside `@libp2p/peer-id` and `@libp2p/crypto`), not violations of
the isolation constraint's actual intent.

```
$ pnpm install   # from the umbrella root
Already up to date

$ pnpm run typecheck
(25 errors, all in webrun-wire — see table above. KNOWN-BLOCKED, not this task's files.)

$ pnpm run typecheck:tests
(same 25 errors — the tests config adds no new ones.)

$ pnpm vitest run --no-file-parallelism
 Test Files  10 passed (10)
      Tests  123 passed (123)

$ pnpm vitest run --no-file-parallelism tests/peer.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)

$ npx biome check src/ tests/ package.json
(clean, no output; no formatting changes needed)
```

Test count moved from 115/115 (end of Task 5) to **123/123** — 8 new cases, all in
`tests/peer.test.ts`: the two composition proofs, D6/D7/D8 (all against two real libp2p
nodes over loopback TCP), and three added in this follow-up — the two accessTree/
vocabulary pairing-guard throws, and the neither-supplied defaults case.

### `DEFAULT_MAX_STREAMS` / `DEFAULT_DRAIN_TIMEOUT_MS`: why this pair

`DEFAULT_MAX_STREAMS = 512` — the recorded precedent from Task 6a's own regression tests
(`webrun-streams-libp2p/tests/stream-limits.test.ts`), comfortably above libp2p's default
32-inbound cap that resets a connection's 33rd concurrent request rather than queueing it.
Applied to both `maxInboundStreams` and `maxOutboundStreams`, on both the serving side
(`serveConnections`) and the dialing side (`connect`) — a peer both serves and dials (a
relay forwards by dialing out), so the outbound cap needs the same headroom the inbound
one does.

`DEFAULT_DRAIN_TIMEOUT_MS = 15_000` — not left at `webrun-streams-libp2p`'s 5-minute
default, because that default **multiplies** with the stream cap: it is the only bound on
a peer that requests something and then stops reading without closing (the serving side
has no `.return`/abort escape the way `connect`'s caller side does), so a peer that opens
the full stream cap and never reads any of them pins `maxStreams * drainTimeoutMs`
stream-milliseconds of server-side buffer before the last one is finally dropped. At the
library default that product is `512 * 300_000ms` ≈ **42.7 stream-hours** of exposure —
too generous once the cap itself has been raised 16× past libp2p's own default. 15 seconds
was chosen against that same product: long enough that a legitimate reader on a slow or
lossy link still has multiple seconds of headroom to drain a response chunk even at very
low bandwidth, short enough that the worst case — all 512 streams held open by a peer that
never reads any of them — caps out at `512 * 15_000ms` ≈ **2.1 stream-hours**, recoverable
within one operational window rather than requiring intervention. The two constants are
chosen together, against that one product, not independently.
