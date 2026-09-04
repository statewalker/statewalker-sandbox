# 06b — The Basecoat mapping

`pnpm test 06b-basecoat-mapping`

## Goal

**Question.** Can the A2UI catalogue render as Basecoat components — without the
renderer, or the protocol, learning anything about the design system?

**Why it mattered.** The catalogue is the shell's security boundary: it
enumerates everything a peer-served surface is permitted to express, and
anything absent from it cannot be rendered by construction. That boundary was
designed as *protocol*, before anything had to look like anything. This rung is
where an abstraction designed for safety meets a real design language, and note
23 §3 flagged it as **the rung most likely to reject** on the whole visual
thread.

Basecoat is the shadcn/ui design language as Tailwind plus **semantic** classes
(`btn`, `input`, `label`), with no React and no framework runtime — which is why
it was chosen over shadcn/ui itself: importing React into a bootstrap shell
would contradict the static-hosting constraint (note 23 §2).

**What a "no" would have cost.** If the six components could not be expressed
without inventing a seventh, the catalogue was designed too abstractly — and
note 23 §4 is explicit that this is *a finding, not a task*: the rung may not
grow the catalogue to make the design work. Every component added to the
catalogue is a new thing a foreign peer may express, so the boundary widens
every time the design language pushes on it. A catalogue that has to grow once
per design system is not a boundary at all. The alternative cost is just as
bad: keeping the six and letting class names arrive in messages, which hands a
peer the ability to restyle or overlay the shell chrome.

**Reject condition** (note 23): the catalogue's components cannot map onto
Basecoat markup without inventing new ones.

### What this rung is made of: recovered vs reconstructed

| File | Status |
|---|---|
| `tests/basecoat.test.ts` | **RECOVERED** from `28-prototype-06b-basecoat-mapping/proto6b-basecoat/test/basecoat.test.ts`. Two edits only: imports repointed at `../../lib/*`, and one test rewritten — see below. |
| `tests/basecoat-1.0-corrections.test.ts` | **RECONSTRUCTED** from note 29 and `lib/ORIGIN.md` findings 4 and 5. The archive predates both corrections, so it has no test for either. |

The archive holds a **superseded** copy of the renderer and of the mapping. The
tests here run against `lib/`, the consolidated `shell-core`, exactly as
`lib/ORIGIN.md` says they should.

## Findings

**Answer: yes. All six map, and no seventh was needed.** The rung did not
reject, and the mapping table is total in both directions — no catalogue
component is unmapped, and the mapping introduces nothing the catalogue does not
declare.

### The one stale test, and why it was stale

Eleven of the twelve recovered tests pass against `shell-core` unmodified. One
fails, and `lib/ORIGIN.md` predicted precisely this one: merging the copies
"immediately exposed a stale test in the 6b copy that asserted a model rung 7 had
already disproved".

The archived assertion was:

```ts
const primary   = classFor("primary");
const secondary = classFor("secondary");
const danger    = classFor("danger");
expect(new Set([primary, secondary, danger]).size).toBe(3);
```

— three distinct `className` strings, encoding 6b's original mapping
`btn` / `btn-secondary` / `btn-destructive`. Against `shell-core` it fails with
`expected 1 to be 3`.

**Verdict: stale test, not a defect in `lib/`.** Rung 7 measured that Basecoat
1.0 replaced composed variant *classes* with `data-variant` *attributes*:
`<button class="btn" data-variant="secondary">`. `btn-secondary` does not exist
in the 1.0 bundles at all — only in the optional legacy compat stylesheet. The
corrections file proves this against the real `basecoat-css@1.0.2` package rather
than against the claim: `btn-secondary` and `btn-destructive` are absent from both
`basecoat.cdn.min.css` and `basecoat-base.cdn.min.css`, present in
`basecoat-compat.cdn.min.css`, and `.btn[data-variant=secondary]` and
`.btn[data-variant=destructive]` are what the shipped pack actually styles.

**What changed.** The test is renamed "renders each button variant
distinguishably" and now compares the rendered *signature* — class plus
`data-variant` — instead of the class alone. The rung's claim is unchanged and
still enforced: the three catalogue variants must render distinguishably. What
carries the distinction moved from the class list to an attribute, so the
signature moved with it. Three further assertions were added so the corrected
test is *stricter* than the one it replaces: the class must stay constant at
`btn` (reintroducing `btn-secondary` turns it red), `primary` must **omit** the
attribute rather than set it, and `secondary` / `danger` must map to the exact
attribute values the bundle styles. The whole rewrite is marked in place in the
file, with the original assertion quoted verbatim.

### Verified — recovered tests (`basecoat.test.ts`, 12)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | No catalogue component is unmapped | `unmappedComponents(shellCatalog)` is `[]` — **the reject test** | A component cannot be expressed in Basecoat |
| 2 | The mapping introduces no seventh component | Mapping key set equals catalogue key set | Basecoat needed something the catalogue does not declare |
| 3 | A button is a `btn` | Rendered `className` contains `btn` | The semantic class is dropped |
| 4 | The three variants render distinguishably | *(rewritten — see above)* class + `data-variant` signature, three distinct | Two variants become indistinguishable, or `btn-secondary` returns |
| 5 | A text field is an `input` | Rendered `input.className` contains `input` | The part class is lost |
| 6 | No class soup | The button carries at most three classes | The mapping produces walls of utilities, losing the stated reason to use Basecoat |
| 7 | Row and Column are distinct containers | `[data-layout=column]` and `[data-layout=row]` have different classes | Direction stops being expressed |
| 8 | A divider is a bare `<hr>` | `querySelector("hr")` — an empty class string is a *real* mapping, not a missing one | It renders as something else, or the coverage check treats `""` as unmapped |
| 9 | Text variants get distinct typography | `h1` and `body` classes differ | Variants collapse |
| 10 | Markup is still refused in text | `<img src=x onerror=…>` produces no `img` | `innerHTML` creeps back in |
| 11 | A surface cannot inject arbitrary classes | `class` and `className` props on a component do not reach the element | Class names could originate in a message |
| 12 | Components outside the catalogue are still rejected | `Iframe` throws `/not in catalogue/` | Styling opened a path around validation |

Tests 10–12 are the rung 2 and 3 guarantees re-run under the new markup, because
styling introduced fresh paths for hostile data.

### Verified — corrections (`basecoat-1.0-corrections.test.ts`, 12)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 13 | `btn-secondary` / `btn-destructive` / `btn-primary` ship in **neither** prebuilt pack | Class-selector search over `basecoat.cdn.min.css` and `basecoat-base.cdn.min.css` | Basecoat reintroduces variant classes |
| 14 | They survive **only** in the legacy compat stylesheet | Same search over `basecoat-compat.cdn.min.css` finds `btn-secondary` | The compat path disappears, or the claim was never true |
| 15 | The bundle styles the attribute selectors the mapping targets | `.btn[data-variant=secondary]` and `.btn[data-variant=destructive]` present | The mapping targets selectors that do not exist |
| 16 | The three catalogue variants map onto shipped attribute values | Catalogue enum is `primary/secondary/danger`; `dataVariantFor` gives `undefined`/`secondary`/`destructive` | The mapping and the catalogue drift apart |
| 17 | The semantic classes the mapping relies on **do** exist | `btn`, `label`, `input` defined in the default pack | A mapped class is imaginary |
| 18 | None of the **original** layout utilities exist | `flex`, `flex-col`, `flex-row`, `items-center`, `gap-2`, `grid` absent from the pack | The prebuilt bundle starts shipping utilities |
| 19 | Layout is shell-owned instead | `shell-col` / `shell-row` / `shell-field`, and none of them defined by the vendor | Layout returns to utilities that style nothing |
| 20 | **Open hole**: `Text` variants are *still* Tailwind utilities | Every class the `Text` mapping emits is absent from the pack | Someone moves typography onto shell-owned classes — deliberately red then |
| 21 | `class` / `className` are ignored on **every** styled component | Column, Row, Button, TextField and Text all rendered with hostile props; no element's class matches `/evil/` | A peer can smuggle a class through any component |
| 22 | A message cannot set `data-variant` directly | A component supplying `data-variant: "destructive"` gets no attribute | The 1.0 correction opened a second injection path |
| 23 | A variant outside the enum is rejected | `variant: "evil"` throws `/must be one of/` | `variant` becomes a free-text attribute value written into the DOM |
| 24 | An unmapped component emits no class | `classesFor("Iframe")` is `""`, not `"Iframe"` | A mapping miss becomes a class-name pass-through |

24 tests, all passing. Typecheck clean — verified by pointing `tsc` at both test
files directly, because the app's `tsconfig.json` `include` glob does not match
rung folders and so `pnpm typecheck` never reaches them.

### Security: classes come from the mapping, never the message

This is the property tests 11 and 21–24 exist for, and it is worth stating as a
rule rather than a test. A surface may be authored by a **foreign peer**. If a
class name could arrive in a message, a peer could position itself over the shell
chrome or restyle it arbitrarily. Class names originate in `BASECOAT_CLASSES` and
nowhere else, and the negative is asserted directly: a message that tries to
supply a class must not get it through. The 1.0 correction moved the variant into
an *attribute*, which is a second surface for the same attack, so it is closed
under the same rule — only `variant`, validated against the catalogue enum,
reaches `data-variant`.

### What this rung found

**Typography was left behind by finding 5.** `lib/ORIGIN.md` finding 5 records
that the prebuilt Basecoat bundle contains no Tailwind utilities, and that layout
was therefore moved onto shell-owned classes. `Text` was not moved with it: the
mapping still emits `text-sm`, `text-2xl font-semibold tracking-tight`,
`text-lg font-semibold` and `text-muted-foreground text-xs`, none of which the
prebuilt pack defines. On the zero-build path those variants are **unstyled** —
they differ from one another, which is all the archived test checks, but they are
not styled. What still works is the *tag*: `Text` selects `h1` / `h2` / `p` /
`small`, and Basecoat styles bare elements. Test 20 pins the gap.

`lib/` is read-only for this rung, so this is reported, not fixed. The fix is the
same one finding 5 already applied to layout: shell-owned `shell-h1`, `shell-h2`,
`shell-body`, `shell-caption`, or shipping a Tailwind build after all — which
rung 6a's numbers now say costs almost nothing (see `../06a-tailwind-build/`).

## Techniques and APIs

### The mapping surface

```ts
// lib/basecoat.ts
interface ComponentClasses {
  readonly base: string;                                   // the element's own class
  readonly variants?: Readonly<Record<string, string>>;    // class chosen by `variant`
  readonly parts?: Readonly<Record<string, string>>;       // inner elements it builds
  readonly dataVariants?: Readonly<Record<string, string | undefined>>;
}

const BASECOAT_CLASSES: Readonly<Record<string, ComponentClasses>>;

function unmappedComponents(catalog: Catalog): string[];   // the reject signal
function classesFor(component: string, variant?: string): string;
function partClass(component: string, part: string): string;
function dataVariantFor(component: string, variant?: string): string | undefined;
```

Four properties of this surface do the security work, and none of them is a
check — they are all shapes.

**Every function is total and returns a safe empty value.** `classesFor` on an
unknown component returns `""`, never the component's own name; `partClass` and
`dataVariantFor` likewise. A mapping miss can therefore never become a
class-name pass-through (test 24).

**There is no argument by which a caller supplies a class.** The renderer calls
`classesFor(component, variant)` and gets back whatever the table says. There is
no parameter for "extra classes", so there is nothing for a message to fill.

**`unmappedComponents(catalog)` is the reject condition as a function.** The
rung's pass/fail criterion is executable, and it deliberately distinguishes an
empty-string mapping (`Divider`, which Basecoat styles as a bare `<hr>`) from a
missing one — the check is on key presence, not on truthiness.

**`dataVariants` maps to `string | undefined`, and `undefined` is meaningful.**
It means *omit the attribute*, which is how `primary` is expressed: Basecoat's
default `btn` already is the primary style.

### The `data-variant` contract

```html
<button class="btn">OK</button>                          <!-- primary  -->
<button class="btn" data-variant="secondary">Cancel</button>
<button class="btn" data-variant="destructive">Delete</button>
```

The class stays constant; the variant is an attribute. In `lib/renderer.ts` the
attribute is written in exactly two places — at build time and in `apply()` —
and both go through `dataVariantFor`, which can only return a value the table
holds. A `dv` of `undefined` triggers `removeAttribute`, so switching a rendered
button from `secondary` back to `primary` clears the attribute rather than
leaving it stale.

This mattered more than a rename. The 1.0 correction moved variant selection
from the class list into an *attribute*, which is a second injection surface
that the original mapping did not have. It is closed by the same rule: only
`variant`, validated against the catalogue's enum (`primary | secondary |
danger`), reaches `data-variant`; a message supplying `data-variant` directly is
an undeclared prop and is dropped (test 22), and a message supplying an
out-of-enum `variant` throws before anything renders (test 23).

The corresponding renderer detail is the **render key**, which is 6b's other
contribution. Reconciliation caches elements by key, and the key must include
any property that affects element *identity* — `Text`'s `variant` selects the
tag (`h1` / `h2` / `p` / `small`), so `Text:h1` and `Text:body` are different
keys. Keying on the component name alone left a stale element with the wrong
tag. Styling work surfaced a structural defect that pure-styling tests would
not have found.

### Shell-owned layout classes, and why they exist

```
Column   -> shell-col     .shell-col   { display:flex; flex-direction:column; gap:.75rem }
Row      -> shell-row     .shell-row   { display:flex; flex-direction:row; align-items:center; gap:.5rem }
TextField-> shell-field   .shell-field { display:grid; gap:.375rem }
```

The original 6b mapping used Tailwind utilities: `flex flex-col gap-2`,
`flex flex-row items-center gap-2`, `grid gap-1.5`. **The prebuilt Basecoat
bundle contains no Tailwind utilities** — component classes are defined in
layers, and the utilities are Tailwind's own build output — so on the zero-build
path those class names styled nothing at all. The elements were correct, the
attributes were correct, and the layout was absent. happy-dom could not see it;
a browser could (rung 7).

Roughly a dozen lines of the shell's own CSS keeps the zero-build path intact,
which is the whole point: the shell owns its layout primitives so that shipping
a prebuilt vendor bundle is sufficient. Test 18 asserts the utilities really are
absent from the vendor pack, and test 19 asserts the shell-owned classes are
*not* expected from it.

### Testing against the shipped package, not against the claim

The corrections file reads the real files out of `node_modules/basecoat-css/dist/`
and searches them with a class-selector regex:

```ts
const bcDir = createRequire(import.meta.url)
  .resolve("basecoat-css/package.json").replace(/package\.json$/, "dist/");
const defines = (css: string, name: string) =>
  new RegExp(`\\.${escape(name)}[{,:\\s\\[]`).test(css);
```

This is the technique that settled the stale-test question. "Basecoat 1.0 uses
`data-variant`" is a claim in a note; `btn-secondary` occurring **0** times in
`basecoat.cdn.min.css`, **0** times in `basecoat-base.cdn.min.css` and **19**
times in `basecoat-compat.cdn.min.css` is a fact about the dependency this app
has pinned. The trailing character class matters — a
bare `.btn` substring search matches `.btn-secondary` too, which would have made
the negative assertions pass for the wrong reason.

`basecoat-css` is already a declared dependency at 1.0.2, so these assertions
break loudly if the pin ever moves — which is the correct behaviour for a
mapping defined against a specific vendor release.

## Lessons learned

**An assertion true of an isolated copy fails the moment the copies merge.**
This rung is the worked example of `lib/ORIGIN.md`'s consolidation note. The
6b archive carried its own copy of the renderer *and* its own copy of the
mapping, so its variant test was locally, consistently, permanently green — it
tested a mapping that agreed with it. The test was wrong from the moment rung 7
measured Basecoat 1.0, and nothing could reveal that while the copy was
isolated. Pointing the recovered tests at `lib/` reproduced the exposure
exactly: 11 green, 1 red, and the red one is the one ORIGIN.md names. Duplication
does not merely risk drift; it *hides* drift, and the hiding is the expensive
part.

**"The variants differ" and "the variants are styled" are different claims.**
The archived test asserted the first and was read as establishing the second.
That is how the `Text` mapping still emits Tailwind utilities the prebuilt pack
does not define: the classes are distinct, so the test is green, and the text is
unstyled. A test that compares rendered values to each other can only detect
*collapse*, never *absence*. Asserting against the vendor stylesheet is what
closes that gap, and it is why the corrections file reads real files.

**Finding 5 fixed layout and left typography behind.** Layout moved to
shell-owned classes; typography did not. The fix is the same one already
applied — shell-owned `shell-h1` / `shell-h2` / `shell-body` / `shell-caption` —
or shipping a Tailwind build after all, which rung 6a's corrected numbers now
price at **~291 bytes gzipped rather than 10 KB**: note 29's 22 KB-vs-12 KB
comparison weighed a full style pack against the bare base pack, and like for
like the gap is 1.3 %, not 45 %. That makes "ship the build" a live fix rather
than a trade. See `../06a-tailwind-build/README.md`.

**A rung that can genuinely reject should say so in a function.**
`unmappedComponents(catalog)` returning `[]` *is* the rung's verdict, and it is
one line of test. The converse check — that the mapping introduced no seventh
component — matters just as much, and is the assertion that would have caught
the tempting fix of quietly growing the catalogue.

**Security properties have to be asserted as negatives.** "Classes come from the
mapping" is not established by checking that a button gets `btn`; it is
established by handing a component a hostile `class` prop and proving it does
not arrive. And the negative has to be re-asserted at every new surface — Text
was covered in the archive, but Column, Row, Button and TextField were not, and
`data-variant` did not exist yet.

## Not covered here

- **Nothing visual is verified.** happy-dom, no real browser. Class names and
  attributes are asserted; appearance is not. This is exactly the blind spot that
  hid both rung 7 corrections for a whole rung.
- **The style pack is undecided.** Basecoat ships eight; the corrections file
  measures the default (`basecoat.cdn.min.css`, byte-identical to the `vega`
  pack). Whether the choice is load-bearing for the mapping is untested.
- **`window.basecoat.init()` is never called.** No interactive Basecoat component
  is used yet. It will matter for dropdowns and dialogs, and especially after a
  Dockview layout restore, which rebuilds DOM from a cache.
