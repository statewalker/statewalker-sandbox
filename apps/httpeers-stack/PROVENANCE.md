# Provenance — `apps/httpeers-stack`, Task 7a

This app's `src/hub/` is a **promotion**, not new construction, for most of its surface —
the plan's own risk table over-estimated how much of Task 7 was new (see
`docs/superpowers/plans/2026-08-18-httpeers-stack.md` Task 7, and the pre-flight ledger's
note ahead of Task 7 in `.superpowers/sdd/2026-08-18-httpeers-stack/progress.md`). The one
genuinely new component is the advertisements registry and its capability-filtered
projection into the mesh view (M-1) — see its own section below.

## Promoted: the endpoints shape

Source: `notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/12-httpeers-prototype-validated/src/endpoints.ts`
(read from the umbrella root — not reachable from inside this submodule).

| What was promoted | From | How it changed |
| --- | --- | --- |
| The mount table shape: `/.well-known/invite` (POST, bootstrap), `/.well-known/presence` (POST bootstrap + GET ordinary), `/.well-known/mesh` (GET, ETag-conditional), the `/.well-known/capabilities`-style "served by every peer" idea | `12/src/endpoints.ts` | `/.well-known/capabilities` was **not** carried forward — Task 6's `defaultMounts()` already answers "who are you" via `/test/whoami`, and this app's mount table (brief Step 2) does not list it. `GET /admin/invitations` and the `/test/*` handlers were **not** promoted either — out of Task 7a's mount table entirely (the brief lists no admin-invitation endpoint at all: invitations are created programmatically by whoever holds the hub process, via `InvitationStore.create`, never over HTTP — see "Design notes" below). |
| Hono as the app framework, `app.fetch as FetchHandler` with no adapter, `c.req.raw` for the underlying `Request` | `12/src/endpoints.ts` | Unchanged approach; the archive's own header comment about `url.search` being dropped is why this design (and the archive's) uses `ETag`/`If-None-Match` instead of `?since=`. |
| `provenPeer(req)` / `claimsOf(req)` helpers, the bootstrap-vs-ordinary split, `isTrustedPath` (renamed `usesTransportIdentity` back in Task 3) | `12/src/endpoints.ts` | Renamed to match Task 3's `UsesTransportIdentity` naming; logic (throw if a bootstrap handler is reached without a proven peer) unchanged. |
| `DEFAULT_ACCESS_RULES` | `12/src/endpoints.ts` | **Superseded, not promoted.** The package now has `DEFAULT_ACCESS_TREE` (Task 4/9's capability-based tree). This app reuses `DEFAULT_ACCESS_TREE`/`DEFAULT_VOCABULARY` as-is via `createPeer`; nothing new was declared. |
| The mesh view's shape (`members: [{peerId, roles, online, addrs}]`, ETag = `` `"v${version}"` ``, 304 on `If-None-Match` match) | `12/src/endpoints.ts`'s `/.well-known/mesh` handler | Decomposed into a pure `mesh-view.ts` (see below) rather than inlined in the Hono handler, and extended with the capability-filtered advertisements array (M-1) and `hidden`-role member filtering (see "Design notes"). |
| `mintToken(sub, roles) => Promise<string>` as the endpoints' minting seam | `12/src/endpoints.ts`'s `EndpointsInit.mintToken` | Signature widened to `(sub, roles, ttlMs?)` to match `MountsFactoryContext.mintToken` in `httpeers.core`'s `peer.ts` (Task 7a's one core change — see that package's `PROVENANCE.md`). `isHub`/`store: MeshStore` from the archive's `EndpointsInit` are gone entirely: this reconstruction has no single combined `MeshStore` (Task 1 already split members/presence/advertisements into three separate stores), and `isHub` has no equivalent — every hub-ness here is "this is the app that was handed a minting `mounts` factory," never a flag threaded through. |

## Applied: the v0.8.0 delta (revocation)

Source: `notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/35-httpeers-prototype-v0.8.0-revocation/CHANGES-v0.8.0.txt`,
`endpoints.ts` section only (the rest of that delta — `types.ts`'s `iat`, `tokens.ts`,
`peer-handlers.ts`'s `isRevoked` seam, `revocation.ts` itself — was already promoted into
`httpeers.core` by Task 5).

| Delta | Applied as |
| --- | --- |
| Heartbeat response gains `versions: { mesh, policy }` | `POST /.well-known/presence` returns `versions: { mesh, policy, vocabulary }` (the third counter is v0.9.0's, applied together since both deltas land in this one task) — see `endpoints.ts`'s presence handler. |
| Heartbeat response also keeps `meshVersion` "for compatibility" | **Deliberately dropped**, per Ruling R31 (`progress.md`): this is a fresh application with no legacy consumer, and the note that introduced the field itself flagged that one of the two should go before anything depended on both. **Corrected in Task 7b's review**: `ttl`, present in the archive's own heartbeat shape (`CHANGES-v0.8.0.txt`) as unchanged context rather than part of the `meshVersion`/`versions` delta, was mistakenly dropped along with it — this brief's Step 5 wording ("nothing more") over-reached past "no roster" into "no `ttl`" either. Restored; the response is `{ token, versions, ttl }` — see the "check-in returns `{ token, versions, ttl }` and not the roster" test. |
| New `GET /.well-known/revocations` → `{ version, entries }`, ETag-conditional like `/mesh` | Implemented verbatim: `` etag = `"policy${version}"` ``, 304 on match, body is `{ version: revocations.policyVersion(), entries: revocations.list() }`. |

## Applied: the v0.9.0 delta (role vocabulary)

Source: `.../37-httpeers-prototype-v0.9.0-role-vocabulary/CHANGES-v0.9.0.txt`, `endpoints.ts`
and `store.ts` sections (`access-tree.ts`'s half of this delta was already promoted into
`httpeers.core` by Task 4).

| Delta | Applied as |
| --- | --- |
| New `GET /.well-known/vocabulary`, ETag-conditional | Implemented: `` etag = `"vocab${vocabulary.version}"` ``, body is the `Vocabulary` object itself. |
| Third counter `vocabulary` in the heartbeat version vector | `versions.vocabulary: init.vocabulary.version` in the presence response (see v0.8.0 row above — the two deltas' heartbeat changes are applied together as one shape). |
| `store.ts` gains `validateRoles` calls in `createInvitation`/`setRoles`, "catch a typo where it is made, not three hops later" | Applied to **this app's** `InvitationStore.create` (`src/hub/persist.ts`) — `assertValid(validateRoles(vocabulary, roles, ...))` runs before the invitation is even stored, so a bad role name throws synchronously at creation. **Not** applied to `httpeers.core`'s `MemberStore.setRoles`: no endpoint in Task 7a's mount table calls `setRoles` with caller-supplied role names (there is no HTTP role-change endpoint yet — only `DELETE /admin/members/{peerId}` exists, in Task 8, and it does not take roles as input), so there is no live call site this task could validate at without touching library code the team lead scoped Task 7a's core change to exclude. If Task 8 or a later task adds a role-change endpoint, the same guard belongs at that call site for the same reason. |

`vocabulary.ts`'s `validateRoles`/`assertValid` were already present in `httpeers.core`
(Task 4's `DEFAULT_VOCABULARY`/`validateRoles` build), unused by anything until this task
gave them a caller.

## New, with no prototype behind it: M-1, the advertisements projection

Notes 07 and 09 (referenced by the plan and spec §2.2/§11) describe this; no archived
`endpoints.ts` implements it, and no prototype folder has an advertisements registry with
capability filtering.

**What already existed and was reused as-is:** `httpeers.core`'s `AdvertisementStore`
(`store.ts`, Task 1) — a durable, two-level-`Map`-keyed `(peerId, key) -> Advertisement`
bulletin board with no TTL of its own.

**What Task 7a designed:**

- **Wire shape**: `{ id, kind, title }`, matching the cross-task table in
  `progress.md` ("7 → 13 | advertisement `{id, kind, title}` | Clean; `kind` is the
  discovery key"). Stored in the core's `AdvertisementStore` as `key = id`,
  `payload = { kind, title }` — `id` is the natural fit for the store's per-peer key
  (a peer may advertise several distinct things), while `kind` stays in the payload as
  the semantic field a consumer (Task 13's app page) discovers by.
- **TTL "the same as presence"**: rather than giving `AdvertisementStore` its own TTL
  (which would need a second sweep and a second notion of staleness), an
  advertisement's visibility in the mesh view rides entirely on the *posting peer's*
  presence: `mesh-view.ts` never filters by `postedAt`, but the hub's TTL sweep
  (`endpoints.ts`'s `sweep()`) withdraws every advertisement belonging to a peer whose
  presence just expired. A peer's ads therefore disappear from the view within exactly
  one presence TTL of it going silent — the same mechanism, not a parallel one.
- **Posted on the heartbeat, replace-on-change semantics**: `POST /.well-known/presence`
  accepts an optional `advertisements: [{id, kind, title}]` array. When present, it
  *replaces* the peer's whole advertisement set (withdraw everything currently posted for
  that peer, then re-post what was sent) — matching "a peer advertises ... on its
  heartbeat" read as authoritative-per-heartbeat, not additive. When the field is
  **omitted**, existing advertisements are left untouched, so a client that heartbeats
  more often than its advertised service list changes is not required to resend it every
  5 s. Detected via a payload-equality check (`sameAdvertisements`) so a heartbeat that
  repeats the same ads does not bump the mesh version.
- **Capability filtering, hub-owned config, not per-advertisement metadata**: rather than
  extending the wire shape with a `requiresCapability` field (which would break the
  `{id, kind, title}` shape the cross-task table already fixed), `HubEndpointsInit`
  takes `advertisementAccess?: Record<string, string>` — `kind -> capability required to
  see it`, analogous in spirit to an `.access` entry but for the bulletin board. A `kind`
  absent from this map is visible to any authenticated caller. `mesh-view.ts`'s
  `buildMeshView` filters against `expandRoles(vocabulary, claims.roles)`, the same
  capability-expansion `access-tree.ts` already uses, so a caller's view depends on
  role→capability resolution exactly once, in one place.
- **The hub is a bulletin board, never an authority** (dispatch's framing, restated in
  `mesh-view.ts`'s own header comment): nothing here treats appearing in the view as
  permission. A provider's own `.access` tree is what actually decides whether it answers
  — Task 7a builds no such enforcement and none is implied by inclusion in `/mesh`.

## Design notes not dictated by the brief

- **Invitations have no HTTP creation endpoint.** The brief's mount table (Step 2) lists
  no `POST`/`GET /admin/invitations` at all, and the archived `revocation.test.ts` (E1-E6,
  Task 7b's, read for wire-format context only — not promoted) calls
  `hub.store.createInvitation(code, roles, ttlMs)` directly on the hub object, never over
  HTTP. `InvitationStore.create` (`persist.ts`) is this task's equivalent: a plain
  function the process embedding the hub (a test, or eventually the setup CLI) calls
  directly. `POST /.well-known/invite` is redemption only.
- **`hidden`-role member filtering.** `DEFAULT_VOCABULARY` (`httpeers.core`, Task 4) has
  carried a `hidden` role since it was written, with the doc comment "a member omitted
  from the mesh view of non-admins" — but nothing consumed it until this task.
  `mesh-view.ts`'s `buildMeshView` now does: a member with role `hidden` is omitted from
  the view unless the caller holds `std:mesh.admin`. This mirrors the archived
  `12/src/endpoints.ts`'s own `isAdmin ? members() : members().filter(m =>
  !m.roles.includes('hidden'))`, generalized from a hardcoded `'admin'` role check to the
  vocabulary's expanded-capability check the rest of this design already uses.
- **The mesh version counter, and what does *not* bump it.** `meshVersion` in
  `endpoints.ts` only advances when the *observable* view could have changed: a member
  added (invite redemption), a presence transition (a peer newly online, or its addrs
  changed), an advertisement set actually changing, or the sweep removing someone. An
  accepted heartbeat that repeats the same addrs and the same (or omitted)
  advertisements does **not** bump it — this is what keeps `/.well-known/mesh`'s `ETag`
  stable between identical 5 s heartbeats rather than invalidating on every one, which is
  the whole point of using `ETag`/304 in the first place.
- **Presence sequencing survives the TTL sweep.** `endpoints.ts` keeps its own
  `lastSeqByPeer: Map<peerId, number>`, separate from and never cleared by
  `PresenceStore.sweep()` (which the core's Task 1 `PresenceStore` does clear, by design
  — see its own doc comment). Without this, a heartbeat delayed in flight and arriving
  *after* the peer it belongs to had already been swept would look like a brand-new
  write to the bare `PresenceStore` (no record to compare `seq` against) and resurrect a
  peer that had genuinely departed. `lastSeqByPeer` only ever advances, guarding every
  `heartbeat()` call before it reaches the core store. Exercised by the "an out-of-order
  presence write does not resurrect a departed peer" test.
- **Persistence is members + spent invitation ids only, exactly as scoped.** Presence is
  not persisted (TTL'd, regenerates within one heartbeat of a restart — see `persist.ts`'s
  header comment). Invitation *records* are not persisted either, only which ids have
  already been spent — the redemption check in `InvitationStore.redeem` looks up the spent
  set **before** it looks up the invitation record, so an id whose record did not survive
  a restart still cannot be redeemed twice. Exercised by the "an invitation id cannot be
  redeemed twice, including across a persist/reload cycle" test, which stops the hub,
  builds a fresh one over the same snapshot file, and confirms both the membership and
  the spent id survived.

## Not in this task (Task 7a's) — done in Task 7b, see below

- `DELETE /admin/members/{peerId}`, `GET /search`, and their `.access` entries — done in
  Task 8, see below.

## Task 7b: the four routes Task 7a's mount table omitted, and three promoted suites

Task 7a's own mount table (Step 2 of the brief) listed no `/test/*` or `/admin/*` routes at
all — a planning error (see the team lead's Task 7b brief, Part 1), not a deliberate
scope cut. The three suites below all call `/test/whoami`; `integration.test.ts` also
calls `/test/echo` and `/admin/invitations`. All four are promoted verbatim from the
archived `12-httpeers-prototype-validated/src/endpoints.ts`:

| Route | Archive line | This app |
| --- | --- | --- |
| `GET /test/whoami` | 128 | `endpoints.ts`'s new `createTestSurfaceHandler` — `{ servedBy, you, roles, mesh }`, **not** `httpeers.core`'s own default `/test/whoami` diagnostic mount (`peer.ts`'s `defaultMounts`, `{ peer, sub }` — a different handler, not a substitute; see that function's doc comment). Mounted at `/test` for the hub, and reused directly by the "provider" peer in `revocation-e2e.test.ts`, which is not the hub but needs the same rich shape. |
| `POST /test/echo` | 138 | Same handler; echoes `{ method, body }`. |
| `GET /admin/invitations` | 122 | Added directly to the hub's own Hono `app`, mounted at `/admin`. Listing only — invitations are still created programmatically (`InvitationStore.create`), never over HTTP; unchanged from Task 7a's design note above. |
| `ALL *` → 404 `{ error, path }` | 143 | Already present in Task 7a's `endpoints.ts` (the `app.all("*", ...)` catch-all) — not one of the four actually missing; re-verified, not re-added. Note this is rarely what a real unmapped request hits: `DEFAULT_ACCESS_TREE`'s deny-by-default `/` entry denies most unmapped paths at the access-tree layer, before the router's own mount lookup — e.g. `integration.test.ts`'s "denies an unmapped path by default" gets a 403, not this 404. |

Promoted suites — all under
`notes/2026/2026-08/2026-08-16/httpeers-plan/prototypes/`, moved here by ledger R30/R37:

| Suite | Source | Cases | Result |
| --- | --- | --- | --- |
| `tests/chain.test.ts` | `31-.../chain.test.ts` | 8 (C1–C7, C5b) | 8/8 pass |
| `tests/integration.test.ts` | `12-.../src/integration.test.ts` | 17 | 17/17 pass — see below |
| `tests/revocation-e2e.test.ts` | `35-.../revocation.test.ts`, `describe('A-2 end to end', ...)` only, plus one additive sibling | 6 promoted (E1–E6) + 1 new (E6b) | 7/7 pass |

The ten `describe('A-2 unit: ...')` tests in `35-.../revocation.test.ts` were already
promoted by Task 5 into `packages/httpeers.core/tests/revocation.test.ts` and are **not**
duplicated here.

**Exactly one assertion was changed, and it was a documented delta application, not an
accommodation.** `integration.test.ts`'s "denies an admin path to a member" originally
matched `/requires one of: admin/`, which did not pass: `DEFAULT_ACCESS_TREE`'s `/admin/`
entry (Task 4/9) is gated by the capability `std:mesh.admin`, not the role name `admin`
the archive's `DEFAULT_ACCESS_RULES` used, so the actual message is `requires one of:
std:mesh.admin`. This was first reported, not fixed, per this task's rule that promoted
assertions are not adjusted to fit — but the archive itself documents this exact change:
`37-httpeers-prototype-v0.9.0-role-vocabulary/CHANGES-v0.9.0.txt`, "What the switch cost",
states "one integration assertion — the denial message improved from `requires one of:
admin` to `requires one of: std:mesh.admin`." That delta's other three access-tree tests
were already applied by an earlier task; this integration assertion lived in a suite that
did not exist until Task 7b, so the delta had been left half-applied for three tasks
without anyone able to see it. Updated to `/requires one of: std:mesh\.admin/`
accordingly. The *behavior* this test exists to pin (a member is refused `/admin/*` with
403) was intact throughout and never changed.

Everywhere else, construction and call sites were adapted — `hub.store.X(...)` (the
archive's one combined `MeshStore`) became `hub.memberStore.X(...)` plus, where
revocation must also see the change, `hub.revocations.X(...)` (Task 1 split membership
and revocation into separate registries); `mintMeshToken`/`verifyMeshToken` became this
package's `mintToken`/`verifyToken`; a presence POST body gained the `seq` field this
package's replay guard requires; the invite body's field is `id`, not `code`. Full
adaptation record, including why the rogue/forged-mesh and expired-token tests needed no
library key exposed, is in `.superpowers/sdd/2026-08-18-httpeers-stack/task-7b-report.md`.

**The `ttl` field, dropped in error and restored on review.** `integration.test.ts`'s
"check-in records presence and returns a fresh token" originally omitted the archive's
`expect(body.ttl).toBe(15_000)` — silently, not escalated — because the presence
response had no `ttl` field to check. The root cause was Task 7a's brief (Step 5: "Return
`{ token, versions }` and nothing more"), which correctly excluded the roster but
over-reached into excluding `ttl` too; the archive's `CHANGES-v0.8.0.txt` lists `ttl` as
unchanged context in the heartbeat shape, never part of the delta that superseded
`meshVersion`. Fixed by restoring `ttl: presenceTtlMs` to `POST /.well-known/presence`'s
response (`endpoints.ts`) and the archived assertion, unmodified, to
`integration.test.ts`. `tests/hub.test.ts`'s own "check-in returns { token, versions } and
not the roster" test (Task 7a's, not promoted) was updated to match the corrected shape
(`{ token, versions, ttl }`) — its point, "not the roster," is unaffected.

**E6 is promoted verbatim and stays that way; E6b is new and additive.** A review found
that E6, exactly as archived, only proves "the refused call made no *further* contact
with the hub" — its own comment ("last contact with the hub") says as much — not the
stronger claim its name makes ("the hub is never on the critical path"). Rather than
edit the promoted E6 to prove more than the archive proved, a sibling test, `E6b:
enforcement continues with the hub actually stopped`, was added: a self-contained
hub/provider/member, the hub genuinely `stop()`-ed (not merely left uncalled) before the
refusal is checked. `revocation-e2e.test.ts` therefore carries 6 promoted cases (E1–E6)
plus 1 new one (E6b), 7 total.

**E4's measured latency**: **7 ms** on the first run, **8 ms** on the re-run after the
assertion update — both well under the archive's own 59 ms localhost figure. Recorded as
measured, not as an improvement: both figures are localhost floors, not production
numbers: the point is that revocation is bounded by one heartbeat, not that it is fast.

`tests/support/mesh.ts` (new, test-only) provides `buildTestHub`/`buildTestPeer`: real,
listening peers over loopback TCP, shared by all three suites — `buildTestHub` wires the
same `createHubEndpoints`/`DEFAULT_ACCESS_TREE`/`usesTransportIdentity` construction
`src/hub/main.ts` uses; `buildTestPeer` wraps `createPeer` with a per-instance
`RevocationCache` and a `.heartbeat(hubPeerId, token)` convenience (one presence POST,
pulling `/.well-known/revocations` only when the returned policy version moved) — the
archive's own monolithic `peer.ts` had both built in; this package's split
`httpeers.core`/`httpeers-stack` does not, by design (see `revocation.ts`'s header
comment), so the wrap lives here, at the call site, as intended.

## Isolation grep

`endpoints.ts`, `mesh-view.ts`, `persist.ts`, `main.ts` import no libp2p — this app talks
to the mesh only through `@statewalker/httpeers.core`'s already-isolated surface
(`createPeer`, the `Mounts`/`FetchHandler` contracts, `lookupPeer`/`lookupClaims`). The
package-level constraint (`grep -rlE "^import.*libp2p" src/` inside `httpeers.core`
listing exactly `tokens.ts` and `transport-duplex.ts`) is unaffected by Task 7b — no core
change was made.

Task 7b's three promoted E2E suites dial real libp2p nodes (`Peer.libp2p.dial(...)`,
which is exactly what that field's own doc comment names it for), so they need a
`Multiaddr` value to dial with — `@multiformats/multiaddr`, a devDependency added for
`tests/` only. That import does not match `^import.*libp2p` (no "libp2p" substring in its
specifier), so the grep below — now run across this app's `src/` **and** `tests/`
— still finds nothing (see the task-7b report for why this is the intended reading of
"no libp2p at all"):

```
$ grep -rlE "^import.*libp2p" src/ tests/     # from apps/httpeers-stack
(no output -- nothing matches)
```

## Verification (current, after Task 7b)

```
$ pnpm run typecheck        # from apps/httpeers-stack
(clean)

$ pnpm run typecheck:tests
(clean)

$ pnpm exec vitest run --no-file-parallelism
 Test Files  4 passed (4)
      Tests  42 passed (42)
```

The "denies an admin path to a member" assertion discussed above was updated
(`requires one of: std:mesh.admin`, per `CHANGES-v0.9.0.txt`) and now passes; `ttl` was
restored to the presence response and its archived assertion; `E6b` was added
additively. All 42 tests pass.

## Task 8: the admin revocation endpoint and the search service

### A pre-work core fix, in its own commit

Before writing any of this task's own code, the brief's example `.access` tree for the new
`GET /search` route turned out to depend on behaviour `httpeers.core`'s `resolveAccess`
(Task 4/9) did not actually have: an exact-path entry (`"/search": { anyOf: [...] }`) was
dead code, never consulted, because `ancestors()` always drops the request's final path
segment and `resolveAccess` only ever looked up ancestor DIRECTORIES. Reported to the team
lead before any Task 8 code was written (per this task's own dispatch: "ask rather than
guessing"), confirmed, and found to be worse than the `/search`-shaped symptom first
reported — a targeted deny nested under a granting directory (`/admin/secret` under
`/admin/`) was equally unreachable, which is fail-OPEN, not merely inconvenient. Fixed and
landed as `httpeers.core` commit `835a5b9`, its own PROVENANCE.md section ("Task 8
(pre-work)"), separate from this task's app-level commit so the two are reviewable
independently. `resolveAccess` now checks the exact resource path as the most specific
match; `withAccessTree`'s constructor now rejects a tree declaring both `/x` and `/x/`.
138 → 141 core tests; the eleven-case `DEFAULT_ACCESS_TREE` equivalence table is untouched.

### Step 1: `src/policy.ts` — this app's own vocabulary and `.access` tree

`VOCABULARY` and `HUB_ACCESS`, matching the design record's own §8 exactly (member:
`app:search.query` + `app:images.read`; admin: implies member, plus `std:mesh.admin` —
reused from `httpeers.core`'s `DEFAULT_VOCABULARY`, not redeclared). This is a **new**
vocabulary for **this application**, not an edit to `httpeers.core`'s
`DEFAULT_VOCABULARY`/`DEFAULT_ACCESS_TREE` — those stay exactly as they were (Task
4/5/9's library defaults, generic enough to run `createPeer` with no application behind
it at all) and are untouched by this task.

- **Why `app:` and not `std:`**: `std:` is reserved for the mesh protocol itself
  (`vocabulary.ts`'s own module comment); `app:search.query`/`app:images.read` are this
  *application's* capabilities, so they take the application prefix.
- **`hidden` carried over unchanged** from `DEFAULT_VOCABULARY` (implies `member`, confers
  nothing): `mesh-view.ts`'s `buildMeshView` (Task 7a, M-1) already consumes it, and
  dropping it from this app's own vocabulary would make it un-grantable
  (`MemberStore.setRoles`/`InvitationStore.create` both validate role names against
  whichever vocabulary is in force) for no reason connected to this task.
- **Why `/.well-known/mesh` (and every other ordinary `.well-known` read, and `/test/*`)
  is gated by `app:search.query` rather than a separate capability**: this vocabulary
  declares exactly two application capabilities for `member`, and `app:search.query`
  already means "an ordinary, unrevoked member of this mesh" for every member — search is
  the mesh's first, and so far only, real service. A third capability invented solely to
  gate diagnostic/registry reads every member should see anyway would add a distinction
  with no difference. `HUB_ACCESS`'s `/.well-known/` and `/test/` directory entries use it
  for exactly that reason; `/.well-known/mesh`'s own explicit leaf entry (matching the
  design record's snippet) grants nothing the directory default does not already grant —
  written out anyway for fidelity to the design record.
- **`main.ts` now wires `HUB_ACCESS`/`VOCABULARY`** (was `DEFAULT_ACCESS_TREE`/
  `DEFAULT_VOCABULARY`) — required, not optional: without it, the production hub's
  `/search` mount would be reachable but ungoverned by anything but root's deny-by-default
  (`DEFAULT_ACCESS_TREE` has no `/search` entry, and `DEFAULT_VOCABULARY` does not declare
  `app:search.query` at all, so `withAccessTree` would throw at construction the moment a
  tree naming it was paired with that vocabulary). The three promoted E2E suites
  (`chain.test.ts`, `integration.test.ts`, `revocation-e2e.test.ts`) and `hub.test.ts`
  construct their own test hubs directly against `DEFAULT_ACCESS_TREE`/`DEFAULT_VOCABULARY`
  (`tests/support/mesh.ts`, and `hub.test.ts`'s own local `buildHub`) and were not touched,
  so this change has no effect on them.

### Step 2: `DELETE /admin/members/{peerId}` (`src/hub/admin.ts`)

Requires `std:mesh.admin` via `HUB_ACCESS`'s `/admin/` directory entry — unchanged from
`DEFAULT_ACCESS_TREE`'s own `/admin/` entry, and already correctly governs a resource three
segments deep (`ancestors("/admin/members/{peerId}")` includes `/admin/`) even before the
exact-path fix above; this route needed no core change of its own.

Mounted at a **more specific** prefix, `/admin/members`, alongside the existing `/admin`
mount (`hub/endpoints.ts`'s longest-prefix-wins router, R-1): `DELETE /admin/members/{id}`
reaches `admin.ts`'s handler, `GET /admin/invitations` keeps hitting the original Hono
`app` — no change to that existing route.

The handler does two things, both required, matching the archive-splitting precedent
`tests/support/mesh.ts` already documents: `memberStore.remove(peerId)` drops membership;
`revocations.revoke(peerId)` records the change. **The version bump needs no separate
step** — `RevocationRegistry.revoke` (`httpeers.core`, unchanged) bumps `policyVersion()`
internally as part of the same call; there is nothing else to wire for a remote provider's
next pulled heartbeat to see the change (proven by `revocation-e2e.test.ts`'s pre-existing
E3/E4, unchanged, and restated for the admin endpoint specifically by
`admin.test.ts`'s own `revocations.policyVersion()` assertion). Removal/revocation is
unconditional and idempotent — no 404 on an unknown `peerId`; see `admin.ts`'s own comment
for why that is intentional, not an oversight.

### Step 3: the search service, behind a seam (`src/services/search.ts`)

```ts
export type SearchUpstream = (query: string) => Promise<SearchResult[]>;
export const fixtureUpstream: SearchUpstream = async (q) => /* case-insensitive substring
  match over title+snippet in search-fixtures.json */;
export function createSearchEndpoint(init: { upstream: SearchUpstream }): FetchHandler;
```

`createHubEndpoints` (`hub/endpoints.ts`) takes an optional `searchUpstream` on
`HubEndpointsInit`, defaulting to `fixtureUpstream` — `main.ts` does not pass one, so the
production hub runs on the fixture set too; nothing in this task builds a real backend
(explicitly a non-goal, design record §3). The handler (`createSearchEndpoint`) never
learns what `upstream` actually is — swapping in a real backend is a change to what gets
passed as `init.searchUpstream`, not to this file, `admin.ts`, or `policy.ts`'s `.access`
entry, matching the design record's "relocating it to a standalone peer later is a change
of wiring, not of code."

**Results go in the body, never a header.** `search-fixtures.json` deliberately carries an
accented letter and an emoji in a couple of titles/snippets — proof-by-construction that a
regression trying to hoist a result into a header would fail loudly (HTTP header values are
latin1 by specification) rather than silently passing on ASCII-only fixtures.
`search.test.ts`'s "returns fixture results... in the body" test asserts those characters
survive, in the JSON body, unaltered.

**Query strings work on this transport, and this handler does not guard against them being
dropped.** `search.test.ts`'s own comment states the negative case directly: if `?q=` were
silently dropped anywhere on the `peer.dispatch` path, every non-400 test in that file
would already be failing.

**A missing or empty `q`** (including whitespace-only, trimmed before the emptiness check)
is a 400 naming `q` in the reason. Capability gating (`app:search.query`) is entirely
`policy.ts`'s `.access` entry, not this handler's job — same split as every other route.

**Revocation enforcement on the hub's own endpoints — corrected on review, see below.**
A first pass wrapped only the `/search` mount in a bespoke `requireCurrentMembership`
check. Review (`grep -rn "isRevoked" apps/httpeers-stack/src/` — nothing) found that was
route-scoped: it fixed the symptom on the route being built and left every OTHER hub
endpoint, `/admin/*` included, still honouring a revoked token until it expired — a
revoked admin could keep calling `DELETE /admin/members/{peerId}`. Corrected to wire the
hub's own `createPeer` with `revocationCache: revocations` (`hub/main.ts`), using
`httpeers.core`'s `isRevoked` binding-middleware seam the way it was designed: applied
uniformly, before ANY mount's handler runs, to every non-bootstrap request — not a check
one route remembers to opt into. `RevocationRegistry` (the hub's own live registry, the
same instance `DELETE /admin/members/{peerId}` bumps) gained its own `check` method in
`httpeers.core` for exactly this — no cache, no pull, no synchronisation step: the hub
already owns the registry directly. See that package's own `PROVENANCE.md` ("Task 8
(review round)") for the `RevocationChecker` shape this required.

**Does the registry check subsume what the removed `memberStore` check caught? Yes, for
every removal path this codebase has, verified rather than assumed**: `admin.ts`'s
handler is the ONLY code path that removes a member, and it always pairs
`memberStore.remove(peerId)` with `revocations.revoke(peerId)` in the same call — so
"no longer in `memberStore`" and "has a revocation entry with `changedAt` after the
token's `iat`" are the same set of peers, for every token this hub could ever have
minted. (A hypothetical future removal path that forgot to also call `revocations.revoke`
would not be caught by the registry check — that would be a bug in that future code, a
gap to close there, not a gap in this mechanism today.) `admin.test.ts`'s tests confirm
this directly: a revoked member is refused on TWO different mounts with the SAME token
(`/search` and `/.well-known/mesh`), and a revoked admin is refused on `/admin/members/…`
itself with their own still-nominally-`admin` token.

### Step 4: the tests

`tests/admin.test.ts` (6 cases, after the review round) and `tests/search.test.ts`
(7 cases), in process against the hub app (`hub.peer.dispatch`, manufactured `Request`s
via `registerPeer` — same style as `hub.test.ts`, not `tests/support/mesh.ts`'s
real-libp2p style: `/search` is a HUB mount, so there is no separate dialed provider
process in this scenario at all). Both files build their own local `buildHub`, wired to
`HUB_ACCESS`/`VOCABULARY` from `policy.ts` **and**, since the review round,
`revocationCache: revocations` — a deliberate divergence from `hub.test.ts`'s own local
`buildHub` and from `tests/support/mesh.ts`'s `buildTestHub`, both of which keep using
`DEFAULT_ACCESS_TREE`/`DEFAULT_VOCABULARY` (and no `revocationCache` for the hub itself)
unchanged.

| Test | File | Proves |
| --- | --- | --- |
| "an admin revokes a member; that member's next /search is refused, with a reason naming revocation -- within one heartbeat" | `admin.test.ts` | The end-to-end chain: `DELETE /admin/members/{id}` (requires `std:mesh.admin`) → `memberStore.remove` + `revocations.revoke` (version bump, free) → the SAME already-issued token, no intervening heartbeat, refused on its very next `/search` call, reason matches `/revoked/`. **Since the review round, this test also re-checks the SAME token against a second, unrelated mount (`/.well-known/mesh`)** — proof the refusal comes from the binding middleware's hub-wide `isRevoked`, not a check that happens to live on `/search`. Elapsed time asserted `< PRESENCE_TTL_MS` — bounded, not merely eventual; the actual mechanism (a direct, synchronous registry check) makes it immediate. |
| "a revoked admin cannot call DELETE /admin/members/... -- the case that justifies enforcing hub-wide, not route by route" | `admin.test.ts` | **New in the review round**, the case that justifies it: a root admin revokes a second admin (`bad-actor`); `bad-actor`'s own still-"admin"-role-carrying token is refused (403, reason matches `/revoked/`) on its next `DELETE /admin/members/{id}` call, and the target (`carol`) is confirmed still a member — the handler never ran. Without hub-wide enforcement, a revoked admin could keep removing others until their token expired. |
| "a member calling DELETE /admin/... is refused 403, and the reason names the missing capability" | `admin.test.ts` | 403, reason matches `/std:mesh\.admin/`; the targeted member (`carol`) is confirmed still present in `memberStore` afterward — the handler never ran. |
| "/search without app:search.query -> 403 carrying the tree's reason" | `admin.test.ts` | A real, current, unrevoked member whose token carries no role conferring `app:search.query` (invited with `roles: []`) — 403, reason matches `/app:search\.query/`. Deliberately not the no-token case (that is `newPeerHandlers`' own 401, a different layer, already covered by `hub.test.ts`'s "a caller with no proven identity..."). |
| "the vocabulary and revocation endpoints still answer 304 on an unchanged version" | `admin.test.ts` | `GET /.well-known/vocabulary` and `GET /.well-known/revocations`, both under the new `HUB_ACCESS`, still 200 then 304 on a repeated `If-None-Match` — unchanged `endpoints.ts` behaviour, now proven under the new policy (and the hub-wide revocation wiring) too. |
| "returns fixture results for a matching query, in the body" | `search.test.ts` | 200, `content-type: application/json`, results present, and the non-latin1 fixture characters survive in the body. |
| "a query with no matches returns an empty result set, not an error" | `search.test.ts` | 200 with `results: []` — no match is not an error condition. |
| "a missing q is a 400 with a reason" / "an empty q is a 400 with a reason" / "a whitespace-only q is also a 400..." | `search.test.ts` | The `q` guard, including the trim (a whitespace-only query is not treated as a literal search term). |
| "the fixture upstream itself is deterministic and case-insensitive" | `search.test.ts` | `fixtureUpstream` directly, independent of the HTTP layer. |
| "query strings survive this transport..." | `search.test.ts` | Restates, explicitly, that no dropped-`?q=` guard exists or is needed — see Step 3 above. |

### Counts and verification (after the review round)

```
$ pnpm install                              # from the umbrella root, never from workspaces/statewalker-sandbox
Scope: all 45 workspace projects
Lockfile is up to date, resolution step is skipped
Already up to date

# packages/httpeers.core
$ pnpm run typecheck && pnpm run typecheck:tests
(clean, both)
$ pnpm exec vitest run --no-file-parallelism
 Test Files  12 passed (12)
      Tests  146 passed (146)
$ grep -rlE "^import.*libp2p" src/
src/tokens.ts
src/transport-duplex.ts

# apps/httpeers-stack
$ pnpm run typecheck && pnpm run typecheck:tests
(clean, both)
$ pnpm exec vitest run --no-file-parallelism
 Test Files  6 passed (6)
      Tests  54 passed (54)
$ grep -rlE "^import.*libp2p" src/ tests/
(no output -- nothing matches)
```

**138 → 141 (pre-work fix) → 146 core** (the review round's 5 new
`RevocationRegistry.check` tests; no other core test file changed).
**42 → 53 → 54 app** (the review round added 1: "a revoked admin cannot call DELETE
/admin/members/..."; the original 42 remain unchanged and still passing — `chain.test.ts`
8, `hub.test.ts` 8, `integration.test.ts` 17, `revocation-e2e.test.ts` 7 (E1–E6, E6b),
unmodified).

### Deviations from the brief, and why

- **`resolveAccess`/`withAccessTree` changed in `httpeers.core`** — not listed in the
  brief's file list at all. Required: the brief's own `.access` tree example depends on
  exact-path entries working, which they did not before this fix. Reported and authorised
  by the team lead before any app-level code was written; landed as its own commit,
  documented in that package's own `PROVENANCE.md`.
- **`hub/main.ts` modified** — not listed in the brief's file list (which named
  `endpoints.ts`, `admin.ts`, `services/search.ts`, `services/search-fixtures.json`,
  `policy.ts`, and the two test files). Required for the production hub's `/search` mount
  to be reachable at all outside of tests — see "Why `main.ts` now wires..." above.
- **`RevocationChecker` added to `httpeers.core` (review round)** — not in the original
  brief at all; a consequence of the review-round fix below. `RevocationRegistry` gained a
  `check` method and `CreatePeerInit.revocationCache`'s type widened from the concrete
  `RevocationCache` class to this new interface. Landed in its own commit, again separate
  from the app-level change, documented in that package's own `PROVENANCE.md`.
- **The `/search`-only `requireCurrentMembership` check, corrected on review to hub-wide
  `isRevoked` wiring** — the original first-pass fix (not named in the brief's Step 3
  text at all) covered only the route being built and left every other hub endpoint,
  `/admin/*` included, still honouring a revoked token until it expired. Corrected: removed
  from `hub/endpoints.ts`; `hub/main.ts` now passes `revocationCache: revocations`
  directly to `createPeer`, so `httpeers.core`'s existing binding middleware enforces
  revocation on every mount uniformly. See "Revocation enforcement..." above for the full
  writeup, including the verification that the registry check subsumes what the removed
  membership check caught.
- No existing assertion in any of the four previously-passing test files was altered, in
  either the original pass or the review round.
