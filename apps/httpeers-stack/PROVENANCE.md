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

### Counts and verification (after Task 8's review round)

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

## Task 9: relay and static server processes

Two small, independent processes — batched into one task because they are the same
shape (a standalone boot script under `src/<name>/main.ts`, no test file for the relay,
one shared test file for both static-server origins). Neither touches `httpeers.core`.

### Step 1: `src/relay/main.ts`

Stock `circuitRelayServer()` (`@libp2p/circuit-relay-v2`) over `webSockets()`
(`@libp2p/websockets@10.1.19`), `noise()`/`yamux()` for encryption/muxing, `identify()`
alongside it (same pairing `httpeers.core`'s own `transport-duplex.ts` `createNode` uses,
and required for the relay's own reservation/identify flow, not merely copied). Listens on
`/ip4/0.0.0.0/tcp/${RELAY_PORT}/ws` (`RELAY_PORT` defaults to 9090, `DEFAULT_RELAY_PORT`).

**No application code**: no `serveDiscovery()`, no directory, no self-announcement —
confirmed by inspection that `src/relay/main.ts` imports only libp2p packages plus
`node:fs`, nothing from `../hub/`, `../policy.ts`, or `httpeers.core`. `p2p-demo`'s
`relay/server.ts` (`workspaces/webrun-wire/apps/p2p-demo/relay/server.ts`) was read for
reference on the libp2p wiring shape only; its `serveDiscovery()` call was deliberately
not carried over.

Reservation limits: `circuitRelayServer()` called with no options, i.e. left at its own
defaults — not raised, not lowered.

**TLS**: when both `TLS_CERT` and `TLS_KEY` are set, they are read as **file paths** (a
decision this task makes — the brief names the env vars but not whether they hold PEM
content or a path to it; treated as paths because that is how a real deployment renews a
Let's Encrypt cert without touching the env, and because passing multi-line PEM content
through a shell env var is the more awkward of the two conventions). Their file contents
are passed to `webSockets({ https: { cert, key } })`, and the listen multiaddr's scheme
switches to `wss`. `@libp2p/websockets`'s `WebSocketsInit.https` field was checked against
the installed `10.1.19` types (`https.ServerOptions`, accepting `cert`/`key` as
string/Buffer) — not assumed.

**Identity — fail loudly, do not generate.** The relay's peerId is embedded in every
multiaddr `httpeers.json` (Task 10) hands out; an ephemeral key would silently invalidate
that config on every restart, with a symptom (peers can't connect) that points nowhere
near the relay. `loadRelayKey` reads `.httpeers/relay.key` (`DEFAULT_RELAY_KEY_PATH`);
on `ENOENT` it prints an explicit "run `pnpm setup` first" message to stderr and calls
`process.exit(1)` — verified manually (see "Manual verification" below), not just
asserted in prose.

**Key file format — a decision this task makes, for Task 10 to honor.** The brief names
the file (`.httpeers/relay.key`) but not its encoding, since Task 10 (the setup CLI that
writes it) does not exist yet. Chosen: the protobuf encoding `@libp2p/crypto/keys`'
`privateKeyToProtobuf`/`privateKeyFromProtobuf` round-trip through — libp2p's own
idiomatic on-disk key format, and the same package `httpeers.core`'s `tokens.ts` already
depends on for `generateMeshKey`. Documented in `src/relay/main.ts`'s module comment so
Task 10 has one place to check. **Flagging to the team lead**: if Task 10 lands with a
different format in mind, this is the one line (`loadRelayKey`'s `privateKeyFromProtobuf`
call) that needs to change to match — no other code here depends on the encoding.

Prints the peerId and every multiaddr on boot; `SIGINT`/`SIGTERM` both call `node.stop()`
via a shared `shutdown` handler, then `process.exit(0)`.

### Step 2: `src/static-server/main.ts`

Plain `node:http`/`node:https` — **no libp2p import** (verified: `grep -n libp2p
src/static-server/main.ts` matches only prose inside comments, never an `import`). Two
`createOriginServer` instances, one per port (`APP_PORT` = 5175, `IMAGE_PEER_PORT` =
5176, both fixed constants per the brief, not env-configurable), started together by
`startStaticServer`.

**Why two real `http.Server` instances, not one server with two `listen()` calls or a
single dispatcher keyed by port**: each origin needs its own closure over its own
`distDir`/`swFile` — using two independent `createOriginServer` calls makes it structurally
impossible to accidentally serve one origin's assets under the other's port, which a
shared dispatcher branching on `req.socket.localPort` would not guarantee as cleanly.

**Dist directory layout — an assumption this task makes, flagged for Tasks 12/13.**
Tasks 11–13 (the browser peer runtime and the two page bundles) do not exist yet, so
there is no built output to point at. Defaults chosen: `dist/app` and `dist/image-peer`
(`DEFAULT_APP_DIST_DIR`/`DEFAULT_IMAGE_PEER_DIST_DIR`), following this workspace's
existing `dist/`-is-gitignored convention (confirmed:
`workspaces/statewalker-sandbox/.gitignore` already lists `dist/`). Overridable via
`APP_DIST_DIR`/`IMAGE_PEER_DIST_DIR` env vars (production) or `appDistDir`/
`imagePeerDistDir` init fields (tests), so Tasks 12/13 can either match these defaults or
override them with no change needed here. Same reasoning for the ServiceWorker script's
assumed filename, `sw.js` (`swFile` init field, defaulting from each page's `sw.ts`
entry) — not pinned anywhere in the brief or the plan.

**`/httpeers.json`**: served from **outside** each origin's `distDir` — it is one shared
invitation payload (`DEFAULT_HTTPEERS_CONFIG_PATH` = `./httpeers.json`, matching the
plan's Task 10 §2 shape, `{ relayAddrs, hubPeerId }`), not a per-page build artifact.
Read fresh off disk on every request (no caching layer) and passed through byte-for-byte
— the server never parses it, since the pages are the ones that need to. Missing file →
**503** with a JSON body naming `"run \"pnpm setup\" first"`, never a 404: an absent
config is a different condition from a missing route (brief's own framing), and a 503
here is what lets the page say "run setup" instead of "not found".

**ServiceWorker script headers**: `Cache-Control: no-cache, no-store, must-revalidate`,
`Pragma: no-cache`, `Service-Worker-Allowed: /` — applied only to the resolved file that
matches `swFile`, not to every static asset (an app's hashed JS/CSS bundle files are
meant to be cached; only the SW script itself is the debugging-tarpit risk the brief
calls out).

**Path safety**: `resolveDistFile` refuses to resolve outside `distDir` (checked via
`target.startsWith(root + sep)`), and every request whose method is not `GET`/`HEAD` is
answered 404 before any routing or file I/O runs at all — so a POST anywhere, matched
route or not, can never reach a code path that reads a file and could throw. This is a
different implementation shape from `webrun-http-browser`'s bug (note 39: rebuilding a
`Request` without `duplex: "half"`) — this server never constructs a Fetch API `Request`
internally at all, so that specific defect class does not apply here — but the
**symptom** (POST to an unmatched path → 500) is exactly what `tests/static-server.test.ts`
asserts against, directly, per the brief's instruction.

### Step 3: `tests/static-server.test.ts` (9 cases, real bound ports, ephemeral `port: 0`)

| Test | Proves |
| --- | --- |
| "serves the app origin's index.html" | `GET /` on the app port → 200, `text/html`, correct body. |
| "serves the image-peer origin's index.html, distinct from the app's" | Same, on the image-peer port, with different content — the two origins are genuinely independent servers, not one server keyed by header. |
| "serves each origin's ServiceWorker script with the right content type and no-cache headers" | `GET /sw.js` on both ports → `text/javascript`, `Cache-Control` matching `no-cache`/`no-store`, `Service-Worker-Allowed: /`. |
| "serves /httpeers.json identically at both origins when present" | Both ports read the same on-disk file and return its `hubPeerId` unchanged. |
| "returns 404, not 500, for an unknown GET path" | The brief's baseline case. |
| "returns 404, not 500, for a POST to an unknown path -- the duplex/passthrough regression case" | The brief's explicitly-called-out case (note 39). Sends a JSON body with `content-type: application/json` on the POST — not a bodyless request — so the assertion is not weakened to "POST with no body happens to work." |
| "never resolves a '..'-shaped path to a file outside its distDir" | Sent via a raw `node:http` client (`rawGet`), not `fetch`/`URL` — `fetch`'s own client-side URL normalization would silently rewrite a literal `..` away before the request left the client, which would make this assertion pass for the wrong reason. Confirms the response is 404, not 500 and not a leaked file, regardless of whether `new URL()`'s own path-shortening or `resolveDistFile`'s explicit root check is what stops it (both are in play; this test does not need to distinguish which). |
| "gives a clear 503, not a 404, when httpeers.json has not been generated yet" | A separate `createOriginServer` pointed at a config path that is never written — 503, JSON body, error text matches `/setup/i`. |
| "still serves index.html and 404s an unknown path normally" | The 503 branch does not degrade the rest of that same origin's routing. |

54 → 63 app tests (9 new, all in the new file; no existing assertion in any of the six
previously-passing test files was touched).

### Where libp2p imports live in `apps/httpeers-stack`, and why

```
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' src/
src/relay/main.ts
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' tests/
(no output -- nothing matches)
```

Exactly one file: `src/relay/main.ts`. It is the process whose entire job is running a
libp2p Circuit Relay v2 node, so it is the one place in this app where importing libp2p
directly is the design, not a leak. `src/static-server/main.ts` imports none — confirmed
above and by inspection: it never imports `httpeers.core` either, matching the brief's "no
libp2p, no mesh identity" instruction for that process. `httpeers.core`'s own isolation
grep (`src/tokens.ts`, `src/transport-duplex.ts`) is untouched by this task — nothing in
`packages/httpeers.core` was modified.

### Counts and verification (after Task 9)

```
$ pnpm install                              # from the umbrella root, never from workspaces/statewalker-sandbox
Already up to date

# packages/httpeers.core (untouched by this task -- re-run as a baseline check)
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
 Test Files  7 passed (7)
      Tests  63 passed (63)
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' src/
src/relay/main.ts
```

**146 core (unchanged) / 54 → 63 app** (9 new cases, all in
`tests/static-server.test.ts`; the six previously-passing files — `admin.test.ts`,
`chain.test.ts`, `hub.test.ts`, `integration.test.ts`, `revocation-e2e.test.ts`,
`search.test.ts` — are unmodified and still passing).

### `package.json`

Added to `dependencies` (all exact-pinned, no carets, matching `httpeers.core`'s own
versions where the same package is already a dependency there):
`@chainsafe/libp2p-noise@17.0.0`, `@chainsafe/libp2p-yamux@8.0.1`,
`@libp2p/circuit-relay-v2@4.2.11` (version taken from `p2p-demo`'s own pin, the only
existing consumer of that package in this workspace — `httpeers.core` does not depend on
it), `@libp2p/crypto@5.1.22`, `@libp2p/identify@4.1.12`, `@libp2p/interface@3.2.5`,
`@libp2p/websockets@10.1.19`, `libp2p@3.3.8`. No `@statewalker/*` cross-repo dependency
was touched — `@statewalker/httpeers.core` stays `workspace:*`, unchanged.

### Manual verification (beyond the automated suite)

Both processes were also boot-tested directly, not only unit-tested, since a boot script
run only via `import.meta.url === file://...` guard is otherwise unexercised by
`vitest run`:

- `tsx src/relay/main.ts` with no `.httpeers/relay.key` present → printed the "run `pnpm
  setup` first" message to stderr and exited `1`, no `.httpeers/` directory created.
- `tsx src/relay/main.ts` with a manually-generated protobuf key at
  `.httpeers/relay.key` → printed a real peerId and three multiaddrs (loopback + two LAN
  interfaces) on `/ws`, then handled `SIGINT` by logging and stopping cleanly.
- `startStaticServer` invoked directly (not through the test file) against a scratch
  `dist/app` + `dist/image-peer` with real files → `GET /`, `GET /httpeers.json`,
  `GET /sw.js` (headers inspected directly) and a `POST` to an unmatched path all
  returned the expected status/headers.

### Deviations from the brief, and why

- **Key file format for `.httpeers/relay.key` is this task's own decision**, not
  specified by the brief (Task 10, which writes it, does not exist yet). See "Key file
  format" above. Flagged for the team lead / Task 10's implementer to confirm or correct.
- **Dist directory layout (`dist/app`, `dist/image-peer`) and the ServiceWorker
  filename (`sw.js`) are this task's own assumption**, for the same reason — Tasks
  11–13 do not exist yet. Both are overridable via env vars/init fields specifically so
  a different choice in those later tasks costs a one-line override here, not a rewrite.
- **`TLS_CERT`/`TLS_KEY` are read as file paths**, not treated as raw PEM content. The
  brief names the env vars but not their contents; this task chose paths (see "TLS"
  above) for both processes consistently.
- **Static server ports/dist dirs are configurable beyond the brief's literal fixed
  5175/5176**: `appPort`/`imagePeerPort` init overrides exist so the test suite can bind
  ephemeral ports (`0`) rather than depending on 5175/5176 being free on the machine
  running the tests. Production use (`import.meta.url` guard) always binds the fixed
  `APP_PORT`/`IMAGE_PEER_PORT` constants — the override exists for testability only, not
  as a configuration surface anyone is expected to use in the real deployment.
- No existing assertion in any of the six previously-passing test files was touched.

## Task 10: the setup CLI — keys and the invitation payload

The CLI that turns a fresh checkout into a runnable stack: `pnpm setup` generates (or,
on a later run, simply reads back) this deployment's persistent identity, and writes
`httpeers.json` — the invitation payload note 07 §4 describes, and the shape
`../static-server/main.ts` (Task 9) already serves with its own distinct 503 when it is
missing.

### Step 1: key management (`src/setup/keys.ts`)

`loadOrGenerateKey({ keyPath, seed? })`: Ed25519-only (design note 05 §2), reads the key
at `keyPath` if it exists, otherwise generates one (from `RELAY_SEED`/`HUB_SEED` via
`generateKeyPairFromSeed` when a seed is given, `generateKeyPair` otherwise) and persists
it. **File format**: the protobuf encoding `@libp2p/crypto/keys`'s own
`privateKeyToProtobuf`/`privateKeyFromProtobuf` round-trip through — exactly the format
`../relay/main.ts`'s `loadRelayKey` (Task 9) reads back, per that module's own "Task 10
must produce exactly that shape" instruction.

**Idempotence — the property the brief calls out as the one that matters most — is
structural, not a special case**: there is no code path in `loadOrGenerateKey` that writes
to `keyPath` once `existsSync(keyPath)` is true. A seed is only ever consulted the first
time a key is written; an existing file always wins on a later call, even with a
different seed passed (`tests/setup.test.ts`'s "a seed is only consulted the first time a
key is written" case).

**Seed derivation**: `generateKeyPairFromSeed("Ed25519", seed)` requires exactly a 32-byte
seed (verified against the installed `@libp2p/crypto@5.1.22` source,
`keys/ed25519/index.js`'s `generateKeyFromSeed`, which throws `TypeError` on any other
length) — `RELAY_SEED`/`HUB_SEED` are arbitrary-length env strings, so `deriveSeedBytes`
expands them via SHA-256 (deterministic, fixed-length, and any single-character change
in the input yields an unrelated key — exactly what "name a peerId as a constant" needs).
`HUB_SEED="httpeers-test-hub-seed"` → `12D3KooWRkdxQyt33uJAw6KNQYcVWh7HdH116eCvdZYcMBSUKrsM`;
`RELAY_SEED="httpeers-test-relay-seed"` → `12D3KooWAAaLaGEV867vPJ1WGQB9RmFCKcK2abFyMsFkR9uwEXAU`
— both pinned as constants in `tests/setup.test.ts`, computed once via a scratch script
against the real installed `@libp2p/crypto`, not hand-typed.

### Step 2: `httpeers.json` (`src/setup/main.ts`)

`runSetup(init)` calls `loadOrGenerateKey` for both roles, derives each peerId
(`peerIdFromPrivateKey` — the same computation `httpeers.core`'s `tokens.ts` uses for
`mintToken`), and writes `{ relayAddrs: ["/<family>/<RELAY_HOST>/tcp/<RELAY_PORT>/<ws|wss>/p2p/<relayPeerId>"], hubPeerId }`.
`RELAY_HOST` defaults to `127.0.0.1` (matching the design record's own example). The
multiaddr protocol segment (`<family>`) is **not** hardcoded to `ip4` — `relayAddrFamily(host)`
picks `ip4`/`ip6` for an IP literal (`node:net`'s `isIP`) and `dns4` for anything else (a
hostname), because a browser cannot dial a bare IP literal over TLS (the certificate would
not match it): a server deployment's `wss` relay address must be `/dns4/host/tcp/443/wss`,
per the design record's own local-vs-server table, or it is undialable from the very peers
the deployment exists to serve. This was found missing on first review (an earlier version
of this section documented IPv4-only address building as an accepted deviation) and fixed
before landing — see "Deviations from the brief, and why" below, corrected accordingly. The
`ws`/`wss` scheme switches on whether both `TLS_CERT` and `TLS_KEY` are set — the CLI's own
`relayTls: boolean` flag, not the cert/key content itself, since `httpeers.json` only
ever needs to know which scheme to write, never the certificate material.

**Idempotence end to end**: `runSetup` does nothing but call `loadOrGenerateKey` (which
never rewrites an existing key) and re-derive `httpeers.json` from whatever came back —
so running it twice with the same env produces byte-identical output on both keys AND the
config (`tests/setup.test.ts`'s "does not change either key or the config" compares
`Buffer.equals`, not merely "no error" or "no throw"). Running it a third time with
*different* `RELAY_HOST`/`RELAY_PORT` still reuses the same keys; only the config's
addresses change.

### Step 3: the scripts

`package.json` gained `setup`, `start` (`bash scripts/start.sh`), `start:relay`,
`start:hub`, `start:static` — verbatim as briefed.

`scripts/start.sh` boots relay → hub → static server and tears all three down on
Ctrl-C. **Does not scrape stdout for a multiaddr** — deliberately, unlike
`webrun-wire/apps/p2p-demo/scripts/start.sh`, whose relay identity is ephemeral every
run, making its own multiaddr log line the only way to hand the address to the other
processes it boots. This stack's identities are not ephemeral (Task 9's relay,
now Task 10's hub too — see Step 4 below): everything a dialer needs already sits in
`httpeers.json`, a durable file written once by `pnpm setup`. Only the trap/cleanup shape
(`pids=()`, `trap cleanup EXIT INT TERM`, `kill -- "-$pid"` against each child's process
group) is copied from that script's pattern; its stdout-parsing loop is not.

Ordering: the relay is TCP-polled on `127.0.0.1:$RELAY_PORT` (a plain reachability probe,
not a read of anything the relay sends) before the hub is started — the hub reserves a
slot through the relay rather than binding a fixed, externally-knowable port of its own
(`httpeers.json`'s own shape has no hub port to poll), so a short fixed pause after
starting it, checking only that the process is still alive, is what stands in for
"ready" there. `httpeers.json`'s absence is checked before anything is started, and the
script exits 1 with `run "pnpm setup" first` — not a partial boot.

### Step 4: `src/hub/main.ts` was also modified — the one deviation from the brief's file list, made in scope after asking

**Not in Task 10's file list, but required for the setup CLI's work to have any effect on
the running hub.** `src/hub/main.ts`'s own module comment (written in Task 7a) explicitly
deferred key persistence to "the setup CLI (a later task)" and left `createPeer`'s
optional `privateKey` as the seam for it — this is that task. Flagged to the team lead
before writing the change (`.superpowers/sdd/2026-08-18-httpeers-stack/task-10-report.md`
carries the full exchange); confirmed in scope, with the reasoning restated even more
sharply than the brief's own framing: **without this wiring, `pnpm start:hub` mints a
fresh key on every run, so the peerId `httpeers.json` names is not the peerId the process
that actually boots uses — not a stale config (which would at least be internally
consistent), but a config that describes a mesh that no longer exists the moment the hub
restarts.**

Confirmed as a real, live defect before fixing it, not inferred from the comment alone:
booted the stack (`pnpm setup` then `tsx src/hub/main.ts`) before this change and
captured two different peerIds — `httpeers.json` named
`12D3KooWEEh6igGmzfhZ8Eq6jLiCLvWnFyWkQxsHANdXUJyRSNoE`, the hub that actually started was
`12D3KooWC8z5ws5M3Kv9zRPm6LgmVT4Uh4koHcyMztDCSivAytgu` — different on every run.

**The fix mirrors the relay's contract exactly, not a new one**: `loadHubKey(keyPath)`
in `hub/main.ts`, structurally identical to `../relay/main.ts`'s `loadRelayKey` — reads
`.httpeers/hub.key` (`DEFAULT_HUB_KEY_PATH`, now the canonical constant `setup/main.ts`
imports rather than re-declaring, so the path can't drift between the writer and the two
readers), decodes via `privateKeyFromProtobuf`, type-guards to `Ed25519`, and on `ENOENT`
prints a "run `pnpm setup` first" message to stderr and calls `process.exit(1)` — same
shape as the relay's message, worded for the hub's own stakes (identity, not just
address). `startHub` now threads the loaded key through to `createPeer({ privateKey,
... })`, the exact seam Task 7a left for this. `StartHubInit` gained an optional
`keyPath` (defaulting to `DEFAULT_HUB_KEY_PATH`), matching `StartRelayInit`'s own shape.

**Verified this does not affect any existing suite, rather than assumed**: `grep -rn
"startHub\b" tests/ src/` before making the change found exactly two lines, both inside
`hub/main.ts` itself (the export and its own run-if-main call) — no test file imports
`startHub` or `hub/main.ts` at all. Every existing suite (`chain.test.ts`, `hub.test.ts`,
`integration.test.ts`, `revocation-e2e.test.ts`, `admin.test.ts`, `search.test.ts`,
`tests/support/mesh.ts`) builds its own hub directly via `createPeer`/
`createHubEndpoints`, bypassing `main.ts` entirely — confirmed by the full suite still
passing unchanged (see counts below), not merely by this grep.

**End-to-end re-verification after the fix**: `pnpm setup` then `tsx src/hub/main.ts`
now boots with the SAME peerId `httpeers.json` names —
`12D3KooWCXYEeYzHWgTw3mqQpaYxWmWZeqPNRvLrrfjXz5QxYtu9` on both sides, captured directly
from the two processes' own output, a fresh run distinct from the pre-fix capture above.

### Step 5: the tests (`tests/setup.test.ts`, 17 cases)

| Test | Proves |
| --- | --- |
| "writes both keys and a config whose hubPeerId matches the hub key" | The brief's baseline case — both key files decode as Ed25519, `httpeers.json`'s `hubPeerId` matches the hub key's derived peerId. |
| "derives relayAddrs from RELAY_HOST/RELAY_PORT -- an IPv4 literal host stays /ip4/" | The address-derivation rule for an IPv4 literal, independent of TLS. |
| "TLS env produces a wss relay address" | `relayTls: true` → `wss` scheme, no second code path. |
| "a RELAY_HOST hostname produces a /dns4/ relay address, not /ip4/" | `relayAddrFamily`'s hostname branch — added on review, see "Deviations" below. |
| "a hostname RELAY_HOST combined with TLS produces /dns4/.../wss..." | The deployment-relevant combination the final task's acceptance criterion actually names. |
| "an IPv6 literal RELAY_HOST produces /ip6/..." | The one-line IPv6 branch that fell out of `node:net`'s `isIP` for free. |
| "does not change either key or the config" (idempotence) | `Buffer.equals` on all three files across two `runSetup` calls — not "no error." |
| "a third run, with different relayHost/relayPort, still reuses the same keys" | The mesh identity survives a config-only re-run. |
| "HUB_SEED produces a deterministic, documented peerId" / "RELAY_SEED produces a deterministic, documented peerId..." | Fixed seed strings pinned to real, computed peerIds (see Step 1). |
| "the same seed always derives the same key, across separate directories" | The derivation is a pure function of the seed, not of anything ambient. |
| "a seed is only consulted the first time a key is written" | An existing key file wins over a later, different seed — see Step 1's idempotence note. |
| "startRelay ... boots with exactly the peerId setup wrote into httpeers.json" | **Not a file-existence check**: boots the relay's own real entry point (`startRelay`, which internally calls the private `loadRelayKey`) against the generated key and asserts the booted node's peerId. `loadRelayKey` itself is not exported (by design — see its module comment), so this is the strongest assertion reachable through the public surface. |
| "also round-trips directly through privateKeyFromProtobuf..." | The same decode `loadRelayKey` performs, asserted directly. |
| "the peerId startHub boots with equals httpeers.json's hubPeerId" | **The regression test for the Step 4 gap** — boots the real `startHub` against the generated hub key and asserts its peerId equals both `runSetup`'s return value and the written config. This is the automated form of the manual check that found the defect; see its own comment for why the pre-fix version of this exact assertion would have failed. |
| "generates a key on first call and reuses the exact same key on a second call" / "rejects a non-Ed25519 key file..." | `keys.ts`'s `loadOrGenerateKey` exercised directly, including against a real secp256k1 key (`generateKeyPair("secp256k1")`) to prove the type guard, not merely documented. |

**Not automated**: the hub's and relay's `ENOENT` → `process.exit(1)` paths. Calling
either in-process would kill the vitest worker itself, so — matching the precedent
already set for the relay in Task 9's own PROVENANCE.md ("Manual verification") — both
are verified by running the real script as a subprocess instead (`tsx src/hub/main.ts`
/`tsx src/relay/main.ts` with no key file present; both printed their guidance and exited
1, confirmed above and in Task 9's own record for the relay).

### Deviations from the brief, and why

- **`src/hub/main.ts` modified** — not in the brief's file list. Required, escalated
  before writing any code, and confirmed by the team lead; see Step 4 above for the full
  reasoning and the defect it closes.
- **`RELAY_HOST` address-family handling was flagged, then corrected before landing** —
  the first pass treated `RELAY_HOST` as a literal IPv4 host string only
  (`/ip4/<host>/...`) and flagged this as a possible gap. Review found it was a real
  defect, not a note: a `wss` relay address built as `/ip4/<hostname>/...` is undialable
  from a browser (a TLS certificate cannot match a bare IP literal), and it broke the
  final task's stated acceptance criterion (setting `TLS_CERT`/`TLS_KEY` alone should
  produce a working `wss` relay address, with no other change). Fixed:
  `relayAddrFamily(host)` (`node:net`'s `isIP`) now picks `dns4` for a hostname, `ip4`
  for an IPv4 literal (the existing local default, `127.0.0.1`, is unaffected), and `ip6`
  for an IPv6 literal (included because it fell out of `isIP` as a one-line branch, not
  because a general address-parsing layer was built — no other address form was added).
  Three tests added (hostname → `/dns4/`, hostname+TLS → `/dns4/.../wss` — the
  deployment-relevant combination — and an IPv6 literal → `/ip6/`); no existing assertion
  changed. See `.superpowers/sdd/2026-08-18-httpeers-stack/task-10-report.md`'s addendum
  for the full before/after evidence.
- **The seed-derivation algorithm (SHA-256 expansion to 32 bytes) is this task's own
  choice** — the brief specifies the env vars and the "deterministic, documented peerId"
  requirement but not the derivation itself. Documented in `keys.ts`'s module comment and
  pinned as test constants so a future change to the algorithm is caught immediately.
- No existing assertion in any of the eight previously-passing test files (across both
  `apps/httpeers-stack` and `packages/httpeers.core`) was touched.

### Counts and verification

```
$ pnpm install                              # from the umbrella root, never from workspaces/statewalker-sandbox
Already up to date

# packages/httpeers.core (untouched by this task -- re-run as a baseline check)
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
 Test Files  8 passed (8)
      Tests  86 passed (86)
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' src/
src/hub/main.ts
src/setup/keys.ts
src/relay/main.ts
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' tests/
tests/setup.test.ts
```

**146 core (unchanged) / 69 → 86 app** (17 new, all in `tests/setup.test.ts` — 14 from
the initial pass plus 3 more from the `RELAY_HOST` address-family fix; the seven
previously-passing files — `admin.test.ts`, `chain.test.ts`, `hub.test.ts`,
`integration.test.ts`, `revocation-e2e.test.ts`, `search.test.ts`,
`static-server.test.ts` — are unmodified and still passing).

**Where libp2p imports live in `apps/httpeers-stack` now**: `src/relay/main.ts` (Task 9,
unchanged), `src/setup/keys.ts` (new — key generation/derivation needs
`@libp2p/crypto`/`@libp2p/peer-id` directly, exactly the surface the team lead's brief
authorized), and `src/hub/main.ts` (new as of this task's Step 4 — the same
`@libp2p/crypto`/`@libp2p/interface` surface `relay/main.ts` already used for its own key
loader, extended to the hub for the same reason). `httpeers.core`'s own isolation grep
(`src/tokens.ts`, `src/transport-duplex.ts`) is untouched — nothing in
`packages/httpeers.core` was modified by this task.

## Task 11: the browser peer runtime and the ServiceWorker edge

New files, all under `src/browser/`: `node-profile.ts` (the browser libp2p profile --
WebSockets + WebRTC + Circuit-Relay-v2, identity persisted per-origin in IndexedDB, the
relay dial and the poll-for-reservation split into two separate awaitable steps),
`join.ts` (the `/webrtc` pre-dial, invitation redemption, and the two timers this runtime
owns itself -- the heartbeat and the connection keepalive; the third, circuit-relay's own
reservation refresh, is libp2p-managed and has no code here on purpose), `edge.ts` (mounts
a peer's `dispatch` into `@statewalker/webrun-http-browser`'s `SwHttpAdapter` unchanged),
and `edge-guard.ts` (the key/prefix guard, factored out of `edge.ts` -- see "Deviations"
below), plus `peer-runtime.ts`'s `startBrowserPeer`, the orchestrator the brief's
"Produces" line names. No file in `packages/httpeers.core` or `apps/httpeers-protos` was
touched.

### Where readiness actually comes from

`node.dial(relayAddr)` resolving means the WebSocket link to the relay is open -- it says
nothing about whether the relay has finished granting a circuit reservation, which lands
asynchronously afterwards (design note 17 §4, and the validated relay test,
`notes/.../16-httpeers-prototype-v2-envelope-transport/src/relay.test.ts`, which this
task's poll loop repeats verbatim: `getMultiaddrs()` checked every 250 ms, up to 40
times). `node-profile.ts` therefore splits node construction (`createBrowserNode`), the
relay dial (`dialRelay`), and the reservation poll (`waitForCircuitReservation`) into
three separate steps rather than one opaque await, so `peer-runtime.ts` can report
`"connecting-relay"` and `"awaiting-reservation"` as genuinely distinct, observable
lifecycle states.

### The `/webrtc` pre-dial

`join.ts`'s `preDialPeer(node, relayAddr, peerId)` builds
`${relayAddr}/p2p-circuit/webrtc/p2p/${peerId}` and dials it explicitly. `peer-runtime.ts`
calls it once, against the hub, between constructing the peer (`createPeer({ node, ... })`)
and the first protocol call (`redeemInvitation`) -- libp2p's auto-dial may already hold a
relay-only LIMITED connection to the hub from address exchange alone, and a limited
connection silently refuses a custom protocol with no error naming the cause. A later task
dialling any OTHER mesh peer (discovered through `meshView()`) must call the same function
before its first `peer.call` to that peer, for the identical reason.

### The version-vector refetch

`join.ts`'s `startJoin` heartbeats every 5 s (`HEARTBEAT_INTERVAL_MS`), carrying this
peer's own `node.getMultiaddrs()` (read fresh on every beat, never cached) and its
advertisements. The response's `versions: { mesh, policy, vocabulary }` gates three
independent GETs -- `/.well-known/mesh`, `/.well-known/vocabulary`,
`/.well-known/revocations` -- each fetched only when its own counter has moved since the
last time this peer fetched it; the four version numbers (three plus this peer's own last-
seen watermark, x 3) are tracked in `startJoin`'s closure, not in a module-level or global
variable. `RevocationCache.update(version, entries)` is called on EVERY successful
heartbeat regardless of whether `versions.policy` moved -- gating the network fetch on the
version but not the cache's own freshness stamp, because a cache that only ever touched on
a version bump would go stale (and start refusing every token) during a long run of
"nothing changed" heartbeats; see `REVOCATION_MAX_STALENESS_MS`'s doc comment for the
arithmetic. Multiaddrs discovered through `meshView()` for some OTHER peer must never be
read from libp2p's own `peerStore` (usually local-only until that peer's own reservation
has landed) -- only from the mesh view the hub built out of that peer's own most recent
heartbeat; see `peer-runtime.ts`'s module comment.

### The three timers

Reservation refresh is entirely libp2p-managed (`circuitRelayTransport`'s own internal
renewal) -- no code for it exists in this task, deliberately: folding it into either of the
other two would conflate three questions ("is my reservation valid," "does the hub still
consider me a member," "is my connection to the hub open") that fail independently and
mean different things. The presence heartbeat (5 s) and the connection keepalive (10 s,
matching `workspaces/webrun-wire/apps/p2p-demo/server-page/main.ts`'s own precedent for
the identical purpose) are two separate `setInterval` timers in `startJoin`, each
independently stoppable via the returned `JoinHandle.stop()`.

### The key/prefix guard, and why it has its own file

`edge-guard.ts`'s `assertKeyMatchesPrefix(key, prefix)` throws unless `prefix`'s first
`/`-delimited segment equals `key` -- the exact trap design note 39 §3 found:
`SwHttpDispatcher` (the ServiceWorker side) keys a registration by the incoming URL's
first path segment, while `SwHttpAdapter.register` (the page side) matches the full base
URL; a mismatch reports success at every step while the handler is never called once.
`mountEdge` (`edge.ts`) calls it before constructing `SwHttpAdapter` at all. **This is a
deliberate deviation from the brief's literal two-file split** (`edge.ts` alone was named):
the guard is pure logic and needs no browser, per the team lead's override of the brief's
"no tests" line, but `edge.ts` itself imports `@statewalker/webrun-http-browser/sw` --
which, as below, only resolves once that package's `dist/` has actually been built.
Leaving the guard inside `edge.ts` would have made its own unit test hostage to that
package's build state for no reason connected to what the test is actually verifying.
Factoring it into its own dependency-free file lets `tests/browser-edge-guard.test.ts` run
regardless. `edge.ts` re-exports it, so nothing about the public shape changed.

### `@statewalker/webrun-http-browser`: the known defect, verified precisely

Confirmed exactly as the brief predicted: the workspace package (linked via
`workspace:*`, resolved to `workspaces/webrun-wire/packages/webrun-http-browser`) has NO
committed `dist/` (`workspaces/webrun-wire/.gitignore` ignores it), and its own
`package.json` `exports` map points `.`/`./sw` at `./dist/index.js`/`./dist/sw.js` with no
`"source"` condition to fall back to -- unlike `httpeers.core` and every sibling
`webrun-wire` package this task read, which point straight at `./src/index.ts`. Verified
by temporarily removing an already-built `dist/`:

```
$ mv workspaces/webrun-wire/packages/webrun-http-browser/dist /tmp/backup
$ pnpm exec tsc --noEmit   # in apps/httpeers-stack
src/browser/edge.ts(33,31): error TS2307: Cannot find module '@statewalker/webrun-http-browser/sw' or its corresponding type declarations.
```

Building the dependency's own package (`pnpm --filter @statewalker/webrun-http-browser
build`, or letting `turbo`'s `^build`/`^typecheck` dependency graph do it automatically --
verified both ways) makes the import resolve cleanly; typecheck is then clean with no
further changes needed. **This worktree currently has that `dist/` built** (as part of
this task's own verification), which is why `pnpm run typecheck`/`pnpm run test` both pass
in the commands below. A GENUINELY FRESH CHECKOUT WILL NOT: `turbo.json`'s `"test"` task
declares `dependsOn: []` (unlike `"build"`/`"typecheck"`, both `dependsOn: ["^build"]`), so
`turbo test --filter=@statewalker/httpeers-stack` on a fresh checkout fails at this
package's own `typecheck:tests` gate (its `test` script runs that first) with the same
`TS2307` above -- verified directly. Neither `turbo.json` (shared, umbrella-wide config)
nor `webrun-http-browser`'s own source (a different fragment) was touched to work around
this, per this task's scope; `pnpm --filter @statewalker/webrun-http-browser build` (or
running `turbo build`/`turbo typecheck` for this package first, which reaches the same
dependency) is the fix a fresh checkout needs before `pnpm test` succeeds here. Flagged to
the team lead as a real, load-bearing gap in the current pipeline, not merely recorded and
set aside.

### Deviations from the brief's literal shape

- **`edge-guard.ts` added** beyond the brief's four named files -- see above.
- **`startBrowserPeer`'s init carries more than the brief's four named fields**
  (`{ key, mounts, accessTree, onState }`): `invitationId` (nothing else in the brief names
  where the invitation a page redeems comes from), `dev` (required, no default -- the
  connection-gater relaxation local development needs and production must not carry;
  see `node-profile.ts`'s `CreateBrowserNodeInit.dev` doc comment for why this has no
  inferred default of its own), and optional `httpeersConfigUrl`, `serviceWorkerUrl`,
  `advertisements`. The brief's own signature line reads as illustrative, not exhaustive --
  none of these were omittable and still produce a working join.
- **`vocabulary` is `../policy.ts`'s `VOCABULARY`, not `httpeers.core`'s
  `DEFAULT_VOCABULARY`.** `createPeer` requires `accessTree`/`vocabulary` supplied
  together; the caller's `accessTree` must be evaluated against the SAME vocabulary
  `../hub/main.ts` mints tokens against (`VOCABULARY`, Task 8's `policy.ts`), or every
  role->capability expansion on this peer's own incoming requests is wrong. This mirrors
  `hub/main.ts`'s own choice exactly (see that module's own comment), not a new decision.

### What could not be verified without a browser

Nothing in `src/browser/` runs under Node -- IndexedDB, ServiceWorker registration,
`RTCPeerConnection`, and the browser-only libp2p transports (`@libp2p/webrtc`,
`@libp2p/websockets`, `@libp2p/circuit-relay-v2` client side) all require a real browser
context. Untouched by this task, deliberately, per the team lead's explicit scoping to
Task 15's Playwright suite: whether `waitForCircuitReservation` actually observes a
`p2p-circuit` address inside a real browser tab; whether the `/webrtc` pre-dial actually
prevents the limited-connection failure it targets; whether `mountEdge`'s registration is
actually reachable through a real `fetch()` from the page (i.e. that
`assertKeyMatchesPrefix`'s precondition, once satisfied, is sufficient and not merely
necessary); whether two tabs of the same origin collide the way design note 39 §6 predicts
(E-2, explicitly out of this task's scope); and the full join sequence end to end against
a running relay + hub. Everything here was checked as far as static typing and the one
piece of pure logic (the key/prefix guard) allow, and no further.

### Counts and verification

```
$ pnpm install                              # from the umbrella root, never from workspaces/statewalker-sandbox
Already up to date

# packages/httpeers.core (untouched by this task -- re-run as a baseline check)
$ pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.tests.json --noEmit
(clean, both)
$ grep -rlE "^import.*libp2p" src/
src/tokens.ts
src/transport-duplex.ts
$ pnpm exec vitest run
 Test Files  12 passed (12)
      Tests  146 passed (146)

# apps/httpeers-stack
$ pnpm exec tsc --noEmit && pnpm exec tsc -p tsconfig.tests.json --noEmit
(clean, both)
$ pnpm exec vitest run --no-file-parallelism
 Test Files  9 passed (9)
      Tests  93 passed (93)
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' src/
src/hub/main.ts
src/setup/keys.ts
src/relay/main.ts
src/browser/join.ts
src/browser/node-profile.ts
$ grep -rlE 'from "(@chainsafe/libp2p|@libp2p/|libp2p)' tests/
tests/setup.test.ts
```

**146 core (unchanged) / 86 → 93 app** (7 new, all in `tests/browser-edge-guard.test.ts`;
every previously-passing file is unmodified and still passing). `biome check --write`
applied to the new files (import ordering and line wrapping only; no logic change).

**Where libp2p imports live in `apps/httpeers-stack` now**: unchanged from Task 10
(`src/hub/main.ts`, `src/setup/keys.ts`, `src/relay/main.ts`) plus this task's two new
files, `src/browser/join.ts` (the `/webrtc` pre-dial and the keepalive timer's
`getConnections`/`peerIdFromString`) and `src/browser/node-profile.ts` (the browser
transport profile itself). `httpeers.core`'s own isolation grep (`src/tokens.ts`,
`src/transport-duplex.ts`) is untouched -- nothing in `packages/httpeers.core` was
modified by this task.
