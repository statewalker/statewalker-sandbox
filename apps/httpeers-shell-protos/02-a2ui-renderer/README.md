# 02 — A JSON spec renders against a catalogue

`pnpm test 02-a2ui-renderer`

## Goal

**Question**: can a JSON spec render into one DOM root against a catalogue?

**Answer: yes.** The A2UI v0.9.1 adjacency-list model renders correctly, and
the catalogue genuinely constrains what may be sent — not by policy, by
construction.

### Why this rung came first

This was the riskiest rung, and it was deliberately moved to the front of the
ladder. A2UI had been adopted as *the* way to define and render every
interface in the shell (note 05 §4) before a single line had been written
against it, and two earlier claims about the protocol had already turned out
to be wrong: A2UI is at v0.9/v0.9.1, not v1.0 — v1.0 was **A2A**, a different
protocol — and v0.8's `beginRendering`/`surfaceUpdate` had been renamed to
`createSurface`/`updateComponents` in v0.9. A protocol chosen on a misreading
is worth discovering at rung 2, not rung 9.

### Why it mattered at this point in the ladder

Rung 2 is where the **security boundary** for everything peer-served gets
established. The whole httpeers premise is that a remote peer can serve a user
interface into your shell; a peer-served surface is a foreign application's
output. The catalogue is the complete enumeration of what that foreign output
is permitted to express. Rungs 3, 6b, 7 and 9 all build on the assumption that
this enumeration actually holds.

**Had it answered no**, the damage would have been wide:

- If the adjacency-list model had not rendered, A2UI would have been the wrong
  protocol, and note 05's decision to use it for *all* interfaces — local apps
  as a degenerate zero-latency case — would have had to be reopened. The
  fallback, `vercel-labs/json-render`, is React-based, which contradicts the
  shell's zero-build static-hosting constraint.
- If the catalogue had **not** constrained what a peer may send, the
  structural-enforcement principle would have collapsed into a policy check.
  Every later rung's safety argument reduces to "the component does not exist,
  so it cannot be rendered". A renderer that falls back to a generic element,
  or that trusts a component name it does not know, invalidates that argument
  everywhere at once.
- If the catalogue had needed a seventh component to express a dialog body and
  a notification — the two prototype-1 commands that take a `surface` — the
  design would have been too abstract to be a boundary at all.

## Findings

Tests run against the **consolidated** `lib/` renderer, not the rung-2 copy in
`19-prototype-02-a2ui-renderer.tar.gz`. `tests/render.test.ts` is recovered
from that archive; only the import paths and one assertion changed — see
"The one archived test that did not survive".

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A surface renders nothing until components arrive | `createSurface` alone leaves `root.textContent` empty | An empty surface paints something |
| 2 | A single `Text` at `id: "root"` renders | Root found by convention, not by a pointer in the message | The root has to be named explicitly |
| 3 | Components for an unknown surface are refused | `updateComponents` for a surface never created throws `Unknown surface` | A surface is created implicitly by an update |
| 4 | `deleteSurface` removes the host element | Text is gone from `root` afterwards | The host element leaks |
| 5 | The tree is built from **id references**, not nesting | `Column` naming `["title","body"]` produces `h1` + text | Children have to be inlined |
| 6 | Components may arrive in **any order** | Leaf sent first, root last, renders identically | The renderer depends on topological order |
| 7 | Update is **incremental** | Re-sending only `b` changes `b` and leaves `a` alone | The whole tree must be re-sent per change |
| 8 | A **dangling** child reference throws | `children: ["missing"]` throws rather than rendering a hole | A missing id degrades silently |
| 9 | A **reference cycle** is detected | Mutually-referencing `Column`s throw `cycle` | Stack overflow — an error a malicious peer could trigger deliberately |
| 10 | A component **outside the catalogue** is rejected, naming the catalogue | `ScriptTag` throws `not in catalogue <catalogId>` | Any component name renders |
| 11 | A **missing required property** is rejected | `Text` with no `text` throws, naming `text` | Required props are advisory |
| 12 | An unsupported `catalogId` is rejected at `createSurface` | A foreign catalogue URI throws | The renderer renders against a catalogue it does not implement |
| 13 | Text **never becomes markup** | `<img src=x onerror=alert(1)>` renders as visible text; `querySelector("img")` is null | `innerHTML` anywhere on the text path |
| 14 | `Button` renders its label child and its Basecoat class | `button.textContent === "OK"`, `className === "btn"`, no `data-variant` for `primary` | See "The one archived test that did not survive" |
| 15 | `Row`, `Divider` and `TextField` render | `input` and `hr` both present | A catalogue component has no element factory |
| 16 | The catalogue is **data** | `JSON.stringify(shellCatalog)` does not throw; `catalogId` is an `https:` URI | The catalogue cannot be published at its own URI or negotiated with a peer |

### Why the catalogue is the security boundary

A2UI's own guidance is that production applications define their own catalogue
rather than using the eighteen-component basic one. For httpeers the argument
is stronger than design consistency.

**A peer-served surface is a foreign application's output.** Six components:
`Text`, `Column`, `Row`, `Divider`, `Button`, `TextField`. Anything absent
cannot be rendered — not because a rule forbids it, but because no code exists
that would build it. Rows 10–13 are what hold that up.

Two supporting properties come from the same reading:

- **Validate before mutate.** A whole `updateComponents` batch is validated
  before any of it is stored, so a bad batch cannot leave a surface
  half-updated. This matters more here than in a typical renderer, because the
  batch may come from a peer whose correctness is not guaranteed.
- **Actions are declared by name.** `{"action": {"event": {"name": "confirm"}}}`
  is a *request*; the shell decides what, if anything, it maps to. Rung 2
  records the name and attaches no handler at all — rendering an action and
  honouring it are separate concerns, and only the second needs the shell's
  trust. Dispatch is rung 3.

## Techniques and APIs

### The renderer under test is `lib/`, not the archive

`lib/` is `shell-core`: the renderer consolidated from rungs 2, 3, 6b and 7
(`lib/ORIGIN.md`). The archived `proto2-a2ui-render/src/` is a **superseded**
copy and is not in this app. Read the archive for how a finding was reached;
read `lib/` for what the code is. Imports here are `../../lib/catalog.js` and
`../../lib/renderer.js`.

One consequence to keep in mind while reading the tests: `lib/` is strictly
more capable than the renderer these assertions were written for. Rung 2 did a
full repaint per update and attached no click handler; `lib/` does keyed
reconciliation and dispatches actions. All sixteen assertions still hold,
because they only ever constrained structure and validation.

### The A2UI v0.9.1 message subset

Four server-to-client messages, every one carrying a `version` field. Rung 2
uses the first two and the last.

| Message | v0.8 name | Used by rung 2 |
|---|---|---|
| `createSurface` | `beginRendering` | yes |
| `updateComponents` | `surfaceUpdate` | yes |
| `updateDataModel` | — (v0.9 addition) | no — rung 3 |
| `deleteSurface` | — | yes |

```ts
interface A2uiMessage {
  readonly version: string;
  readonly createSurface?: {
    readonly surfaceId: string;
    readonly catalogId: string;                 // must match the renderer's
    readonly theme?: Record<string, unknown>;   // ACCEPTED AND IGNORED
  };
  readonly updateComponents?: {
    readonly surfaceId: string;
    readonly components: Component[];
  };
  readonly updateDataModel?: {                  // rung 3
    readonly surfaceId: string;
    readonly path: string;
    readonly value: unknown;
  };
  readonly deleteSurface?: { readonly surfaceId: string };
}

interface Component {
  readonly id: string;
  readonly component: string;
  readonly [prop: string]: unknown;             // props are open, validation closes them
}
```

The v0.8 → v0.9 rename is the reason this rung exists in the shape it does:
material written against `beginRendering`/`surfaceUpdate` describes a protocol
this code does not speak. Spec churn remains a live risk and no pinning
strategy is decided.

Two structural facts do a lot of work:

- **Components are a flat adjacency list.** The tree is implicit, built from id
  references at render time, which is what makes rows 6 and 7 possible: any
  arrival order, and incremental update by id.
- **`catalogId` is a URI that is NOT fetched at runtime.** It is an identifier
  for negotiation; both sides compile the catalogue in. Row 12 checks the
  identifier, and no network call is involved.

### The catalogue API

```ts
type PropType = "string" | "boolean" | "number" | "id" | "id[]" | "enum";

interface PropDef  { readonly type: PropType; readonly required?: boolean;
                     readonly values?: readonly string[]; }   // values: enum only
interface ComponentDef { readonly props: Readonly<Record<string, PropDef>>;
                         readonly childProp?: string;      // single-child container
                         readonly childrenProp?: string; } // multi-child container
interface Catalog  { readonly catalogId: string;
                     readonly components: Readonly<Record<string, ComponentDef>>; }

export const shellCatalog: Catalog;  // https://httpeers.dev/catalogs/shell/v1/catalog.json
```

| Component | Props | Container |
|---|---|---|
| `Text` | `text*`, `variant` (body/h1/h2/caption) | — |
| `Column` | `children*` | multi (`childrenProp`) |
| `Row` | `children*` | multi (`childrenProp`) |
| `Divider` | — | — |
| `Button` | `child*`, `variant` (primary/secondary/danger), `action` | single (`childProp`) |
| `TextField` | `value`, `label`, `placeholder`, `action` | — |

`*` required. **How the constraint is enforced**, in `validate()`:

1. `catalog.components[c.component]` missing → throw. There is no default case,
   no generic element, no passthrough. This is the whole security argument.
2. Every declared prop that is `required` and `undefined` → throw.
3. `type: "enum"` with a value outside `values` → throw. **Literals only** — a
   binding stands in for any scalar and is skipped, which is the known hole
   rung 3 documents.
4. `type: "id[]"` that is not an array → throw.

Note what is *not* checked: a component may carry properties the catalogue does
not declare, and they are ignored rather than rejected. That is deliberate — the
renderer never reads `class`, `className` or `style` from a message at all, so
an undeclared property has no path to the DOM. Classes originate in
`lib/basecoat.ts` and nowhere else.

### `createRenderer`

```ts
function createRenderer(
  root: HTMLElement,
  catalog: Catalog,
  options?: RendererOptions,   // rung 3: onAction, onDataModelChange
): Renderer;

interface Renderer {
  handle(message: A2uiMessage): void;
  surfaces(): string[];
  dataModel(surfaceId: string): Record<string, unknown> | undefined;
}
```

`handle` is the entire inbound surface: one function, four message shapes, no
transport. Errors are thrown, never returned — a peer that sends nonsense gets
an exception at the shell boundary rather than a half-rendered surface. The
full list is in rung 03's README §"Errors thrown by `handle`"; rows 3 and
10–12 above exercise four of the seven.

**One host element per surface.** Each `createSurface` appends its own
`<div data-surface="...">` under `root`, so multiple surfaces coexist without
interfering. Only one is exercised at this rung.

### Keyed reconciliation and the render key

Rung 2's own renderer repainted the whole surface on every update. `lib/`
does not, and the tests here pass against the better algorithm:

```
paint(surface):
  no component with id "root"  -> host.replaceChildren()   (empty surface, row 1)
  else tree = reconcile("root", seen = {})
       if host.firstChild !== tree: host.replaceChildren(tree)

reconcile(id, seen):
  id in seen                    -> throw "Component reference cycle"   (row 9)
  component missing             -> throw "referenced but missing"      (row 8)
  validate(component)                                                  (rows 10-11)
  renderKey = "Text:<variant>" for Text, else component name
  cached element absent, or its data-render-key differs -> build()
  apply(component, element)                        // mutate in place, never replace
  for each child id: reconcile(childId, seen + {id})
  only call replaceChildren when the child list ACTUALLY differs
```

The **render key** is the rule that a cached element is reused only when every
property affecting element *identity* is unchanged — not merely the component
name. `Text`'s `variant` selects the tag (`h1`/`h2`/`p`/`small`), so it is part
of the key. Rung 03's `reconciliation.test.ts` asserts this directly; here it
is only visible as row 5's `h1`.

Elements carry test-visible attributes, all of them written by the renderer and
never copied from a message: `data-surface`, `data-component`,
`data-render-key`, `data-layout` (`row`/`column`), `data-action`, and
`data-variant`.

### happy-dom specifics

`vitest.config.ts` sets `environment: "happy-dom"` for the whole app and
collects `**/tests/**/*.test.ts`. Every test here builds its own `root` div in
`beforeEach` and appends it to a cleared `document.body`, so nothing leaks
between cases.

What happy-dom supplies that these tests depend on: `document.createElement`
for six tag names, `querySelector`, `textContent` versus `innerHTML` semantics
(row 13 is meaningless without a real HTML parser distinction), and
`Element.replaceChildren`.

**What it does not supply is layout or CSS.** No class in row 14 is verified to
*do* anything; only that the string is present. That gap is real and was
expensive later — note 35 records a bug sixty-one unit tests missed, found only
by rendering in a browser, and rung 6b's Tailwind-utilities-not-in-the-bundle
finding was invisible to any DOM shim. Treat a green run here as evidence about
structure and validation, never about appearance.

## The one archived test that did not survive

Fifteen of the sixteen archived assertions passed against `lib/` unchanged.
One failed:

```
× shell components > renders a button with its label child
  expected null to be 'primary'
```

**Verdict: the test is stale; `lib/` is right.** Rung 2's own renderer echoed
the message's variant string verbatim onto the element —
`if (c["variant"]) el.setAttribute("data-variant", String(c["variant"]))` —
so `variant: "primary"` produced `data-variant="primary"`, and the assertion
was true of the code it was written against. Rung 7 then measured Basecoat 1.0
and found that a bare `.btn` **is** the primary button; `data-variant` selects
only a non-default variant. `lib/basecoat.ts` therefore maps
`primary → undefined`, meaning *omit the attribute* (note 32 §1):

| Catalogue variant | Basecoat expression |
|---|---|
| `primary` | `class="btn"`, attribute **omitted** |
| `secondary` | `class="btn" data-variant="secondary"` |
| `danger` | `class="btn" data-variant="destructive"` |

The assertion was corrected in place to the live contract, with the history
kept at its site. This is the same drift consolidation caught in the 6b copy
(`lib/ORIGIN.md`, "Why consolidation happened"): a stale test in an isolated
copy is invisible and becomes a failure the moment the copies meet.

It is also a small improvement in the security story. Rung 2 copied an
attribute value out of a peer's message onto an element; the enum check kept it
to three known values, but the value's *origin* was the message. In `lib/` the
attribute value originates in the mapping table and nowhere else, which is the
same rule that governs class names.

## Lessons learned

**A catalogue is only a boundary if there is no default case.** The strength of
rows 10–13 comes from `validate()` throwing on an unknown component and
`build()` having no fallback branch — two small absences, not a policy layer.
Any future component added to the catalogue must be added to both, and a
generic "render anything with a tag name" escape hatch would silently undo
every downstream safety argument.

**Cycle detection is a security control, not a nicety.** Removing it (note 20's
mutation test) does not produce a wrong render — it produces
`Maximum call stack size exceeded`. That is precisely the failure a hostile
peer would reach for, and it costs one `Set`.

**`textContent`, never `innerHTML`, on every path.** Rung 2 established it for
literals; rung 3 had to re-assert it for bindings because binding opened a
second route for the same hostile data. Adding a third source of text — an
attribute, a tooltip, a label — means adding a third assertion.

**Two claims about a protocol were wrong before anyone read the spec.** The
version number and the message names were both wrong in this project's own
notes. Reading the specification properly was the single highest-value action
of the rung. Anything in the record describing `beginRendering` or
`surfaceUpdate` predates the rename and should be distrusted.

### The restoration lesson

**An assertion that is true of its own copy becomes false the moment the copies
merge.** The `data-variant="primary"` assertion was not sloppy: it correctly
described rung 2's renderer, passed on the first run, and survived
mutation testing. It became wrong because the *code it described* was later
corrected in a different copy. While the copies stayed isolated, nothing could
detect that — which is exactly `lib/ORIGIN.md`'s argument for consolidating.

A future reader restoring another rung should therefore expect archived tests
to encode superseded models, and should treat a failure against `lib/` as a
question, not a verdict. The two possible answers look identical from the test
output: *the test is stale* (correct here) or *`lib/` regressed*. Distinguishing
them needed the archived `src/` — reading what the old renderer actually did is
what proved the assertion had once been true.

What to distrust in the written record:

- **Note 24's "Reconciliation contract"** still says "An element is rebuilt only
  when the component type at that id changes." Rung 6b disproved that; the
  render key includes `Text`'s variant. See rung 03's README.
- **Note 29's Basecoat table** lists `btn-secondary` / `btn-destructive`
  classes. Rung 7 replaced those with `data-variant` attributes; they exist
  only in Basecoat's optional legacy compat stylesheet.
- **Note 20 §6** says actions are recorded as `data-action` with no handler
  attached. True of rung 2, not of `lib/`, which dispatches.

## Not covered here

- **No data binding, no `updateDataModel`, no action dispatch** — rung 3.
- **No theming.** `createSurface` accepts a `theme` and ignores it; honouring a
  peer-supplied theme is a security question, not only a design one.
- **No Basecoat mapping tests.** Row 14's class assertions are incidental; the
  mapping itself is rung 6b's subject.
- **No multi-surface coordination**, no dock layout, no panes — rung 7.
- **No transport.** Messages are handed to `handle()` directly.
- **No catalogue negotiation.** Exactly one `catalogId` is accepted; the
  client-capabilities envelope and v0.9's dynamic catalogues are unexplored.
  Dynamic catalogues switch schemas at runtime to match user permissions, which
  maps directly onto prototype 1's capability filtering and is probably how a
  peer-scoped catalogue should work.
- **No conformance testing** against the official `standard_catalog.json` or the
  envelope schemas. Message shapes follow the published documentation only.
- **The catalogue is hand-written TypeScript.** It should be a JSON Schema
  document, and probably generated, like the manifest.
- **Heading semantics are unresolved.** `Text` variants map to `h1`/`h2`/`p`/
  `small`, which lets an agent choose heading levels. Whether that is an
  accessibility mistake — headings being properly a function of document
  structure — is open.
- **Full repaint.** Rung 2 repainted the whole surface on update, destroying
  focus. Invisible with static text, fatal once a `TextField` is bound — the
  reason rung 3 exists. `lib/` no longer behaves this way, so these tests pass
  against a renderer strictly better than the one they were written for.
