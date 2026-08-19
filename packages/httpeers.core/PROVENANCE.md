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
