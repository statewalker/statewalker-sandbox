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
