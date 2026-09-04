# 06a — Tailwind build

```bash
pnpm build:css   # 06a-tailwind-build/input.css -> 06a-tailwind-build/dist/shell.css
```

## Goal

**Question.** Does a Tailwind build fit the bootstrap-shell constraints?

**Why it mattered.** The shell's defining constraint is that it can be
*published once to a dumb static host* — no server, no build server, no
pipeline a peer has to run. Note 23 §2 had just chosen Basecoat over shadcn/ui
precisely to avoid pulling a framework runtime into that, and Basecoat is
Tailwind CSS 4 source. So the design system arrived attached to a build step,
and note 23's open thread said so plainly: *"Tailwind's build step sits
awkwardly with the 'publish once to a dumb static host' property."* This rung
weighs it.

**What a "no" would have cost.** If a Tailwind build did not fit — too large,
too slow, or needing tooling the project does not otherwise want — the shell
would have to choose between the design language and the zero-build property.
Giving up the build means hand-writing CSS for a design system that exists as
Tailwind source, and losing theme compatibility with shadcn/ui. Giving up
zero-build means every peer publishing a surface needs a toolchain, which is a
different product. Neither is a small loss, which is why note 23 §3 split this
question out of rung 6 and gave it its own reject condition: **bundle size or
build complexity breaks dumb static hosting.**

**Reject condition** (note 23): bundle size or build complexity breaks dumb
static hosting.

### Why this rung has no `tests/`

**This is a build-and-measure rung, and it is the only one on the ladder that is.**
Note 23 §4 scoped it explicitly: *"6a produces no components. It is a build
measurement: a Tailwind pipeline, a bundle, a number."* The archive's `test/`
directory is empty for the same reason — there is nothing here to assert about, only
something to weigh. A test that re-measured a file size would pin a number that is a
property of two vendor packages, not of this project, and would go red on every
upgrade for no useful reason.

The rung's artefacts are therefore its inputs (`input.css`, `input-bc.css`,
`shell.html`, `shell-bc.html`), its September record (`RESULTS.md`), and the
numbers below. The one durable claim it produced that *is* worth asserting —
"the prebuilt bundle contains no Tailwind utilities", `lib/ORIGIN.md` finding 5 —
is asserted next door, in `../06b-basecoat-mapping/tests/basecoat-1.0-corrections.test.ts`,
where it has consequences for the mapping.

## Findings

**Answer: yes, comfortably — but the reason to skip the build is weaker than the
September numbers suggest.** See "The counterintuitive result, corrected" below.

### Provenance

All five files are **RECOVERED byte-identical** from
`27-prototype-06a-tailwind-build/proto6a-tailwind/`:

| File | Archive path |
|---|---|
| `input.css` | `src/input.css` |
| `input-bc.css` | `src/input-bc.css` |
| `shell.html` | `src/shell.html` |
| `shell-bc.html` | `src/shell-bc.html` |
| `RESULTS.md` | `RESULTS.md` |

They carry **no provenance header**, deliberately, and this is the reason: all four
inputs sit inside the Tailwind build's content-scanning scope, so a comment added to
any of them changes the measurement. Measured before this README and the sibling
rungs' files existed, adding the headers moved `dist/shell.css` from 9,216 B to
9,434 B raw and 2,493 B to 2,586 B gzipped — a 2.4 % perturbation of the very
thing the rung exists to report. Provenance lives in this table instead, where it
costs nothing.

### Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | `pnpm build:css` works | Runs clean on Tailwind 4.3.3 in ~40 ms, emitting `dist/shell.css` | The CLI, the input path or the output path is wrong |
| 2 | Every number in `RESULTS.md` still reproduces **exactly** | The archive rebuilt from its own `src/` against `tailwindcss@4.3.3` + `basecoat-css@1.0.2`: 5,526 / 1,866 and 220,163 / 22,158, to the byte; the four static files measured with `gzip -9` | A pinned dependency drifted, or the September figures were not what was claimed |
| 3 | The app-level build is **larger** than the archive's, for a knowable reason | 9,525 B / 2,621 B against 5,526 B / 1,866 B, because Tailwind's content scan now covers the whole app, not one `src/` — `tracking-tight` appears in the output, and it exists nowhere but the class strings in `lib/basecoat.ts` | The two builds agree, which would mean the scan scope is not what the output says it is |
| 4 | A Tailwind build fits the bootstrap-shell constraints | Sub-second builds, one dev dependency, output measured in single-digit KB gzipped | Bundle size or build complexity breaks dumb static hosting — the reject condition |
| 5 | The "prebuilt is half the size" conclusion **does not survive a like-for-like comparison** | `basecoat.cdn.min.css` is 21,867 B gzipped against the built 22,158 B — a 1.3 % gap, not the 45 % that 12,153 B implies | The 12 KB base pack turns out to be a bundle the shell could actually ship |
| 6 | The `.cdn` packaging trap is real | `dist/basecoat.css` is 31 B and `dist/basecoat-base.css` is 64 B — `@import` stubs; only the `.cdn` variants are prebuilt | Measuring `dist/basecoat.css` would understate the payload by three orders of magnitude |

### Measured now, against `RESULTS.md`

Tailwind CSS 4.3.3, Basecoat 1.0.2, `gzip -9` — the same versions the archive
used, pinned in the app's `package.json`.

| Path | Raw (Sept) | Raw (now) | Gzip (Sept) | Gzip (now) |
|---|---|---|---|---|
| Tailwind only, content-scanned *(archive scope)* | 5,526 | **5,526** | 1,866 | **1,866** |
| Tailwind + `@import "basecoat-css"` *(archive scope)* | 220,163 | **220,163** | 22,158 | **22,158** |
| `basecoat-base.cdn.min.css` | 90,900 | **90,900** | 12,153 | **12,153** |
| `basecoat-compat.cdn.min.css` | 48,798 | **48,798** | 5,061 | **5,061** |
| `basecoat.min.js` (core) | 2,606 | **2,606** | 1,108 | **1,108** |
| `all.min.js` (all components) | 43,909 | **43,909** | 10,792 | **10,792** |

**Every figure reproduces to the byte.** The September measurements are exact and
the pins hold.

#### …and one number that differs, on purpose

`pnpm build:css` as the app declares it does **not** produce 5,526 B:

| | Raw | Gzipped | Build |
|---|---|---|---|
| `pnpm build:css` (this app, at the time of writing) | **9,525 B** | **2,621 B** | ~40 ms |
| `RESULTS.md`, archive scope | 5,526 B | 1,866 B | 93 ms |

**This is a real difference and not an error.** Tailwind 4's automatic source
detection scans from the stylesheet's project outward, honouring `.gitignore`. In
the archive that scope was one small `src/` directory; in this app it is the whole
of `httpeers-shell-protos/`, so the build picks up class strings that live in
TypeScript rather than in markup. The proof is in the output: `tracking-tight` is
emitted, and the only place that string occurs is the `Text` mapping in
`lib/basecoat.ts`.

It is worse than incomparable: it is **not stable**. Everything in this directory
is in scope, prose included — this README quotes `tracking-tight` and `flex-col`
and `gap-2` in the course of explaining them, and each of those is now a rule in
the bundle. The figure has moved three times while the rung was being written:
**9,216 B** with the recovered inputs alone, **9,485 B** once the three rungs'
READMEs and tests existed, **9,525 B** after this documentation pass added the
"Techniques and APIs" sections. Any rung added by any other agent moves it again.
Quote it with a date, or do not quote it.

Two things follow. First, **the app's `build:css` number is not comparable to
`RESULTS.md`** and should not be quoted as if it were; the comparable figure is
the archive-scope rebuild, which matches exactly. Second, **the wider scan is the
more honest measurement for a real shell**, because the classes in `lib/` are
exactly the ones the renderer will emit at runtime — and Tailwind found them by
accident rather than by declaration, which is a fragile way to be correct. A shell
that shipped a Tailwind build ought to declare its sources explicitly rather than
rely on a scan reaching into `lib/`.

### The counterintuitive result, corrected

Note 29 records: *"Importing Basecoat into a Tailwind build produces a LARGER
bundle than the prebuilt CDN file — 22 KB gzipped versus 12 KB"*, and recommends
shipping the prebuilt bundle.

**The recommendation stands. The magnitude does not.** The two figures are not the
same bundle:

- `@import "basecoat-css"` resolves to `dist/basecoat.css`, which is
  `@import "./basecoat-vega.css"` — the **full default style pack**.
- `basecoat-base.cdn.min.css`, the 12,153 B figure, is the **bare component pack**.
  It contains no style pack at all: no `data-variant` selectors, no variant rules
  of any kind. Shipping it would leave every button variant in the 6b mapping
  unstyled.

The like-for-like prebuilt file is `basecoat.cdn.min.css` — byte-identical to
`basecoat-vega.cdn.min.css`:

| | Raw | Gzipped |
|---|---|---|
| Tailwind + `@import "basecoat-css"` (built) | 220,163 | 22,158 |
| `basecoat.cdn.min.css` (prebuilt, same pack) | 218,225 | **21,867** |

**291 bytes, 1.3 %.** Content scanning removes essentially nothing, for the reason
note 29 gives correctly — component classes are defined in layers, not as
utilities — so the build adds Tailwind's own output on top of a bundle it cannot
shrink.

So the argument for the prebuilt bundle is **the build step, not the bytes**: it
needs no tooling and preserves "publish once to a dumb static host" outright. The
argument that it is *half the size* is an artefact of comparing a stripped base
pack with a full styled build. That matters because 6b's `Text` mapping is still
Tailwind utilities (see `../06b-basecoat-mapping/README.md`): the fix "just ship
the Tailwind build" costs ~291 bytes gzipped, not 10 KB, which makes it a live
option rather than the obvious loser the September framing implies.

### Perspective

12 KB — or 22 KB — gzipped for the full design system is a rounding error next to
`biscuit-wasm` at ~0.9–1 MB gzipped (prototype 8). **Styling is not the thing to
optimise.** That conclusion is unchanged and is the one that should drive the
decision.

## Techniques and APIs

### The Tailwind 4 CLI invocation

```bash
tailwindcss -i 06a-tailwind-build/input.css -o 06a-tailwind-build/dist/shell.css --minify
```

That is the entire pipeline: one dev dependency (`@tailwindcss/cli` 4.3.3), one
input, one output, no config file. Tailwind 4 needs no `tailwind.config.js` —
configuration moved into CSS. The two inputs the rung measures are one line and
two lines respectively:

```css
/* input.css    — Tailwind alone */
@import "tailwindcss";

/* input-bc.css — Tailwind plus the design system */
@import "tailwindcss";
@import "basecoat-css";
```

`@import "basecoat-css"` resolves through the package's `style`/`main` field to
`dist/basecoat.css`, which is itself a one-line `@import "./basecoat-vega.css"`
— the **full default style pack**, not a bare component set. That resolution
chain is the single most important thing to know before comparing any two of
these numbers, and it is what "The counterintuitive result, corrected" turns on.

### Tailwind 4 automatic source detection

Tailwind 4 has no `content` array by default. It scans outward from the
stylesheet's project, honouring `.gitignore` and skipping binaries, and emits a
utility for every candidate string it finds — **in any text file, not only in
markup**. Three consequences, all of them visible in this rung's numbers:

- The archive scanned one small `src/` directory. The app scans the whole of
  `httpeers-shell-protos/`, so `dist/shell.css` now contains `tracking-tight`,
  a string that occurs nowhere but the `Text` class table in `lib/basecoat.ts`.
  The build is reaching into TypeScript to find class names.
- Prose counts. This README quotes `flex-col` and `gap-2` while explaining them,
  and those utilities are now in the bundle.
- The scope can be pinned when it matters, with `@import "tailwindcss"
  source("./src")` or `source(none)` plus explicit `@source` directives. The
  shell should do that rather than rely on a scan that happens to reach `lib/`.

### How the byte sizes were measured reproducibly

Every figure in `RESULTS.md` was re-derived rather than trusted, and the method
is the reason they matched to the byte:

```bash
# 1. rebuild the ARCHIVE at ARCHIVE SCOPE — a copy of proto6a-tailwind/ with
#    node_modules symlinked from this app, so the versions are the pinned ones
tailwindcss -i src/input.css    -o dist/shell.css    --minify
tailwindcss -i src/input-bc.css -o dist/shell-bc.css --minify

# 2. raw and gzip -9, the same compression level RESULTS.md used
wc -c dist/shell.css
gzip -9 -c dist/shell.css | wc -c
```

Three details make it reproducible. **Scope is part of the measurement** — the
build has to run from a directory containing only the archive's `src/`, or
source detection changes the answer. **`gzip -9` is part of the measurement**;
`RESULTS.md` says so, and a different level gives a different number.
**Versions are pinned** — `tailwindcss` and `@tailwindcss/cli` at 4.3.3 and
`basecoat-css` at 1.0.2 in this app's `package.json`, the same versions the
archive used; nothing here is measured against a floating range.

The static files need no build at all, only `wc -c` and `gzip -9` against
`node_modules/basecoat-css/dist/`.

### The Basecoat packaging layout

Knowing which file to weigh is most of the work:

| File | What it is |
|---|---|
| `dist/basecoat.css`, `dist/basecoat-base.css` | **`@import` stubs**, 31 B and 64 B. Require a Tailwind build. |
| `dist/*.cdn.css`, `dist/*.cdn.min.css` | **Prebuilt.** These are the only files a zero-build shell can serve. |
| `basecoat-base.cdn.min.css` | Bare component pack — **no style pack**, no `data-variant` rules at all. |
| `basecoat.cdn.min.css` | The default pack; byte-identical to `basecoat-vega.cdn.min.css`. Eight packs ship. |
| `basecoat-compat.cdn.min.css` | Legacy stylesheet; the only place `btn-secondary` still exists. |
| `dist/js/basecoat.min.js`, `dist/js/all.min.js` | Core runtime and all components. Neither is loaded yet. |

Class-presence checks were done with a class-selector regex over the minified
files rather than by eye — the same technique the sibling rung's
`basecoat-1.0-corrections.test.ts` uses, where it runs as an assertion.

## Lessons learned

**The prebuilt pack contains no Tailwind utilities.** `.flex`, `.flex-col`,
`.gap-2`, `.grid` are absent from every prebuilt bundle, because Basecoat's
component classes are defined in layers and the utilities are Tailwind's own
output — which is exactly why importing Basecoat into a Tailwind build does not
shrink it. On the zero-build path, any mapping that emits a utility class emits
a class that styles nothing. `lib/ORIGIN.md` finding 5 records this and moved
layout onto shell-owned `shell-col` / `shell-row` / `shell-field`.

**Finding 5 fixed layout and left typography behind.** The `Text` mapping still
emits `text-sm`, `text-2xl font-semibold tracking-tight`, `text-lg
font-semibold` and `text-muted-foreground text-xs` — none of which the prebuilt
pack defines. Text variants are therefore *distinct but unstyled* on the
zero-build path, which is a state no test asserting "the variants differ" can
detect. See `../06b-basecoat-mapping/README.md`, where it is pinned.

**Note 29's "counterintuitive result" is a mis-comparison, and correcting it
changes a decision.** 22 KB built against 12 KB prebuilt compares a full style
pack with the bare base pack. Like for like it is **22,158 B against 21,867 B —
1.3 %, not 45 %**. The recommendation to ship prebuilt survives, but it now
rests on *the build step, not the bytes*. And that turns "just ship the Tailwind
build" into a **live fix for the typography gap** — it costs ~291 bytes gzipped,
not 10 KB — rather than the obvious loser the September framing implies. A
number quoted against the wrong baseline does not merely misinform; it closes
off an option.

**The app-level `build:css` number is not stable, and must not be read as a
regression signal.** Because Tailwind 4 scans the whole app, the bundle grows
when any rung adds a file, prose included: 9,216 B → 9,485 B → 9,525 B raw over
three drafts of this documentation, with no change whatever to the shell. Only
the archive-scope rebuild is comparable to `RESULTS.md`. Quote the app-level
figure with a date, or do not quote it.

**Weigh the file you would actually ship.** The `.cdn` stubs understate the
payload by three orders of magnitude, and the base pack understates it by 45 %
while silently dropping every button variant the 6b mapping depends on. Both
traps are packaging, not code, and neither is visible from a `package.json`.

**A measurement rung's inputs are part of the measurement.** These four files
carry no provenance headers because adding them moved the result 2.4 %. When
the artefact under test is a byte count, annotating the input corrupts the
experiment — provenance goes in the prose instead.

## Not covered here

- **No components.** By scope: a pipeline, a bundle, a number.
- **Node-side only.** No browser parse or paint cost was measured, and nothing was
  rendered. Both of rung 7's corrections to the 6b mapping were invisible until
  something was actually painted in a browser.
- **The style pack is undecided.** Basecoat ships eight; the figures here are the
  default (`vega`) and the bare base pack. Whether the choice is load-bearing for
  the catalogue mapping is untested.
- **`dist/` is not committed.** It is gitignored; run `pnpm build:css` to produce it.
