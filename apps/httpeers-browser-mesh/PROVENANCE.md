# Provenance

What in this app is **recovered code**, what is a **reconstruction**, and what neither —
adopted 2026-09-09 from `notes/drive/2026-09-07.Sandclaw-Httpeers/code/`, per work unit
MESH-2 of `notes/2026/2026-09/2026-09-09/[umbrella-next].prototype-adoption.md`.

The distinction is never blurred. Recovered code is evidence of what the 7 September session
did; anything else is evidence only of what this adoption decided. Every recovered file is
pinned by the sha256 of the mirror byte stream it came from, so the claim is checkable.

**Nothing here was corrupt.** The export is plain files, so the question is not whether it
can be recovered but whether the recovered code satisfies what came with it. It does — with
one large caveat about the browser, set out under "What this app does not establish".

## Read this first: one file here is live, the rest are a prototype

| | Status |
|---|---|
| `src/relay-discovery.ts` | **LIVE CODE.** Implements what ADR-0023 ratified, and is deployed and verified end to end ([2026-09-08](../../../../notes/2026/2026-09/2026-09-08/httpeers-demo-sites-deployed.md)). A claim made about this file is a claim about something running. |
| `src/hub.ts` | **A prototype that duplicates shipped code on purpose**, and says so: note 08 §8 — "There are no tokens, no capabilities and no policy evaluation here. `httpeers.core` has all three and this test deliberately does not reimplement them." Membership is a bare `Set` of peer ids. **Do not promote it.** `packages/httpeers.core` and `apps/httpeers-stack/src/hub/` are the real thing. |
| `src/mesh.ts` | **A prototype, but not a duplicate.** Its subject is the relay/WebRTC path, which `httpeers.core` does not have — its own `errors.ts` says "this package has no relay transport". The three findings it encodes are the value. |
| `src/app.ts` | The page. Only reachable through `test:browser`, which has never run. |

## Per file

| File | Status | sha256 of the mirror copy |
|---|---|---|
| `tests/node-verify.mjs` | **recovered**, byte-identical, assertions unmodified | `fc7a58cbb0011c3023f4355fbec8817a77c071834b121db7ab982e6b726ec6f1` |
| `tests/browser.spec.ts` | **recovered**, byte-identical, **never executed** | `00787a80c4d15a7def6975ca6e7c06afb85a67969e52fd26680a64f724974dd3` |
| `src/mesh.ts` | **recovered**, byte-identical | `917c41aef46e1968fdaca0d68157404ce40de51414028f3e04c283292a423a7a` |
| `src/hub.ts` | **recovered**, byte-identical | `2a98e30004727441617decead255329228e5a61537101ce765215d921cd8c2ce` |
| `src/relay-discovery.ts` | **recovered**, byte-identical | `ac7d45f6f423e74e0432e9b06f742daca2942a5798a2f31698c437c9efbe23c7` |
| `src/app.ts` | **recovered**, byte-identical | `0796784ec180fc0f78350be21ee5dd31eb19a60d37718487ddd0fc4cdc24fa26` |
| `index.html`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts` | **recovered**, from `config-files.txt` — see below | — |
| `tests/hub.test.ts`, `tests/mesh.test.ts`, `tests/relay-discovery.test.ts` | **written here** | — |
| `tools/mutate.mjs` | **written here**, copied from `apps/httpeers-wire-protos` | — |
| `package.json`, `vitest.config.ts`, `tsconfig.tests.json`, `tsconfig.browser.json`, `.gitignore`, this file, `README.md` | written here | — |

**There is no adoption delta.** Unlike MESH-1, where `wire.ts` needed a type annotation, all
six recovered files typecheck exactly as exported — because this prototype *had* a
`typecheck` script and had run it.

The six recovered files are excluded from the formatter and linter in the root `biome.json`.
Their evidential value is being byte-identical to the export; `pnpm lint` would otherwise
rewrite them and the sha256 column would stop meaning anything. The three test files written
here are deliberately *not* excluded — they follow house style, which keeps the boundary
visible at a glance.

### `config-files.txt`, and the two notes moved out of it

The mirror ships four config files concatenated into one text file with each block's path
named. They are copied to those paths verbatim, with one change: **two prose notes that sat
between the blocks are moved into the files they describe**, because each explains a choice a
reader of that file needs.

- `DOM.Iterable` is load-bearing, not cosmetic: without it `@statewalker/webrun-http-streams`
  fails to typecheck with "Type 'Headers' must have a '[Symbol.iterator]()' method", because
  its `exports` points at TypeScript source that `skipLibCheck` does not cover.
- `dist-web` and `dist-node` must not share a directory: Vite empties its `outDir` on every
  build, so one build silently deletes the other's output.

`tsconfig.json` also gains `"noEmit": true`, since nothing here is built by `tsc`.

## Test counts per source file

| File | Tests | What runs |
|---|---|---|
| `tests/node-verify.mjs` | **13 claims** | two real libp2p peers over a circuit relay this script starts on loopback |
| `tests/hub.test.ts` | 44 | pure logic, no transport |
| `tests/mesh.test.ts` | 36 | real `startPeer`, three module boundaries mocked |
| `tests/relay-discovery.test.ts` | 28 | real loopback HTTP servers |
| **unit subtotal** | **108** | |
| `tests/browser.spec.ts` | 1 test, 6 named claims | **never executed** — see below |

```
pnpm test         → 108 passed | 1 skipped, then 13 claims all PASS
pnpm typecheck    → clean (src, tests, and the browser spec in its own program)
```

The one skipped test is deliberate and is **part of the finding**, not an exclusion: see
"The TOFU finding" below. `tests/relay-discovery.test.ts` is 28 passing + 1 pending.

**13, not 9.** Notes 08 §3 and 09 §2 both say "9/9"; note 10 §5 adds the four
relay-discovery claims and supersedes them, and `node-verify.mjs`'s own header says
"all thirteen claims pass". §4 of the work order describes the export as "1 Playwright spec
+ 1 Node verifier" without a count, so nothing there is wrong — but 9 is the number that
will be quoted by anyone who reads notes 08 or 09 and stops.

## `tests/browser.spec.ts` has still never been run

Adopted unchanged, and unexecuted. Its own header says so:

> STATUS 7 September 2026: WRITTEN AND TYPECHECKED, NEVER RUN. The machine it was authored
> on reaches only npm and GitHub, so relay.httpeers.net was unreachable from it. Treat the
> first run as the real test.

Nothing in this adoption changes that. It defaults to the deployed relay and needs a chromium
download, and neither was available here. **Nothing in this app is evidence about a browser**
— which is, per `mesh.ts`'s own module comment, exactly what the Node harness exists to make
true: it removes the browser, the public relay and ICE from the picture so that a browser
failure can be localised later.

**The same trap exists in the sibling app, and the two are worth reading together.**
`apps/httpeers-shell-protos/PROVENANCE.md` records `lib/browser-states.mjs` as **not
runnable** — undeclared Puppeteer, a Chromium download, a `dist/states.html` fixture that does
not exist, and a defect that must be fixed first. Two harnesses, two sessions, the same shape:
a file that reads as browser evidence to anyone who does not open it. Note 39 of the shell
session is the reason it matters — the 7b theme bridge passed every unit test and did not work
in a browser.

The six claims it would check, none of which is established:

- the relay's addresses were discovered from its URL *by a real tab, across origins*
- the guest obtained a reservation on the public relay
- a peer that has not joined is refused
- the guest redeemed the invitation
- the guest consumed the hub's resource
- the guest's own resource is advertised in the mesh view

## Proving the suite — the mutation pass (§5.3)

**60 mutations, 60 killed, 0 surviving.** 59 through `tools/mutate.mjs`, plus one ordering
mutation the harness cannot express, applied by hand (below). The control run is green with a
parsable tally before any mutant is applied, and a run whose tally does not parse is reported
as `HARNESS-ERROR` rather than `KILLED` — both guards inherited from
`apps/httpeers-wire-protos/tools/mutate.mjs`, which earned them by reporting 27 of 27
mutants killed when in fact no test had run at all.

`tools/mutate.mjs` adds one thing for this app: a mutant that survives the **unit** suite is
re-run against the **adopted** harness and reported as `SURVIVED-UNIT/KILLED-INT` when the 13
claims catch what the unit tests missed. That distinction is §4's point — "that is
integration coverage, not unit coverage" — made mechanical. In the final run no mutant
reached it.

That was not true of the first run. **Four of the six things the first pass turned up were
defects in the new tests, not gaps**, and three were only visible because the mutation ran:

| First-pass result | What it actually was |
|---|---|
| **H15 survived both suites** — base64url stops replacing `+` and `/` | **A vacuous test.** A realistic `invitationId` is itself base64url, so plain base64 of a realistic blob contains neither `+` nor `/`, and an alphabet assertion over one tests nothing. The test now uses an input chosen so that plain base64 emits **both**, and **asserts that precondition**, so it fails loudly rather than going vacuous if that ever stops holding. |
| **M4 survived both suites** — `reusablePeer`'s `catch` removed | **A real masking effect, found by the mutation.** The `catch` runs inside `fetch`'s outer `try`, so a propagating throw is caught by the **retry**, which dials the same multiaddr anyway. The malformed-address assertion passes either way. What *is* observable is the retry's side effect — it closes every limited connection first — so a malformed address would silently cost this peer its circuits. The new test asserts "one dial, nothing closed". |
| **M14 survived both suites, twice** — the response body is not buffered before `close()` | **A double that could not express the hazard.** First version: a one-chunk stream is fully buffered inside the `Response` by the time anyone reads it, so `close()` cannot truncate it. Second version errored the stream on teardown but still delivered one chunk, so it still could not distinguish. The double now delivers **two** chunks and does not finish inside the first `pull`, which is the shape a real transport has — and `close()` errors it in the window between. |
| **M20 survived** — one handler for every stream | **A badly designed mutation**, not a gap: it assigned to a shared variable but left the inner handler reading `remotePeer` from its own closure, so it changed nothing. Rewritten to actually read the shared value. |
| M5, M9 and two others reported `BAD-PATCH (0 matches)` | `mesh.ts` uses semicolons and four multi-line patterns were written without them. The harness's match-count guard caught all four rather than scoring them as kills. |

One more defect the pass surfaced indirectly: the M14 double used a `tick()` helper that was
never defined in `tests/mesh.test.ts`, which made the *unmutated* control go red. The test
typecheck (`tsconfig.tests.json`) catches this; it had not been re-run after the edit.

### One thing the pass broke, and how it was caught

A mutation run piped through `head -2` left **mutant M22 applied on disk** — `addresses: {
listen: [] }` instead of `["/p2p-circuit"]` — and that one-line mutation was committed.
Closing stdout raised EPIPE, the process died on SIGPIPE, and `process.on("exit", restore)`
never ran, so the harness's restore was skipped for the mutant it was holding.

It was caught within the minute, by the byte-identity check against the read-only mirror that
every commit here runs, and the commit was amended. Two things follow:

- `tools/mutate.mjs` — in **both** apps — now restores on `exit`, on `SIGINT`/`SIGTERM`/
  `SIGHUP`/`SIGPIPE`, and on `uncaughtException`, swallows `stdout` errors so a closed pipe
  cannot be what stops the restore, and prints a reminder to check `git status` on the way
  out. The header says why, with the incident named.
- **The real guard was the byte-identity check, not the harness.** A harness that edits
  source in place can always be killed between the edit and the restore; diffing the adopted
  files against the mirror before committing is what makes that recoverable rather than
  silent. Keep doing it.

### The mandatory shapes

**Final-iteration paths.** H8 (mesh view drops the last advertisement), H9 (drops the last
member), M11 (`dialAnyRelay` drops the last failure from its report), R4 (only the first
published address validated), R5 (the last published address skipped). All killed, and four
of the five by tests that name the last element explicitly — `node-verify.mjs` has exactly
one guest and serves exactly one relay address, so every fan-out in the export was only ever
exercised at length 1.

**Symmetric pairs.** H1/H2 (membership and advertisement both keyed on proven identity),
H6/H7 (the gate refuses non-members / still admits them to the invite route), H12/H13 (method
is part of the route, on both handlers), H17/H18 (the two halves of `joinMesh`'s refusal
condition), H20/H21 (both messages carry this peer's own address), M2/M3 (finding two undone
in each direction), M6/M7 (the retry closes limited connections / leaves unlimited ones
alone), M12 (`/webrtc` preferred over the plain circuit, and the fallback), M15/M16
(statusText and headers carried across the rebuild), M17 (`close()` on the failure path as
well as the success path), M18/M19 (`runOnLimitedConnection` on the serving *and* dialling
ends — the record names this as a both-ends property), R2/R3 (zero `/p2p/` and two `/p2p/`).
All killed.

M6/M7 is the one worth singling out. Closing *every* connection rather than only limited ones
passes any test that holds a limited one — and in the case this code exists for, a browser
pair that has upgraded to WebRTC holds an **unlimited** connection, so the mutation would
throw away the upgrade the whole design is for. The record does not state that anywhere; it
follows from `connection.limits != null`, and only a both-sides test catches it.

### The ordering mutation, by hand

`tools/mutate.mjs` replaces one string at a time, so it cannot reorder two statements.
`startPeer` registers its handler **before** it dials the relay, which matters because the
reservation is what makes the peer reachable: serving afterwards leaves a window in which a
dial succeeds and nothing answers. Verified manually by making `serveConnections` lazy and
awaiting it after the dial — 3 tests fail, including "serves BEFORE reserving, so no inbound
stream can arrive unhandled" by name. `src/mesh.ts` was restored and re-verified
byte-identical afterwards.

## The TOFU finding: ADR-0023's pin-on-first-use has no implementation — umbrella #27

§4 of the work order names this as mandatory before `relay-discovery.ts` moves anywhere:

> The test that must exist before it moves anywhere is the **TOFU inversion**: a compromised
> first contact pins the attacker's peerId permanently, after which the fail-loud rule fires
> against the *legitimate* relay.

That is ADR-0023 § Consequences, quoted almost exactly — and ADR-0023 goes further: "A
deliberate, human-initiated re-pin path is therefore **mandatory**, and it must never be
triggered by the relay, the document, or a field inside it."

**`relay-discovery.ts` implements no pinning.** `resolveRelayAddrs` fetches the document,
checks `assertPinnable`, and returns. There is no stored peer id, no comparison against a
previously-seen one, and no re-pin path. So:

1. **There is no first use to pin on.** It is trust-on-*every*-use. An attacker who controls
   the document at **any** moment substitutes the relay's identity, not only one who controls
   first contact — so the exposure is *wider* than the ADR's own worst case, not narrower.
2. **The fail-loud rule cannot fire**, because there is no stored value to compare against.
   The inversion ADR-0023 describes is therefore not "inverted" but **absent**.
3. **The mandatory re-pin path does not exist**, because nothing is pinned. The module's
   export surface has nowhere to put one.

`assertPinnable` is not the pin. It makes an address *pinnable* — exactly one peer id, so
Noise can verify it on that dial. That is per-dial authentication and says nothing across
time. Note 10 §2's "that peer id is … what the client pins" is true of Noise, not of storage.

Checked before claiming it is unimplemented anywhere: `apps/httpeers-stack` has
`src/browser/mesh-memory.ts` and `describeMeshDrift`, which remember `{relayAddrs,
hubPeerId}` and detect a changed **hub** peer id. That is not this. `mesh-memory.ts` says in
its own header "nothing here is a credential"; the drift check produces an explanatory
message rather than a refusal; only `hubPeerId` is compared, with `relayAddrs` stored and
never checked; and it is a different mechanism entirely — `httpeers-stack` reads
`httpeers.json` from the **page's own origin**, naming both relay and hub, whereas ADR-0023's
document is served from the **relay's** origin and names only the relay.

### How the tests are written: two parts, because a permanently-red suite gets deleted

**Part 1 — characterisation, 5 tests, passing.** They pin what the code does today, following
the pattern `apps/httpeers-shell-protos/PROVENANCE.md` uses for the defects it found: "Pinned
by tests that assert the current behaviour, so each will turn red when fixed — deliberately,
so a fix cannot land silently." Each is named for the ADR requirement it stands in for.

The inversion scenario is run for real: first contact serves the attacker's peer id, the
legitimate relay then serves its own, and the second call **resolves** where ADR-0023 requires
it to fail loud. A second test shows the identity changing back and forth with no complaint. A
third shows two relays resolved in sequence not interfering, because neither writes anything
down. A fourth asserts the module exports no pin store and no re-pin accessor — it passes by
demonstrating an absence, **so a green run there must not be read as covering the
requirement**. A fifth shows `assertPinnable` accepts the attacker's address as readily as the
legitimate one.

**Which of them are actually tripwires was measured, not assumed.** A throwaway pin store was
applied to `relay-discovery.ts` and the suite re-run (then reverted, and byte-identity
re-verified):

| Test | Under an implementation that pins |
|---|---|
| "there is no first use…" | **RED** |
| "trust-on-EVERY-use…" | **RED** |
| "exports no pin store…" | RED once a re-pin accessor joins the export surface |
| "resolveRelayAddrs is pure…" | stays green — it is not about storage |
| "assertPinnable checks SHAPE…" | stays green — it is not about storage |

So **two of the five are the tripwire**, and a third fires on an API change. The remaining two
are characterisations that stay true under pinning; they exist to make the mechanism's absence
legible, not to raise an alarm. The test file states this distinction in place, so nobody reads
"5 characterisation tests" as "5 alarms".

**Part 2 — one explicitly-pending test, skipped and visible in the runner output.** It quotes
ADR-0023's Consequences clause verbatim, says in its own name that the requirement is ratified
and **unimplemented**, cites #27, and writes out the assertions the ratified design requires —
including that the inversion must fail loud *against the legitimate relay*. §3 of the work
order sanctions exactly this shape: carry a known hole forward "as failing or
explicitly-pending tests rather than silently inheriting them".

`pnpm test` therefore reports `108 passed | 1 skipped` and is both green and honest: neither
the gap nor its status is inferable-only. **The pending test must not be deleted to tidy the
output**, and must not be made to pass by writing a pin store in this app.

**What was deliberately not done:** inventing a pin store to make a green test. That would be
designing a security mechanism under cover of a test adoption, and ADR-0023 deliberately
constrains the re-pin path as a human-initiated decision — so it is ADR territory, which is
why #27 is filed `ready-for-human`. Reconciling the ADR with the shipped code is routed
separately; nothing under `docs/httpeers/` was touched here.

## A finding from the typecheck

`tests/browser.spec.ts` and `src/app.ts` both `declare global` a `Window.__mesh`, with
structurally different types — the spec's own `MeshState` versus the app's inline shape. One
TypeScript program containing both fails with **TS2717, "Subsequent property declarations
must have the same type"**.

The export's own tsconfig includes only `src/**/*.ts`, so the spec and the app were never
compiled together and the clash stayed latent. That is how note 08 §3's "written and
typechecked" was true and still left this behind.

Neither file is editable here, so they are typechecked in **separate programs**:
`tsconfig.tests.json` excludes the spec, `tsconfig.browser.json` compiles it alone. Both
configs say why in place. If the spec is ever run, this is the first thing to reconcile —
whichever declaration loses, one of the two files has to change.

## What this app does not establish

**Anything about a browser.** See above. This is the largest gap and it is the same one notes
08 §9 and 09 §5 name as the next action.

**The five-call ceiling is mitigated, not understood.** Note 08 §4: a reused raw circuit stops
accepting new streams after exactly five calls, while `connection.limits` shows ~52.4 MB of
budget remaining and the connection still `open`; raising the relay's limits to 50 MB and 10
minutes does not change the count, and closing each call's streams does not either. It
surfaces as `EncryptionFailedError: The operation was aborted due to timeout`, which names
encryption and has nothing to do with it. `mesh.ts` retries once on a fresh dial, which is
behaviour a real client needs anyway since circuits expire. **The cause is not understood**,
and note 09 §5 lists investigating it as action 3. Nothing here investigates it: the unit
tests prove the *mitigation* behaves as described, which is a different claim.

**`@statewalker/webrun-*` still cannot be imported from plain Node.** Note 08 §6: all three
packages declare `exports: { ".": "./src/index.ts" }` — TypeScript source, with a built
`dist/` present but unreferenced — and Node refuses it with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` because type stripping is disabled under
`node_modules`. Still true of the published `0.1.1`/`0.2.1` this app installs, which is why
`verify:node` must esbuild-bundle first. The real fix is upstream: point `exports` at `dist`.

**No tokens, no capabilities, no policy.** Deliberate, per note 08 §8. Membership is a set of
proven peer ids. Anything that needs authorization needs `httpeers.core`.

**The guest gates nothing.** `guestHandler` answers `/echo` for any proven peer, member or
not. Pinned by a test, because whether that is right is a design question and the current
answer should not be discoverable only by surprise.

**iOS Safari behind carrier-grade NAT** — note 09 §5's "dominant untested risk". Untouched.
