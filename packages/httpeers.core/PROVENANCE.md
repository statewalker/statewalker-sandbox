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
