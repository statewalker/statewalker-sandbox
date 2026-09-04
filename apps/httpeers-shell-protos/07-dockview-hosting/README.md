# 07 — Dockview hosts A2UI surfaces; a layout carries identity, not content

`pnpm test 07-dockview-hosting` — 41 tests over five suites.

Covers three rungs: **7** (does Dockview host A2UI surfaces?), **7a** (does a
layout round-trip preserve surface identity?) and **7b** (can Dockview's theme
be driven by shadcn tokens?). Their code is `lib/dock.ts` and
`lib/theme-bridge.ts`. The original `layout.test.ts` was never uploaded, so
these tests are written fresh from notes 31, 32, 34, 35 and 36 against code
that already exists — every file carries `DERIVED-FROM-NOTE` headers naming
which note each claim comes from.

## Goal

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

### Why the rung mattered

**Hosting is what makes the shell a workspace rather than a page.** Everything
below rung 7 renders one surface into one root: rung 2 proved a catalogue
constrains what a peer may express, rung 3 added binding and dispatch, rung 6
gave a module a host it cannot discover. All of it assumes a single surface. A
"browser for meshes" that can only show one peer's application at a time is a
viewer, not a workspace — the whole point is holding several peers' surfaces
side by side and moving between them. Rung 7 is where that stops being an
assumption. **A "no" here would have invalidated the shell's shape**: the
alternative is one surface per browser tab, which throws away cross-pane work
and hands layout back to the operating system.

**7a's identity-not-content rule is what makes a restored layout safe.** The
geometry was never in doubt — Dockview ships `toJSON`/`fromJSON`. The question
that mattered is narrower and is a *security* question as much as a persistence
one: the content in a pane was authored by a foreign peer. Persisting rendered
components would resurrect stale content and, worse, store another peer's
markup across sessions, to be replayed later with no live conversation to
justify it. Storing an `origin` and re-requesting instead means a restore
re-enters the conversation rather than reconstructing a memory of it. **A "no"
here** — a layout that draws the right boxes but cannot say which peer fed
which box — **would have made layout persistence useless**, since a pane that
cannot be reassociated with its peer cannot be repopulated, and the only safe
fallback would have been to persist nothing.

**7b decides whether the shell has one palette or two.** The reject condition
was explicit in note 34: if Dockview's variables could not be expressed in
terms of shadcn tokens, two palettes would have to be maintained in parallel,
every theme change made twice, guaranteed to drift. A "no" would not have
blocked the ladder, but it would have made theming a permanent tax.

## Findings

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

## Techniques and APIs

### Dockview 8.2.0

**`createComponent` is a factory, and the thing it returns owns its DOM.** The
`IContentRenderer` contract is small and its shape is the finding:

```ts
new DockviewComponent(host, {
  theme: themeLight,
  createComponent: (options) => {          // options.id is the panel id
    const element = document.createElement("div");   // WE create it
    element.style.height = "100%";
    return {
      element,                             // readonly, Dockview mounts THIS instance
      init: (params) => createRenderer(element, shellCatalog),
    };
  },
});
```

`element` is a `readonly HTMLElement` on the renderer, and Dockview appends
that exact instance into a `.dv-content-container` it owns. **There is no
`params.containerElement`** — the published examples showing one are wrong for
v8, and the failure is `Cannot read properties of undefined (reading
'appendChild')` at the first `addPanel`. The corrected shape is a better fit
anyway: the A2UI renderer takes one DOM root, so the component's own element is
handed straight to it with no adapter in between.

**`init` receives `GroupPanelPartInitParameters`**, exported from
`dockview-core`, and it has exactly four members:

```ts
interface GroupPanelPartInitParameters {
  params: Parameters;            // the round-tripped bag — see toJSON below
  title: string;
  api: DockviewPanelApi;
  containerApi: DockviewApi;
}
```

**A test fake must satisfy that interface, not a convenient approximation of
it.** Typing the fake's `init` as `(params: Record<string, unknown>)` compiles
in isolation but does not satisfy `IContentRenderer`, because
`GroupPanelPartInitParameters` has no index signature — a fake that would not
be accepted by the real API is not evidence about the real API. The fake here
is typed with Dockview's own parameter type and the cast is moved to the
*capture*, which is where the looseness genuinely belongs. This was caught late
because the app's `tsconfig` `include` had been matching `0*` as a file pattern,
so no rung folder was ever typechecked at all — worth stating plainly, since a
typecheck that silently covers nothing is the same failure mode as a test that
silently asserts nothing, which is the theme of this whole rung.

**The shell's own surface** (`lib/dock.ts`):

```ts
function createShellDock(host: HTMLElement): ShellDock;

interface PaneSpec {
  readonly id: string;
  readonly title: string;
  readonly origin: string;                 // opaque URL, provenance-blind
  readonly messages?: A2uiMessage[];       // first open only; never persisted
  readonly position?: { referencePanel: string;
                        direction: "right" | "below" | "left" | "above" };
}

interface ShellDock {
  readonly dockview: DockviewComponent;
  readonly renderers: Map<string, Renderer>;   // one per pane, never shared
  addPane(spec: PaneSpec): void;
  paneIds(): string[];
  originOf(paneId: string): string | undefined;
  toJSON(): object;
  fromJSON(layout: object): void;
}
```

**`params` is the persistence hook.** `addPanel({ params: { origin } })` writes
it; `toJSON()` emits it verbatim under `panels[id].params`; `fromJSON()` hands
it back to `createComponent`'s `init` as `params.params.origin`. That verbatim
round-trip is the entire mechanism by which surface identity survives, and the
convention is that **exactly one key** lives there. `PaneParams.origin` is
typed **optional** even though the shell always writes it, because Dockview's
`Parameters` makes no guarantee and a layout can be hand-edited or arrive from
an older version — the compiler was right and the first draft was wrong.
Titles are persisted too, but by Dockview under `panels[id].title`, not through
`params`.

**`updateOptions({ theme })` re-themes a live component.** A Dockview theme is
a plain object — `{ name, className, colorScheme, ... }` — and passing one at
construction, or later through `updateOptions`, makes Dockview apply
`className` to the `.dv-shell` element it creates *inside* the host. That is
the whole of the note 35 fix: supply a theme object rather than adding a class
to the host.

### The theme bridge

`lib/theme-bridge.ts` is CSS and four exported lists — no JavaScript in the
mapping at all:

| Export | What it is |
|---|---|
| `DOCKVIEW_SHADCN_BRIDGE` | One class, `.dockview-theme-shadcn`, in which every `--dv-*` value is a `var(--shadcn-token)` reference |
| `SHADCN_THEME_CLASS` | The class name, for the theme object's `className` |
| `BRIDGED_VARIABLES` (40) | Documentation of what the stylesheet declares |
| `UNBRIDGED_BY_DESIGN` (22) | Metrics, timings and z-indices, which have no shadcn equivalent |
| `REQUIRED_TOKENS` (11) | `--background`, `--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--ring`, `--accent`, `--popover`, `--popover-foreground`, `--radius` |
| `installBridge(doc)` | Appends the stylesheet to `<head>` |

Overriding CSS variables in a later stylesheet is the documented cascade, so
the bridge **replaces** Dockview's bundled themes rather than extending them —
its per-theme palettes (`--dv-color-abyss-*` and friends) are deliberately
untouched. Composite values are allowed to carry structure
(`--dv-drag-over-border: 1px dashed var(--ring)`), and all three Dockview radii
take shadcn's single `--radius`.

### Testing techniques — the transferable part

**1. Extract the artefact and assert set equality against it.** Dockview ships
no `.css` file; its stylesheet is a JS string literal inside
`dist/dockview-core.js`. `src/dockview-css.ts` slices that literal out and
`JSON.parse`s it (a double-quoted JS string literal is valid JSON), then
derives the variables Dockview *consumes* by scanning for `var(--dv-…)`. The
coverage test then asserts **set equality in both directions** between
`bridged ∪ unbridged-by-design` and that derived set. This is the whole answer
to note 34 §3 and note 39: **no list of Dockview variables appears anywhere in
a test file**, so the tests cannot restate the bridge's own assumptions, and a
Dockview upgrade that adds a variable fails the build instead of silently
rendering unthemed.

**2. Make an extraction fail loudly.** `extractDockviewStylesheet()` throws if
the marker is missing, and the first test asserts the result is >100 KB, contains
`.dv-tab`, and yields >50 semantic and >20 colour-bearing variables. An
extraction that silently returned `""` would make every coverage assertion pass
*vacuously* — which is exactly the class of bug this rung exists to catch, so
the fixture has to be checked before it is trusted.

**3. Derive the classification too, not just the list.** "Colour-bearing" is
computed from the values Dockview's **own themes assign** to each variable, not
from a judgement about its name. A name heuristic would misclassify
`--dv-tab-group-color`, which reads as a colour and carries no colour default.
The rule for what must be bridged is therefore a fact about Dockview, not an
opinion in the test.

**4. Positive control before asserting absence.** Note 32 §4 records the
original round-trip test asserting a restored host contained no old content —
which passes trivially, because a fresh `ShellDock` has nothing to replay. It
tested the constructor. Here the test first asserts the content **was really
there** (in the live DOM, and in the live data model) and only then asserts it
is absent from the serialised JSON. Paired with claim 11, which repopulates a
restored pane, neither half can pass by the code doing nothing.

**5. Force the artefact across a real boundary.** Every restore goes through
`JSON.stringify` into a **separate dock on a separate host**, whose `pending`
map is empty. Only data that survives serialisation can carry identity; no
in-memory reference can be smuggled across and mistaken for persistence.

**6. Mutation testing, five mutants, all killed.** Written against throwaway
copies of `lib/` so the shared library was never edited:

| Mutant | Killed by |
|---|---|
| Drop `params` from `addPanel` | Claims 7 and 10 — the origin vanishes from the JSON and from the restore |
| Leak `messages` into `params` | Claims 7 and 8 — `params` keys are no longer exactly `["origin"]`, and the rendered text appears in the JSON |
| Ignore `params.origin` on restore | Claim 10 — `originOf` returns `undefined` after a round-trip |
| Delete one bridged declaration | Claim 16 — `--dv-sash-color` becomes unaccounted for |
| Replace a token with `#e5e5e5` | Claim 20 — a literal colour is detected |

One mutation is deliberately **not** claimed: forcing the replay branch in
`init` to always run changes nothing, because there is no stored content to
replay. Note 32 §4 found the same thing. That mutant is equivalent, which is
itself the point — content cannot resurrect because nothing persists it.

## Lessons learned

**happy-dom resolves no CSS custom property from a stylesheet.** Not "resolves
them imprecisely" — `getComputedStyle(el).getPropertyValue("--dv-…")` returns
`""` even with the bridge installed and the class applied (claim 35). So the
assertion class the shipped 7b suite leaned on, "the variables resolve on an
element carrying the bridge class", is **unavailable here, not merely weak**.
Any future rung tempted to test styling in this environment should read claim
35 first and then not.

**Note 39 records 7b passing every unit test and failing in a browser.** Sixty-one
green tests, three of them true and useful, and the bridge did nothing: they
asserted the stylesheet was right, never that it reached the element Dockview
reads. The implication for this suite is uncomfortable and worth stating rather
than hiding: **a green run here is evidence about structure and serialisation,
and almost no evidence about appearance.** That is why this README leads to
"what these tests cannot prove" from the top, and why the claim table names a
falsifier for every row — a claim whose falsifier cannot be described is
usually a claim that is not being made.

**`colorScheme` in dockview-core 8.2.0 is never read at all.** Note 35 §6
recorded it as "read once at construction". The bundle is stricter than that:
all 18 occurrences in the shipped ESM entry are object-literal keys on bundled
theme definitions, with no property read and no bracket access anywhere (claim
34). Its own type calls it "useful for adapting panel content colors" — it is
**advisory metadata the embedder must act on**, so a shell that sets it and
expects native affordances to follow will be quietly disappointed. The general
form: when a note says a value is "read once", check whether it is read at all.

**"Never injected" is true of the ESM entry and false of the standalone build.**
Note 31 §3.1 is right about the case that matters — `dist/package/main.esm.mjs`,
what `import "dockview-core"` resolves to, carries no CSS and injects nothing —
but `dist/dockview-core.js` does `document.head.appendChild(s)` for itself.
A packaging finding is a finding about **one entry point**, and is worth
recording as such, because the next person reaching for the standalone build
will otherwise extract a stylesheet that was already going to install itself.

**The big one: the note 35 fix never reached the consolidated code.** The bug
was found in September, root-caused precisely, fixed, browser-verified and
written up — and `lib/dock.ts` still passes `themeLight`, so the bridge class
never reaches `.dv-shell` and the theme bridge is inert in any app built on the
consolidated shell-core (defect A). `lib/theme-bridge.ts` does not export the
`shadcnTheme()` helper note 35 introduced, either. **This is a lesson about the
record, not about Dockview.** Consolidation caught renderer drift precisely
because the copies met and a stale test failed (note 32 §1); the theme fix drifted
the other way, from a note into nothing, because no test travelled with it. A
finding written into prose and not into an executable assertion has a half-life.
Claim 31 is written to pin the current, wrong behaviour and turn **red** when
the fix lands, so this particular finding now travels with a test.

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
