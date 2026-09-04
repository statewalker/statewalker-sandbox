# Provenance

What in this app is **recovered code**, what is a **reconstruction from a note**, and
what neither — restored 2026-09-04 from the Drive session
`notes/drive/2026-09-02.Httpeers-Shell/`.

The distinction is load-bearing and is never blurred here: recovered code is evidence
of what the September ladder did, a reconstruction is only evidence of what its notes
say. Every file carries a header saying which it is.

## Why some rungs had to be rebuilt

Four of the eleven Drive archives **do not decompress**. Note 39 predicted exactly
this — *"binary uploads to Drive proved unreliable at these sizes; source uploaded as
text worked every time. Some archives exist only locally."* The local copies no longer
exist; the whole machine was searched. `09-prototype-01-headless-host.tar.gz` yields
its `package.json`, README and rolldown config and loses all of `src/`;
`14-prototype-05-activation-events.tar.gz`, `26-prototype-04a-zod-static-schema.tar.gz`
and `26-prototype-Z-static-schema-derivation.tar.gz` yield nothing at all.

Separately, the tests for rungs 6, 7, 7a, 7b and 9 were **never uploaded**:
`lib/ORIGIN.md` refers to `layout.test.ts` and friends as living "in the local
archive, not uploaded individually". Their code survives in `shell-core`; their
71 tests do not.

## Per rung

| Rung | Code | Tests | Count |
|---|---|---|---|
| `01-headless-host` | reconstructed — notes 10, 11, 03, 06, 07 | written fresh | 85 |
| `02-a2ui-renderer` | `lib/` | recovered (1 assertion corrected) | 16 |
| `03-a2ui-binding` | `lib/` | recovered + 4 reconstructed | 21 |
| `04-manifest-generation` | **recovered**, byte-for-byte | **recovered**, assertions unmodified | 9 |
| `05-activation-events` | reconstructed — note 16 §3 | written fresh | 15 |
| `06-same-module-any-host` | `lib/mount.ts` | written fresh | 14 |
| `06a-tailwind-build` | **recovered**, byte-identical (sha-verified) | none — a build-and-measure rung | — |
| `06b-basecoat-mapping` | `lib/` | recovered (1 corrected) + reconstructed | 24 |
| `07-dockview-hosting` | `lib/dock.ts`, `lib/theme-bridge.ts` | written fresh | 41 |
| `08-biscuit-enablement` | **recovered** | **recovered**, all 23 unmodified, + 6 | 29 |
| `09-apps-from-peers` | `lib/peer.ts` | written fresh | 22 |
| `Z-static-schema` | reconstructed — note 29 | written fresh | 21 |

**297 tests, 24 files.** `lib/` is `code/shell-core/` verbatim and was not edited.

Where a count differs from the September record, it is a **different suite, not a
continuation**, and the rung README says so. Rung 01 replaces 40 tests with 85; rung
05 replaces 9 with 15 because note 16 states ten contract claims that nine tests
cannot span, and nothing records which nine the original chose.

## Two archived assertions were corrected, both stale

Both encode a model rung 7 later disproved — the drift `ORIGIN.md` describes as
invisible while the copies are isolated, and a failure the moment they meet.

- **Rung 02**, "renders a button with its label child": asserted
  `data-variant="primary"`. Rung 2's renderer echoed the message's variant verbatim;
  `lib/basecoat.ts` omits the attribute for primary, per note 32's table.
- **Rung 06b**, "maps each button variant to a distinct Basecoat class": asserted three
  distinct class strings. Verified against the shipped `basecoat-css@1.0.2` —
  `btn-secondary` and `btn-destructive` exist only in the *compat* stylesheet, while
  `.btn[data-variant=…]` is what the real pack styles.

Both originals are quoted verbatim at their sites. The 6b replacement is **stricter**
than what it replaced.

## Open defects in `lib/`, found by restoring the rungs

Pinned by tests that assert the **current** behaviour, so each will turn red when
fixed — deliberately, so a fix cannot land silently.

1. **`createAppHost` accepts `onAction` and ignores it.** Actions are wired at renderer
   construction, which only `mountStandalone` does; `lib/dock.ts` builds each pane's
   renderer with no options. A module in a Dockview pane renders and holds data
   correctly and **its buttons are dead**. (06, test 11)
2. **The note-35 theme bug is still present.** `lib/dock.ts` hard-codes
   `theme: themeLight`, so Dockview writes its own class on the inner `.dv-shell` — a
   nearer ancestor of pane content than the host — and the bridge class always loses.
   `lib/theme-bridge.ts` never exports the `shadcnTheme()` helper note 35 introduced as
   the fix. The session found this bug, wrote the fix in a note, and the fix never
   reached the consolidated code. (07, claims 30/31)
3. **`ShellDock` cannot be re-themed after construction**, so the dark-mode hole cannot
   be closed by a caller. `dockview.updateOptions({ theme })` works — a missing method,
   not a Dockview limit. (07)
4. **Typography was left behind by finding 5.** Layout moved to shell-owned classes
   because the prebuilt pack has no Tailwind utilities; `Text` still emits `text-sm`,
   `tracking-tight` and friends, which that pack does not define. Variants are distinct
   but **unstyled** on the zero-build path. (06b, test 20)
5. Minor: `fromJSON` recovers origins twice, so no test can tell which path supplied the
   value; and `mountPeerApp` ships the whole `dataModel` snapshot back with every
   action — defensible, since it is the peer's own surface, but undocumented.

## Corrections to the notes

Found by implementing what they say. The code is right in every case; the prose is not.

- **Note 18 §5's performance figures do not reproduce, and the finding is worse than
  recorded.** "The Biscuit Authorizer is single-use" is a *timing artefact*: cold, the
  second `query()` fails 10/10; warm, it failed 1/200. So reuse passes its own tests on
  a warm engine and fails on a user's first click. The thrown value is also **not an
  `Error`** — a bare `{"RunLimit":"Timeout"}`, so `e.message` is `undefined`. Measured
  cost is ~0.28 ms/eval and 8.3 ms per 30-entry menu against the recorded 0.586/17.6 —
  faster absolutely, but the stub sped up more, so the ratio widened from ~8× to ~44×.
  The "caching is required" conclusion survives on the ratio, not on the 17.6 ms.
- **Note 29's "counterintuitive result" is a mis-comparison.** Its 22 KB-built vs
  12 KB-prebuilt sets the full style pack against the *bare* pack, which has no
  `data-variant` selectors at all. Like for like: 22,158 vs 21,867 bytes — **1.3%, not
  45%**. Shipping prebuilt still wins, on the build step rather than the bytes.
- **Note 29 contradicts itself**: the prose says three tests failed on first run, the
  table lists two. The third is unrecorded and cannot be confirmed reproduced.
- **Note 24's reconciliation contract is out of date** — "an element is rebuilt only
  when the component type at that id changes" was disproved by 6b, since `Text`'s
  variant selects the tag.
- **Note 16's recognition rule 3 is backwards**: the policy is the *innermost* chain
  link, not the outermost.
- **Note 31's "CSS never injected"** is true of the ESM entry, false of the standalone
  build, which appends a `<style>`.
- **Note 35/38 understate the `colorScheme` hole**: in Dockview 8.2.0 it is **never read
  at all** — all 18 occurrences are object-literal keys. It is advisory metadata the
  embedder must act on.
- **Note 39 undercounts `.int()`** — Zod also emits `minimum: -9007199254740991` — and
  an explicit bound *replaces* rather than narrows that range.
- **Note 06's `--experimental-wasm-modules` claim is stale**, as note 18 §3 already
  said: `biscuit-wasm` imports with no flag on Node v24.8.0.
- Rung 05's "a plain synchronous return does not claim a command" is enforced by the
  shipped `@statewalker/shared-commands` bus, not by the host — rung 5 *inherits* the
  property rather than establishing it.

## What this app still does not establish

Restoration does not close the ladder's gaps, and note 38 remains the honest inventory.
The sharpest, carried in rung 09's README: the catalogue bounds *what* a peer may
express, and **nothing checks whether a peer may serve you an application at all**. A
test mounts an app from an entirely unknown peer, asserts it renders, and asserts at the
API surface that `mountPeerApp` has no parameter through which a capability could be
supplied — passing by demonstrating the absence, so a green run cannot be read as
covering it.

Nothing here is a browser test. `lib/browser-states.mjs` is **not runnable**: it needs
undeclared Puppeteer plus a Chromium download, a `dist/states.html` fixture that does
not exist, and defect 2 fixed first. Note 39 records that the 7b theme bridge passed
every unit test and did not work in a browser — and happy-dom resolves **no** CSS custom
property from a stylesheet, so the assertion class that failure lived in is unavailable
here. Rung 07's README says so, and a test enforces it.
