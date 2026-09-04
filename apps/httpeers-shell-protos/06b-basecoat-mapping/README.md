# 06b — The Basecoat mapping

`pnpm test 06b-basecoat-mapping`

**Question.** Can the A2UI catalogue render as Basecoat components?

**Answer: yes. All six map, and no seventh was needed.** This rung was flagged as
the one most likely to reject — if the six catalogue components could not be
expressed without inventing a seventh, the catalogue was designed too abstractly.
It did not reject.

Basecoat is the shadcn/ui design language as Tailwind plus **semantic** classes
(`btn`, `input`, `label`), with no React and no framework runtime — which is why
it was chosen over shadcn/ui itself: importing React into a bootstrap shell would
contradict the static-hosting constraint (note 23 §2).

## Two files, and the difference between them matters

| File | Status |
|---|---|
| `tests/basecoat.test.ts` | **RECOVERED** from `28-prototype-06b-basecoat-mapping/proto6b-basecoat/test/basecoat.test.ts`. Two edits only: imports repointed at `../../lib/*`, and one test rewritten — see below. |
| `tests/basecoat-1.0-corrections.test.ts` | **RECONSTRUCTED** from note 29 and `lib/ORIGIN.md` findings 4 and 5. The archive predates both corrections, so it has no test for either. |

The archive holds a **superseded** copy of the renderer and of the mapping. The
tests here run against `lib/`, the consolidated `shell-core`, exactly as
`lib/ORIGIN.md` says they should.

## The one stale test, and why it was stale

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

## Verified — recovered tests (`basecoat.test.ts`, 12)

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

## Verified — corrections (`basecoat-1.0-corrections.test.ts`, 12)

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

24 tests, all passing. Typecheck clean.

## Security: classes come from the mapping, never the message

This is the property tests 11 and 21–24 exist for, and it is worth stating as a
rule rather than a test. A surface may be authored by a **foreign peer**. If a
class name could arrive in a message, a peer could position itself over the shell
chrome or restyle it arbitrarily. Class names originate in `BASECOAT_CLASSES` and
nowhere else, and the negative is asserted directly: a message that tries to
supply a class must not get it through. The 1.0 correction moved the variant into
an *attribute*, which is a second surface for the same attack, so it is closed
under the same rule — only `variant`, validated against the catalogue enum,
reaches `data-variant`.

## What this rung found

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
