# httpeers-browser-mesh

> ## ⚠ `tests/browser.spec.ts` HAS NEVER BEEN RUN. There is no browser coverage here.
>
> Not by the session that wrote it, and not by this adoption. Its own header, unchanged:
>
> > **STATUS 7 September 2026: WRITTEN AND TYPECHECKED, NEVER RUN.** The machine it was
> > authored on reaches only npm and GitHub, so relay.httpeers.net was unreachable from it.
> > Treat the first run as the real test.
>
> **An unexecuted Playwright spec sitting in a repo reads as browser coverage to everyone who
> does not open it.** That is the same trap as `apps/httpeers-shell-protos`'s
> `lib/browser-states.mjs`, which that app's `PROVENANCE.md` records as **not runnable** —
> undeclared Puppeteer, a Chromium download, a `dist/states.html` fixture that does not exist,
> and a defect that has to be fixed first. Two harnesses, two repos, the same shape: a file
> that looks like evidence and is not. Cross-referenced deliberately.
>
> What IS evidence: the **13 adopted claims**, which run two real libp2p peers over a circuit
> relay this repo starts on loopback, and pass. `mesh.ts`'s own module comment says that is the
> point — the Node harness removes the browser, the public relay and ICE from the picture, so
> that a browser failure can later be localised rather than guessed at. The isomorphism claim
> itself remains unasserted.
>
> Two more things before you read further. **`src/hub.ts` must never be promoted** — it
> duplicates `packages/httpeers.core` and `apps/httpeers-stack/src/hub/` on purpose; see
> "What this duplicates". And **`src/relay-discovery.ts` is live, deployed code**, whose
> ratified pin-on-first-use requirement it does not implement — **umbrella #27**.

Two in-browser peers meeting over a relay: one tab declares itself a hub, the other joins by
invitation, and **each consumes a resource the other provides**. Neither tab installs
anything and neither has a listening socket. The only server is the relay, and after ICE it
is not in the data path.

The reverse direction is the point. Note 08 §3: *"Claim 9 matters most: a guest that could
only consume would be a client, and this architecture has no clients."*

## Running it

```bash
pnpm test            # 108 unit tests, then the 13 adopted claims
pnpm test:unit       # the unit tests alone (typecheck + vitest)
pnpm verify:node     # the adopted harness alone — esbuild bundle, then two Node peers
pnpm typecheck

pnpm test:browser    # NEVER RUN. Needs relay.httpeers.net and a chromium download.
pnpm dev             # the page, for looking at two tabs by hand
```

| Suite | Count | What runs |
|---|---|---|
| `tests/node-verify.mjs` | **13 claims** | real libp2p, real Noise, a circuit relay this script starts on loopback. Adopted verbatim. |
| `tests/hub.test.ts` | 44 | the hub and guest handlers, `joinMesh`, the join blob — no transport at all |
| `tests/mesh.test.ts` | 36 | the real `startPeer`, with three module boundaries mocked |
| `tests/relay-discovery.test.ts` | 28 | real loopback HTTP servers serving the bootstrap document |
| `tests/browser.spec.ts` | 1 test / 6 claims | **unexecuted** |

`verify:node` must bundle with esbuild before it runs, and that is not incidental: all three
`@statewalker/webrun-*` packages declare `exports: { ".": "./src/index.ts" }`, and Node
refuses TypeScript source under `node_modules` with
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Vite compiles it happily, which is why the
page needs no equivalent step. Note 08 §6; still true of the published versions this app
installs.

`PROVENANCE.md` is the index: recovered versus written, sha256 per recovered file, test
counts, the full mutation table, and what is not established.

## Where this came from

The 7 September 2026 session in `notes/drive/2026-09-07.Sandclaw-Httpeers/`. Read note 08
("Two Tabs, One Mesh") for the nine original claims and the three findings, and note 10 for
relay discovery, which supersedes note 07 §4 and adds four more claims — **13, not the 9/9
that notes 08 and 09 report.**

### The three findings note 08 records, and where each one lives now

**One: the five-call ceiling.** A reused raw circuit stops accepting new streams after exactly
five calls, while `connection.limits` still shows ~52.4 MB of budget and the connection is
`open`. Raising the relay's limits to 50 MB and 10 minutes does not change the count; nor does
closing each call's streams. It surfaces as `EncryptionFailedError: The operation was aborted
due to timeout`, which names encryption and has nothing to do with it. `mesh.ts` retries once
on a fresh dial, dropping limited connections first — which a real client needs anyway, since
the deployed relay expires circuits after five minutes. **The cause is still not understood**
and note 09 §5 lists investigating it as an open action. The unit tests prove the mitigation
behaves as described; that is a different claim from understanding the bug.

**Two: address for first contact, peer id afterwards.** Dialling a circuit multiaddr always
asks the relay for a *new* hop even when a connection to that peer is open, so two peers that
call each other accumulate circuits until one times out. Passing the **peer id** lets libp2p
reuse what it holds, in either direction. `mesh.ts` resolves the trailing `/p2p/<id>`, checks
`getConnections`, and falls back to the multiaddr only when nothing is connected. Unit-tested
on both sides, plus the case that matters most: the match must be **anchored at the end**,
because a circuit address is `/…/p2p/<relay>/p2p-circuit/p2p/<target>` and an unanchored match
would reuse the connection to the *relay* and send the request to the wrong peer.

**Three: `@statewalker/webrun-*` cannot be imported from plain Node.** See above.

Note 08 §7 also re-encounters the libp2p 2.x/3.x trap that MESH-1 met: 3.x hands stream
handlers `(stream, connection)`, and destructuring the 2.x `{ stream }` produces a silent
timeout at the *dialer*. Here it is `serveConnections` that absorbs it.

## The TOFU inversion: a ratified requirement with no implementation (umbrella #27)

§4 of the work order names one test as mandatory before `relay-discovery.ts` moves anywhere —
the TOFU inversion from [ADR-0023](../../../../docs/httpeers/adr/0023-the-relay-describes-itself-and-nothing-else.md):

> Trust becomes pin-on-first-use, and its failure mode inverts. … a compromised first contact
> pins the *attacker's* identity permanently — and the fail-loud rule then fires against the
> **legitimate** relay. … A deliberate, human-initiated re-pin path is therefore mandatory.

**`relay-discovery.ts` implements no pinning.** It fetches the document, checks
`assertPinnable`, and returns. No stored peer id, no comparison, no re-pin path. The
consequences are not milder than the ADR describes but **worse**:

- There is no first use to pin on, so it is trust-on-**every**-use: an attacker controlling
  the document at *any* moment substitutes the relay's identity, not only one controlling
  first contact.
- The fail-loud rule cannot fire, because nothing is stored to compare against. The inversion
  is not inverted; it is absent.
- The mandatory re-pin path does not exist, because nothing is pinned.

`assertPinnable` is **not** the pin — it makes an address *pinnable* (exactly one peer id, so
Noise can verify it on that dial). That is per-dial authentication and says nothing across
time.

`tests/relay-discovery.test.ts` carries this in **two parts**, because a permanently-red suite
gets ignored and then deleted:

**Part 1 — characterisation (5 tests, passing).** They pin what the code does today, so a
change of contract cannot land silently. The inversion scenario is run for real: the
attacker's document first, the legitimate relay's second, and the second call **resolves**
where the ADR requires it to fail loud. Which of them are actually tripwires was *measured*,
by applying a throwaway pin store and watching the suite — not assumed:

| Test | Under an implementation that pins |
|---|---|
| "there is no first use…" | **red** |
| "trust-on-EVERY-use…" | **red** |
| "exports no pin store…" | red once a re-pin accessor is added |
| "resolveRelayAddrs is pure…" | stays green — not about storage |
| "assertPinnable checks SHAPE…" | stays green — not about storage |

So the tripwire is the first two. The other three make the absence legible; they are
characterisations, not alarms, and the file says so in place.

**Part 2 — one explicitly-pending test (skipped, visible in the runner).** It quotes
ADR-0023's Consequences clause in full, states that the requirement is ratified and
unimplemented, cites #27, and spells out the assertions the ratified design requires — so the
gap appears in `pnpm test`'s output rather than being inferable only from prose. §3 of the
work order sanctions exactly this shape: carry a known hole forward "as failing or
explicitly-pending tests rather than silently inheriting them".

`pnpm test` therefore stays green and honest. **Do not delete the pending test to tidy the
output**, and do not make it pass by writing a pin store here.

A pin store was **not** invented to make a green test. That would be designing a security
mechanism under cover of a test adoption, and ADR-0023 deliberately constrains the re-pin path
as a human-initiated decision — so it is ADR territory, which is why #27 is `ready-for-human`.

## What this duplicates, and what it does not

- **`src/hub.ts` duplicates shipped code on purpose.** Note 08 §8: *"There are no tokens, no
  capabilities and no policy evaluation here. `httpeers.core` has all three and this test
  deliberately does not reimplement them: the claim under test is that two tabs can reach
  each other through a public relay and exchange resources, and mixing an authorization model
  into that would mean a failure could be either thing."* Membership is a bare `Set` of proven
  peer ids. It is the right choice for the experiment and the wrong thing to promote.
- **`src/relay-discovery.ts` duplicates nothing.** ADR-0023's relay-published
  self-description is not implemented anywhere else in this repo. `apps/httpeers-stack` reads
  `httpeers.json` from the **page's own origin**, naming both relay and hub; this document is
  served from the **relay's** origin and names only the relay — "describes itself, and nothing
  else". This is the one genuinely new mechanism in the export, which is also why the TOFU
  gap above matters rather than being academic.
- **`src/mesh.ts` duplicates nothing either.** Its subject is the relay and WebRTC path, and
  `packages/httpeers.core`'s own `errors.ts` says "this package has no relay transport".

## Re-running the mutation pass

```bash
node tools/mutate.mjs              # all 59 mutants
ONLY="H8,M6,R5" node tools/mutate.mjs
```

60 mutations, 60 killed, 0 surviving — 59 through the harness plus one ordering mutation
applied by hand, because the harness replaces one string at a time and cannot reorder two
statements. Table and analysis in `PROVENANCE.md`.

**Copy `tools/mutate.mjs` for the next unit rather than writing a new one, and keep its two
guards.** It runs an **unmutated control first** and refuses to proceed unless that is green
with a parsable tally, and it reports any run whose tally line did not parse as
**HARNESS-ERROR rather than KILLED**. Both exist because the first version of this harness, in
`apps/httpeers-wire-protos`, reported 27 of 27 mutants killed while in fact no test had run at
all — `--reporter=basic` does not exist in Vitest 4, so every run died loading the reporter and
exited non-zero. A harness that cannot tell "the suite failed" from "the suite never ran" will
always tell you your tests are perfect.

This app's copy adds one thing: a mutant that survives the **unit** suite is re-run against the
**adopted** harness and reported as `SURVIVED-UNIT/KILLED-INT` if the 13 claims catch what the
unit tests missed. That is §4's "integration coverage, not unit coverage" made mechanical.

It paid immediately, and mostly by finding defects in the *new tests* rather than gaps in the
code: a vacuous base64url assertion, a stream double that could not express the hazard it was
named for (twice), a mutation that changed nothing, and a real masking effect where
`reusablePeer`'s `catch` is covered for the wrong reason by the retry's `catch`. All five are
written up in `PROVENANCE.md`.

## Versions

Pinned from the export's own `package.json`. Every libp2p-side pin is already in this
workspace's `pnpm-lock.yaml` at exactly that version, because `apps/httpeers-stack` and
`packages/httpeers.core` independently converged on the same set —
`libp2p 3.3.8`, `@chainsafe/libp2p-noise 17.0.0`, `@chainsafe/libp2p-yamux 8.0.1`,
`@libp2p/circuit-relay-v2 4.2.11`, `@libp2p/identify 4.1.12`, `@libp2p/interface 3.2.5`,
`@libp2p/peer-id 6.0.14`, `@libp2p/webrtc 6.0.29`, `@libp2p/websockets 10.1.19`,
`@multiformats/multiaddr 13.0.3`. The three `@statewalker/webrun-*` packages are pinned to
the exact versions note 08 §2 names (`0.2.1`, `0.1.1`, `0.1.1`) rather than `catalog:`,
because the export states those versions as part of its result and the catalog's carets would
let them drift.

`@types/node`, `typescript`, `vite` and `vitest` use `catalog:`. The export pinned
`typescript 5.7.2`, `@types/node 22.10.2` and `vite 6.0.7`; none is load-bearing here (nothing
uses the compiler API, which is what forced `5.9.3` in `httpeers-shell-protos`), and the
catalog's versions typecheck the recovered sources with no delta at all. Three additions the
export did not declare: `esbuild` (it relied on Vite's transitive copy, and `build:node`
invokes it directly), `@libp2p/crypto` (test-only, to generate real peer ids rather than
hardcode them), and `vitest`.
