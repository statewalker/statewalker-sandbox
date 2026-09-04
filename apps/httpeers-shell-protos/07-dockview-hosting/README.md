# 07 — Dockview hosts A2UI surfaces; a layout carries identity, not content

`pnpm test 07-dockview-hosting` — 41 tests over five suites.

Covers three rungs: **7** (does Dockview host A2UI surfaces?), **7a** (does a
layout round-trip preserve surface identity?) and **7b** (can Dockview's theme
be driven by shadcn tokens?). Their code is `lib/dock.ts` and
`lib/theme-bridge.ts`. The original `layout.test.ts` was never uploaded, so
these tests are written fresh from notes 31, 32, 34, 35 and 36 against code
that already exists — every file carries `DERIVED-FROM-NOTE` headers naming
which note each claim comes from.

## The questions

**7 — does Dockview host one A2UI surface per pane?** Yes, and the join is
tighter than the documentation suggests: `IContentRenderer` requires the
component to **own** its `element`, which is exactly what the A2UI renderer
wants — one DOM root, no adapter.

**7a — does a layout round-trip preserve surface identity?** Yes, through
Dockview's `params`, which round-trip verbatim. **Identity persists, content
does not**: the layout stores an `origin` and nothing else, and a restored
pane is a live, empty surface host waiting to be repopulated by its peer.

**7b — can one palette drive both?** Yes, with a pure CSS bridge — and the
bridge in `lib/theme-bridge.ts` accounts for **every** semantic variable
Dockview 8.2.0 actually consumes: 62 of them, 40 bridged and 22 declared
unbridged by design. That number is extracted from Dockview's bundle at test
time, not written down here.

**But see [what these tests cannot prove](#what-these-tests-cannot-prove).**
This is the rung where unit tests lie. The bridge that shipped in 7b passed 61
of them and did not work in a browser.

## Verified

### Hosting — `tests/hosting.test.ts`

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | `init` receives **no** container element | The params Dockview 8.2.0 actually passes are captured and their keys asserted: `api`, `containerApi`, `params`, `title` | `containerElement` appears — i.e. the published example becomes correct |
| 2 | Dockview mounts the element the component **owns** | The captured instance is `isConnected`, and is the identical object found under `.dv-content-container` | Dockview copies, wraps, or re-creates the element |
| 3 | A component without an `element` is rejected | `addPanel` throws | The shape is silently accepted |
| 4 | One renderer and one data model per pane | Two panes; writing `/query` into one leaves the other's model undefined, and each renderer reports only its own surface | Renderers or data models are shared |
| 5 | First open replays the spec's messages into that pane's element | Each `.dv-content-container` holds its own text and never the other's | Content is rendered to a shared root, or bleeds between panes |
| 6 | A pane remembers the origin it was served from | `originOf` returns it; an unopened id returns `undefined` | Origin is lost, or invented for an unknown pane |

### Layout round-trip — `tests/layout.test.ts`

Every restore goes through `JSON.stringify` into a **separate dock on a
separate host**, whose `pending` map is empty. Only data that survives
serialisation can carry identity; nothing in memory can be smuggled across.

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 7 | `params` carries the origin and **nothing else** | For every panel in the serialised layout, `Object.keys(params)` is exactly `["origin"]`, and the values match the specs | Any message, catalogue id or cached component leaks into `params` |
| 8 | Content does not cross the boundary — **and it existed** | Positive control first: the text is in the live DOM and the value is in the live data model. Then the JSON contains neither, nor `updateComponents` / `createSurface` / `updateDataModel` / `catalogId` | Rendered components or model values are persisted |
| 9 | Titles survive, but outside `params` | `panels[id].title` is present; `params` has no `title` key | Dockview stops persisting titles, or the shell starts persisting them itself |
| 10 | A restore reassociates every pane with its peer | `originOf` and `dockview.panels[].params.origin` both return the original origins after a string round-trip into a fresh dock | Identity does not survive serialisation |
| 11 | A restored pane is a **live** surface host | Replaying messages (standing in for the peer) renders new content into the restored pane, while the old text stays absent | Restore yields a dead pane — which would satisfy every absence assertion above and be useless |
| 12 | A layout with no `origin` still restores | Geometry restores; `originOf` is `undefined` rather than a crash or an invention | `PaneParams.origin` is treated as guaranteed (note 32 §5) |
| 13 | An unrecognised params key is not mistaken for an origin | `{ peer: "https://impostor.example/" }` yields `undefined` | The shell guesses at identity |

Claim 8 is the one note 32 §4 records getting wrong: the original test
asserted a *restored* host contained no old content, which passes trivially
because a fresh `ShellDock` has nothing to replay — it tested the constructor.
The assertion here is against the artefact that crosses the boundary.

### Theme bridge — `tests/theme-bridge.test.ts`

**There is no list of Dockview variables in the test file.** Note 34 §3 and
note 39 both record 7b's coverage tests checking the bridge against a list
written by hand in the same file. Every expectation below is extracted at test
time by `src/dockview-css.ts` from the installed `dockview-core` bundle.

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 14 | The fixture is real | The recovered stylesheet is >100 KB, contains `.dv-tab`, and yields >50 semantic and >20 colour-bearing variables — extraction **throws** rather than returning `""` | A Dockview repackaging silently empties the fixture and makes coverage vacuous |
| 15 | Per-theme palettes are correctly out of scope | `--dv-color-*` entries exist and none is bridged | The bridge starts extending Dockview's bundled themes instead of replacing them |
| 16 | **Every** semantic variable Dockview consumes is accounted for | Set equality, both directions, between `bridged ∪ unbridged-by-design` and the variables read via `var()` in Dockview's real CSS | A Dockview upgrade adds a variable, or the bridge keeps one Dockview no longer reads |
| 17 | Every variable Dockview gives a colour is bridged | "Colour-bearing" is derived from the values Dockview's own themes assign, not from the name — `--dv-tab-group-color` reads as a colour and has no colour default | A colour-bearing variable falls out of the bridge |
| 18 | Nothing colour-bearing hides in `UNBRIDGED_BY_DESIGN` | Intersection with the derived colour-bearing set is empty, and no unbridged variable has a colour default | A gap is reclassified as a decision |
| 19 | `BRIDGED_VARIABLES` matches the stylesheet it documents | Set equality with the declarations parsed out of `DOCKVIEW_SHADCN_BRIDGE` | The exported list drifts from the CSS |
| 20 | Every value maps to a token, and no value is a literal colour | Each declaration matches `var(--…)`; none matches `#rgb`, `rgb()`, `hsl()`, `oklch()` or `oklab()`. Composite values such as `1px dashed var(--ring)` are allowed (note 34 §4) | A colour is hard-coded, so two palettes start to drift |
| 21 | `REQUIRED_TOKENS` is exactly what the bridge references | Derived from the stylesheet's `var()` calls | A new token dependency appears without being declared |
| 22 | All Dockview radii take shadcn's single `--radius` | The `-radius` variables are found in Dockview's CSS, then each bridged one is required to be `var(--radius)` | A second radius token is invented |
| 23 | The bridge defines exactly one class, the exported one | Selectors parsed from the stylesheet equal `[".dockview-theme-shadcn"]` | The bridge grows a second selector `SHADCN_THEME_CLASS` no longer names |

These were checked by mutation: removing one bridged declaration, and replacing
one token with `#e5e5e5`, each turn a test red.

### Packaging — `tests/packaging.test.ts`

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 24 | Dockview ships **no** `.css` file | The installed package tree is walked; no file ends in `.css` | Dockview starts shipping a stylesheet — at which point the extraction hack should be dropped |
| 25 | The stylesheet is a JS **string literal** in the standalone build | `dist/dockview-core.js` contains `s.textContent = ".dv-`, and the decoded text is >140 KB (~147 KB in note 31 §3.1) | The embedding shape changes |
| 26 | The entry `import "dockview-core"` resolves to carries none of it | `dist/package/main.esm.mjs` contains neither the literal nor a rule from it | The ESM build starts bundling the CSS |
| 27 | Importing and constructing inject **nothing** | The head is captured at import time and after building a dock: no `<style>`, no stylesheet `<link>` | Dockview begins injecting its own CSS |
| 28 | Dockview applies its theme class to an **inner `.dv-shell`**, not the host | After `createShellDock`, the host has no theme class and `host.querySelector(".dv-shell")` does | Dockview moves the class to the host |
| 29 | A bridge class on the host is a **farther** ancestor, so it loses | Walking up from `.dv-content-container`, `dockview-theme-light` is met before the host's `dockview-theme-shadcn` | The nesting changes and the note 35 bug stops being possible |
| 30 | Passing our own theme object puts the bridge class where Dockview reads it | A `{ name, className, colorScheme }` object results in `.dv-shell.dockview-theme-shadcn` and no `dockview-theme-light` | Dockview stops honouring a custom theme object — the note 35 §3 fix |
| 31 | **A defect**: `createShellDock` hard-codes `themeLight` | The shell is `dockview-theme-light` even with the bridge class on the host, and `ShellDock` exposes no theme setter | The defect is fixed — this test is written to turn red then |

### Recorded limitations — `tests/limitations.test.ts`

These pin **current** behaviour. None asserts it is correct.

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 32 | A live dark-mode toggle does nothing | Adding `.dark` to the document after construction leaves `.dv-shell`'s class list untouched; `ShellDock` has no `setTheme` or `setColorScheme` | The hole is closed — as it should be |
| 33 | Dockview itself **can** be re-themed after construction | `dockview.updateOptions({ theme })` swaps the class on `.dv-shell` | Dockview loses the mechanism. Recorded so the fix does not have to be rediscovered: the gap is in `lib/dock.ts`, not in Dockview |
| 34 | `colorScheme` is never read by dockview-core 8.2.0 **at all** | Every occurrence in the shipped ESM entry is an object-literal key; there is no `.colorScheme` read and no bracket access | A future version starts consuming it |
| 35 | happy-dom resolves **no** CSS custom property from a stylesheet | With the bridge installed and the class applied, `getComputedStyle(el).getPropertyValue("--dv-group-view-background-color")` is `""` | happy-dom gains cascade support — which would make a *little* more of 7b testable here |
| 36 | The element that consumes the floating shadow is reachable, its style is not | `.dv-resize-container` exists after `addFloatingGroup`; its computed `box-shadow` is `""` | happy-dom starts computing shadows |
| 37 | Synthetic drag events produce no drop target | `dragstart` / `dragenter` / `dragover` on a real tab and group yield zero `[class*=drop-target]` elements | Dockview stops using native HTML5 DnD |

## What these tests cannot prove

Dockview 8.2.0 **does** construct under happy-dom — it builds its full DOM,
mounts panel content, serialises and restores layouts, creates floating groups
and swaps theme classes. That is more than expected, and it is why claims 1–34
above are real. But everything here is **structure**. Nothing is **rendered**.

- **Whether any of it looks right.** happy-dom computes no cascade: claim 35
  shows that a CSS custom property declared in a stylesheet resolves to `""`.
  So the entire class of assertion the 7b suite leaned on — "the variables
  resolve on an element carrying the bridge class" — is unavailable here, and
  would have been worthless anyway. Note 35 §4: all 61 tests passed before and
  after the bridge was found to be broken. They asserted the stylesheet was
  right, never that it reached the element Dockview reads.
- **Whether the bridge produces readable contrast, or a sane dark mode.** Claim
  29 establishes the *structural precondition* for the note 35 bug — Dockview's
  class is nearer to the content than the host's — but it cannot show what
  colour anything ends up. Note 35 §2's tell was `rgba(51,51,51,0.7)` in both
  light and dark, and no assertion in this environment can see that.
- **Drag affordances.** Claim 37 records that they cannot be triggered here.
  Note 36 §1 is precise about why: Dockview uses native HTML5 drag-and-drop,
  which neither CDP mouse events nor a hand-built `DragEvent` synthesise; only
  Chrome's drag interception works. So `--dv-dnd-compass-*`,
  `--dv-drag-over-*`, `--dv-smart-guides-*` and `--dv-edge-dock-indicator-*`
  are bridged and **unexercised** — and `--dv-dnd-compass-*` was never exercised
  in the browser either (note 36 §2: no compass element ever appeared).
- **Floating groups and context menus.** Claim 36 finds the right element and
  cannot measure it. Note 36 §3 is the cautionary half of this: note 35
  declared the floating-group bridge unproven purely because it queried
  `[class*=float]`, which does not match `.dv-resize-container`. A wrong
  selector and a broken mapping look identical from a test.
  `--dv-context-menu-*` remains unproven in every environment.
- **That `dist/dockview-core.js`'s CSS, once extracted, is complete or
  correct.** Claims 24–27 establish that the package injects nothing and that
  the text exists; they say nothing about what a real browser does with 147 KB
  of it.

The general lesson these rungs paid for, twice: a mapping can exist without
applying (note 35), and a measurement can miss the element that applies it
(note 36). Both produce the same false confidence from opposite directions, and
**the only cure is rendering and looking**.

### The browser harness

`lib/browser-states.mjs` is that cure — the note 35/36 harness. It runs light
and dark passes in Chromium, drives a real drag through Chrome's drag
interception, measures the drop-target selection and the floating group in
each, writes `dist/browser-state-results.json`, and throws if the drag overlay
colours do **not** change between light and dark. Asserting the *flip* rather
than the values is the point: identical colours are exactly how the original
bug presented.

**It cannot be run from this app as it stands**, and making it runnable is out
of scope here — it needs four things this app does not have:

1. `puppeteer-core` and `@sparticuz/chromium`, neither declared in
   `package.json`. Adding them means a Chromium download.
2. `dist/states.html` — the fixture page it loads from `file://`. It has to
   build a dock over the real `lib/`, expose it as `window.__dock`, install the
   bridge, extract Dockview's stylesheet out of `dist/dockview-core.js` into a
   real `<style>` (claims 24–27 are why), load a Basecoat style pack, and pass
   a **shadcn theme object** rather than `themeLight` — otherwise it measures
   Dockview's bundled theme and reproduces the note 35 false pass.
3. Defect A below fixed, or worked around in the fixture page, since
   `createShellDock` gives no way to supply that theme object.
4. A `test:browser` script. Note 36 §5 is explicit that the harness must not be
   part of `pnpm test`: it needs a browser and takes seconds rather than
   milliseconds.

Until then, treat the browser findings as **recorded in notes 35 and 36, not
re-established here**.

## Defects found in `lib/`

**A. `lib/dock.ts` hard-codes `themeLight`, so the theme bridge is inert.**
This is the note 35 bug, still present in the consolidated shell-core. The
constructor passes `theme: themeLight`, so Dockview writes
`dockview-theme-light` onto `.dv-shell`, and a `dockview-theme-shadcn` class on
the host is a strictly outer ancestor whose variables lose (claims 28, 29, 31).
The fix note 35 §3 records — pass `{ name: "shadcn", className:
SHADCN_THEME_CLASS, colorScheme }` — is verified to work here in claim 30, and
`lib/theme-bridge.ts` does not export the `shadcnTheme()` helper that note 35
introduced. Claim 31 pins the current behaviour and will turn red when this is
fixed, which is intended.

**B. `ShellDock` offers no way to re-theme after construction**, so the live
dark-mode hole cannot be closed by a caller (claim 32). Claim 33 shows
`dockview.updateOptions({ theme })` does the job, so this is a missing method,
not a Dockview limitation. A caller can reach `dock.dockview` and do it by
hand, which works but makes the theme untracked shell state.

**C. Minor, in `fromJSON`:** origins are recovered twice — once inside
`createComponent`'s `init` from `params.origin`, and again by the loop over
`dockview.panels` afterwards. Either alone suffices, so no test can distinguish
which path supplied the value, and removing one would not fail this suite.

**D. Note 31 §3.1's wording is slightly off for 8.2.0**: the standalone
`dist/dockview-core.js` *does* inject its own stylesheet
(`document.head.appendChild(s)`). The finding still holds for anyone importing
the package normally — `dist/package/main.esm.mjs` carries no CSS and injects
nothing (claims 26, 27) — but "never injected" is true of the ESM entry, not of
every build.

## Not covered here

- **No re-request.** Claim 11 replays messages by hand, standing in for a peer.
  Nothing reconnects; the mechanism that takes an `origin` and asks that peer
  for its surface again does not exist (note 32 §7) and belongs with the mesh
  connector at rung 9.
- **No storage.** The layout is serialised and round-tripped in memory. Nothing
  touches OPFS, localStorage or a file.
- **No layout versioning.** Nothing in `lib/dock.ts` versions the persisted
  format, so a future change to `params` will fail restores silently.
- **No `window.basecoat.init()` after a restore.** Outstanding since rung 7 and
  still unaddressed: Dockview rebuilds DOM on `fromJSON`, so any interactive
  Basecoat component would need re-initialising.
- **No popout windows, no maximised panels, no vertical splits, no tab groups.**
  The harness drives one fixed layout and so does this suite.
