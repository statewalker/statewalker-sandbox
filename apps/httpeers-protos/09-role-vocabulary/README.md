# 09 — Roles describe people; capabilities are what code checks

`pnpm demo:09-role-vocabulary`

Pure logic, no network. **This is a reconstruction** (see Provenance).

## Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | Capabilities are the **union** of the token's roles | `std:editor` → `[files:read, files:write]`; `H/photo-curator` → `[files:read, images:share]`; together → all three, deduplicated | The result is not exactly the set union of the parts |
| 2 | The union is **purely additive** — no role removes a capability | Asserted by comparing the combined result against the computed union of the individual results | Any subtraction, which would force precedence and ordering rules |
| 3 | **An unknown role grants nothing** | `std:editor` plus a role absent from the vocabulary yields exactly the editor's capabilities, and the unknown role is reported separately | The unknown role contributes any capability — a silent over-grant |
| 4 | Unknown roles are **surfaced, not swallowed** | `capabilitiesFor` returns `known` and `unknown` lists; the demo prints the unknown one | An unrecognised role vanishes without trace |
| 5 | **Namespacing keeps same-named roles distinct** | `std:editor` and `G/editor` resolve to different capability sets | They collide, letting one mesh's role definition affect another's |
| 6 | An **unnamespaced role is rejected at construction** | `defineVocabulary({ editor: [...] })` throws | Bare names are accepted, making collisions possible later |

Exit code requires all six.

## Why "unknown grants nothing" is a rule, not an accident

The natural instinct for an unrecognised role is a permissive or "basic"
fallback. That is precisely what makes over-granting silent as the role list
grows: a typo, a stale token or a role from a newer version of the vocabulary
would quietly acquire whatever the fallback allows. Zero is the only safe
default, and claim 4 makes the situation visible rather than merely safe.

Namespacing is what makes the mapping **mesh-independent**: because role names
are globally unambiguous, role → capability is a global function, so a node
holds exactly one mapping document no matter how many meshes it belongs to.
`H/editor` and `G/editor` are simply different keys — nothing to reconcile, no
per-mesh redefinition. And because a mesh id derives from its issuer key, the
namespace is **self-certifying**: no central registry is needed for custom
roles.

## The separation this demo does not show

Vocabulary and trust are different layers. This mapping is global — but it
grants nothing on its own. A `.access` policy still names which mesh is honoured
for a given resource, which is what stops any mesh minting `std:admin` and
gaining admin everywhere. See **07**, case 6, where an admin of mesh `G` gets
nothing in mesh `H`.

## Provenance

The archived prototype (`37-httpeers-prototype-v0.9.0`) was saved as a
**delta**; the tree it applied to no longer exists in the archive.
`lib/vocabulary.ts` implements the same rules from the recorded findings.

## Not covered here

- **The vocabulary is unsigned.** Nothing authenticates the mapping document,
  and version skew between a node and its peers is untested — both recorded as
  open threads in the design.
- **No distribution.** The real design exposes a node's vocabulary at
  `/{peerId}/.well-known/capabilities` behind the same access middleware, so a
  hub can aggregate and render a console without knowing any capabilities
  itself. None of that is here.
- **No consent flow.** Per-user, per-app capability consent is undesigned.
