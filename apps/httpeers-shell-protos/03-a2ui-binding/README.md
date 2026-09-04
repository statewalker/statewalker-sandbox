# 03 — Data binding and action dispatch round-trip

`pnpm test 03-a2ui-binding`

## Goal

**Question**: do data binding and action dispatch round-trip — can a surface be
made interactive without re-sending the component tree, and do user actions
travel back out?

**Answer: yes, on both counts.** But the interesting result is not the answer;
it is what repairing rung 2's defect turned up.

### Why it mattered at this point in the ladder

Rung 3 exists because **rung 2 created a problem it could not see**. Rung 2
repainted the whole surface on every update, which is correct and invisible for
static text, and fatal the moment a `TextField` is bound to a data model: the
user's focus and caret are destroyed by any update anywhere else in the
surface. Note 20 closed by predicting rung 3 would hit this immediately. It did.

So this rung carries two questions at once — one about the protocol (does
binding work?) and one about the repair (can a surface be interactive at all?).
The second is the load-bearing one. Everything above this rung assumes a peer
can serve a *usable* form: rung 7 puts surfaces in dock panes, rung 9 has them
arrive from peers. A shell whose text fields lose the caret on every keystroke
elsewhere is not shippable, and no amount of later work would have papered over
it.

**Had it answered no**, three things would have been invalidated:

- **Binding.** If a bound value could not update without re-sending the
  component tree, A2UI's separation of data model from UI structure would buy
  nothing, and every update would be a full tree push — pointless over a
  network transport, which is the whole reason a peer-served UI protocol was
  chosen.
- **Interactivity.** If focus could not survive an update, the catalogue's
  `TextField` would be undeliverable and the catalogue would shrink to a
  read-only surface. Rung 2's answer would still be "yes", and worthless.
- **Trust in the shell's stability.** If a foreign peer's action could throw
  into the shell, or if a server update echoed back into a loop, a hostile or
  merely buggy peer could wedge the host. Rows 12 and 15 are the ones that say
  it cannot.

The repair also produced the rung's most transferable finding, which is a claim
about the DOM rather than about this code — see Lessons learned.

## Findings

Three additions to rung 2's renderer:

| Feature | Mechanism |
|---|---|
| Data binding | `{"path": "/user/name"}` in place of a literal, resolved at render time |
| Server → client | `updateDataModel` writes a path, then repaints |
| Client → server | `TextField` input writes back and notifies the host |
| Action dispatch | click reads the action name and calls `onAction` with a data-model snapshot |

Two suites, 21 tests. `binding.test.ts` is **recovered** from
`21-prototype-03-a2ui-binding.tar.gz` (17 tests) with only its imports
rewritten to `../../lib/`; every assertion passed against the consolidated
renderer unchanged. `reconciliation.test.ts` is **reconstructed** — four
assertions written from the notes for claims the archive states in prose and
never checks. Each carries a `DERIVED-FROM-NOTE` marker.

### Data binding (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A bound value renders from the data model | `text: {path:"/user/name"}` with `/user` set to `{name:"Ada"}` renders `Ada` | Bindings are treated as literal objects |
| 2 | A bound component updates with **no `updateComponents`** | Two `updateDataModel` messages move the text `1` → `2` | The tree has to be re-sent to change a value |
| 3 | An unresolved path renders empty, not an error | `/nothing/here` yields `""` | A partial data model throws and wedges the surface |
| 4 | A nested write does not clobber siblings | Writing `/f/a` leaves `/f/b` intact | Path writes replace the parent object |
| 5 | Data models are **per surface** | Two surfaces both hold `/v` with different values | One model leaks between surfaces |

### Focus (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 6 | An unrelated bound change does not steal focus | Type into a `TextField`, update `/status`; the same `input` instance is still `document.activeElement` with `selectionStart === 3` | Rule 1 below is dropped |
| 7 | The field being edited is never overwritten | `input.value` stays `"typing"` across a server update to another path | Rule 2 below is dropped |

### Action dispatch (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 8 | A click emits the action name and surface id | `onAction` called with `{surfaceId:"dialog", name:"confirm"}` | Actions render but never dispatch |
| 9 | The declared `context` travels with it | `context: {id:"note-7"}` arrives on the event | Context is dropped, and a list button cannot say which row it is |
| 10 | A **snapshot of the data model** travels with every action | `dataModel` contains `{name:"Ada"}` | A submit button needs a separate collection step |
| 11 | A button with no action does nothing | `onAction` not called. Silence, not an error | An actionless button throws, and a peer can crash the shell with an omission |
| 12 | A **throwing handler cannot wedge the surface** | The click does not throw, and the surface still accepts `updateDataModel` afterwards | A foreign peer's surface can break the shell by triggering a handler that fails |

### Client-to-server flow (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 13 | User input writes back into the data model | An `input` event puts `Grace` at `/name` | The model is server-authoritative only |
| 14 | The host is notified of **user-originated** changes | `onDataModelChange` fires with path and value | The host cannot observe local edits |
| 15 | A **server** update stays silent | `onDataModelChange` is not called for `updateDataModel` | The two sides echo: server updates model → client reports change → server updates model |

### Rung 2 guarantees, re-asserted (recovered)

Binding opened a fresh path for hostile data, so two rung-2 properties are
re-checked under it.

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 16 | A **bound** value containing markup renders as text | `/evil` = `<img src=x onerror=alert(1)>`; no `img` element exists | The binding path uses `innerHTML` where the literal path did not |
| 17 | Components outside the catalogue are still rejected | `Script` throws `not in catalogue` | Binding introduced a way around validation |

### The reconciliation contract (reconstructed)

| # | Claim | How it is established | Fails if | Source |
|---|---|---|---|---|
| 18 | `replaceChildren` blurs even with **identical instances** | Focus an `input`, call `host.replaceChildren(input)`; identity holds, `isConnected` is true, `activeElement` is no longer the input | The platform stops doing this — in which case rule 1 is dead weight and nothing else would say so | note 22 §3 |
| 19 | The renderer does not call `replaceChildren` when the child list is unchanged | The container's `replaceChildren` is wrapped and counted; an `updateDataModel` that changes a sibling's text records **zero** calls while the text still updates | Rule 1 is implemented as "diff the elements" rather than "diff the list" | note 24 §Reconciliation contract, rule 1 |
| 20 | The render key includes any property that affects **element identity** | Same id, same `component`, `variant` `body` → `h1`: the tag becomes `H1`, the element is a *different* instance, and no stale `p` remains | The cache is keyed on component type alone and a variant change leaves a stale tag | note 29 §"A bug found in the rung 3 renderer" |
| 21 | …and is not so coarse that everything rebuilds | Changing only `text` at a fixed `variant` returns the **same** element instance | Rules 1 and 2 stop protecting anything, because every update replaces the element |

## Techniques and APIs

### The renderer under test is `lib/`, not the archive

`lib/` is `shell-core`: the renderer consolidated from rungs 2, 3, 6b and 7
(`lib/ORIGIN.md`). The archived `proto3-a2ui-binding/src/` is a **superseded**
copy and is not in this app. Imports are `../../lib/catalog.js` and
`../../lib/renderer.js`. Unlike rung 02, no recovered assertion here needed
correcting — every one of the 17 holds against the consolidated code.

### The renderer surface

```ts
function createRenderer(
  root: HTMLElement,
  catalog: Catalog,
  options?: RendererOptions,
): Renderer;

interface Renderer {
  handle(message: A2uiMessage): void;
  surfaces(): string[];
  dataModel(surfaceId: string): Record<string, unknown> | undefined;
}

interface RendererOptions {
  onAction?(event: ActionEvent): void;
  /** USER-originated changes only. Never fires for server updates. */
  onDataModelChange?(change: DataModelChange): void;
}

type Binding = { readonly path: string };   // stands in for any scalar prop

interface ActionEvent {
  readonly surfaceId: string;
  readonly name: string;
  readonly context?: Record<string, unknown>;
  readonly dataModel: Record<string, unknown>;   // snapshot at click time
}

interface DataModelChange {
  readonly surfaceId: string;
  readonly path: string;
  readonly value: unknown;
}
```

Three methods and two callbacks is the whole API. Note the asymmetry that does
most of the work: **inbound is one function taking a tagged union**
(`handle`), **outbound is two named callbacks**. There is no subscribe, no
event emitter, no removal — a renderer's listeners are fixed at construction,
and disposal is `deleteSurface` plus dropping the reference.

`dataModel(surfaceId)` returns the **live object**, not a copy. Tests use it as
an oracle (rows 5, 12, 13); a caller must not mutate it.

### The A2UI v0.9.1 message subset

Four server-to-client messages, each carrying `version`. Rung 3 is the first to
use `updateDataModel`.

| Message | v0.8 name | Role at this rung |
|---|---|---|
| `createSurface` | `beginRendering` | allocates the surface, its host element and its empty data model |
| `updateComponents` | `surfaceUpdate` | validate-then-store the adjacency list, then paint |
| `updateDataModel` | — (v0.9 addition) | write one path, then paint. **Silent** on `onDataModelChange` |
| `deleteSurface` | — | remove the host element and forget the surface |

The v0.8 → v0.9 rename matters when reading older material: anything describing
`beginRendering` or `surfaceUpdate` predates it. A2UI is a draft at v0.9.1 and
no pinning strategy is decided.

### Paths and the data model

Paths are **JSON-pointer-ish**: `/` separated, empty segments dropped. There is
no escaping (`~0`/`~1` are not implemented), no array indexing semantics beyond
ordinary property access, and no schema.

- **Read** (`readPath`) returns `undefined` rather than throwing on a missing
  intermediate — row 3. `resolve()` then renders `undefined` and `null` as `""`
  and everything else via `String(...)`.
- **Write** (`writePath`) is **copy-on-write and non-destructive**: it clones
  each object along the path, creating missing intermediates as `{}`, and
  replaces only the leaf — row 4. A non-object intermediate is replaced by a
  fresh object rather than throwing.
- A write to the empty path `/` replaces the whole model if the value is an
  object, and is ignored otherwise.

Because each write produces a new top-level object, a caller holding a previous
`dataModel()` result holds a stale snapshot — which is precisely what makes
row 10's action snapshot meaningful.

### Contracts a caller must know

| Contract | Consequence |
|---|---|
| `onDataModelChange` fires **only** for user input | Server updates do not echo back; without this the two sides loop (row 15) |
| A throwing `onAction` is caught and logged | A foreign surface cannot wedge the shell (row 12) |
| The action is read from the **current** component at click time | An updated action takes effect without rebuilding the element |
| Bindings **skip** enum and type validation | The value is unknown until render — a known hole, see below |
| Text is always `textContent` | A bound value from a peer can never become markup (row 16) |
| A whole `updateComponents` batch validates before any mutation | A bad batch cannot half-update a surface |

### Errors thrown by `handle`

Everything below is a throw, not a silent degradation. A peer that sends
nonsense gets an exception at the shell boundary rather than a half-rendered
surface.

| Error | Raised by |
|---|---|
| `Unsupported catalog "<id>"` | `createSurface` naming a catalogue this renderer does not implement |
| `Unknown surface "<id>"` | Any update for a surface never created |
| `Component "<type>" is not in catalogue <id>` | A component name outside the six |
| `Component "<id>" (<type>) is missing required property "<name>"` | Validation, before any mutation |
| `Property "<name>" on "<id>" must be one of ...` | An enum value outside the catalogue's list — **literals only** |
| `Component "<id>" is referenced but missing` | A dangling child reference |
| `Component reference cycle through "<id>"` | Mutual references, caught before the stack overflows |

Two asymmetries a caller should not be surprised by. `deleteSurface` for an
unknown surface is a **no-op**, not an error — the only message that tolerates a
missing surface. And a message with none of the four keys set is silently
ignored, so a typo in a message key fails quietly; there is no "unrecognised
message" error.

### The catalogue

Unchanged from rung 2 — six components, `Text` / `Column` / `Row` / `Divider` /
`Button` / `TextField`, published under
`https://httpeers.dev/catalogs/shell/v1/catalog.json`. **The catalogue is the
security boundary**: a peer-served surface may express exactly these six and
nothing else, not by policy but because no code exists that would build
anything more. Row 17 re-asserts it under binding. Rung 02's README documents
the type definitions and the `validate()` rules.

Binding punches one deliberate hole in it: `validate()` skips enum and type
checks when a property is a `Binding`, because the value is not known until
render. A binding may therefore resolve to a value the catalogue forbids. See
Not covered here.

### Keyed reconciliation

```
paint(surface):
  no component with id "root"  -> host.replaceChildren()
  else tree = reconcile("root", seen = {})
       if host.firstChild !== tree: host.replaceChildren(tree)

reconcile(id, seen):
  id in seen        -> throw "Component reference cycle"
  missing component -> throw "referenced but missing"
  validate(component)
  renderKey = "Text:<variant>" for Text, else the component name
  no cached element, or its data-render-key differs -> build(); cache by id
  apply(component, element)                  // RULE 2 lives here
  built = children.map(childId -> reconcile(childId, seen + {id}))
  same = el.childNodes.length === built.length
         && built.every((child, i) => el.childNodes[i] === child)
  if (!same) el.replaceChildren(...built)    // RULE 1
```

`build()` runs once per element and installs the DOM listeners; `apply()` runs
on every paint and only mutates properties. The split is what makes rows 6 and 7
possible — a listener is never re-registered, and the element the user is typing
into is never recreated.

Two details inside `build()` are easy to miss and are load-bearing:

- Both the click and the `input` listener re-read `surface.components.get(c.id)`
  at event time rather than closing over the component captured at build time,
  so an action or a binding replaced by a later `updateComponents` takes effect
  without rebuilding the element.
- The `input` listener writes the model, calls `onDataModelChange`, **and then
  repaints**. That repaint would normally clobber the field being typed into,
  which is exactly why rule 2 exists.

Paint is `O(tree)` and re-validates every component on every message. See Not
covered here.

### happy-dom specifics

`vitest.config.ts` sets `environment: "happy-dom"` app-wide and collects
`**/tests/**/*.test.ts`. This rung leans on the DOM shim much harder than rung 2
does, because focus is a *document*-level property:

- `document.activeElement`, `HTMLElement.focus()` — rows 6, 7, 18.
- `HTMLInputElement.setSelectionRange` / `selectionStart` — row 6 asserts the
  caret, not merely the focus.
- `Element.isConnected` — row 18 needs to show the node is still in the document
  *and* blurred, which is the whole point.
- `new Event("input", { bubbles: true })` dispatched by hand — rows 13, 14.
  happy-dom does not synthesise input events from assigning `.value`, so the
  tests set the value and dispatch explicitly, which is also closer to what a
  real keystroke does.
- `HTMLButtonElement.click()` — rows 8–12.
- Monkey-patching `element.replaceChildren` on a live node — row 19.

Each test rebuilds `document.body` in `beforeEach`, which matters more here than
elsewhere: focus is global state, and a leaked `activeElement` from a previous
test would make row 6 or 7 pass for the wrong reason.

**The limit**: happy-dom has no layout, no styles and no real event loop, so
nothing here proves anything about appearance, scroll anchoring, IME
composition, or `input` versus `change` timing in a browser. Note 35 records a
bug that sixty-one unit tests missed and only a real browser caught. Row 18 was
checked to reproduce under happy-dom rather than assumed — see below.

## Lessons learned

**`replaceChildren` blurs the active element even when passed identical
instances.** This is the rung's expensive finding and it is a claim about the
platform, not about this code. The obvious fix for rung 2's repaint problem —
keyed reconciliation, cache elements by id, mutate in place, never replace — was
implemented, and the focus test *still failed*. Debugging showed element
identity was preserved, the input was still connected to the document, and
`document.activeElement` had nevertheless reverted to `body`. `replaceChildren`
detaches and reattaches every child, and reattaching blurs. **Identity
preservation is necessary but not sufficient.**

The fix is to diff the child *list* and only touch the DOM when it differs.
Note that this is a general lesson for any renderer over this protocol.

This claim is now asserted directly (row 18) rather than left in prose, and it
was **verified to reproduce under happy-dom** rather than assumed from the
browser measurement: focus an input, `host.replaceChildren(input)` with the same
instance, and `activeElement` becomes `body` while `isConnected` stays true. If
a future DOM implementation stops doing this, rule 1 becomes dead weight and row
18 is the only thing that would say so.

**Never write `input.value` while that input is `document.activeElement`.** The
sibling rule, and the reason a server update to an unrelated path cannot destroy
in-progress typing (row 7). It is cheap, it is one `if`, and it is invisible
until someone types.

**The render key must include every property that affects element identity**,
not just the component name. Rung 6b found this while doing styling work:
reconciliation keyed the cache on component *type*, but `Text`'s `variant`
selects the *tag*, so changing variant at the same id left a stale element with
the wrong tag. Styling work surfaced a structural defect that pure-styling tests
would not have found. Rows 20 and 21 pin both directions — coarse enough to
rebuild when the tag changes, fine enough not to rebuild on every text change.

**The two rules only matter together.** Rule 1 protects focus across a repaint;
rule 2 protects the value; the render key decides when the element survives at
all. Weaken any one and the other two stop mattering, which is why row 21
exists — a render key that rebuilt on every update would pass rows 18–20 and
break rows 6 and 7.

### The restoration lesson

**An assertion that is true of its own copy becomes false when the copies
merge.** Nothing in this rung's recovered suite failed, but rung 02's did, and
the mechanism is worth carrying: rung 2's `data-variant="primary"` assertion
correctly described rung 2's renderer, passed on its first run, and survived
mutation testing. It became wrong because the code it described was corrected in
a *different* copy. While the copies stayed isolated, nothing could detect it.
That is `lib/ORIGIN.md`'s entire argument for consolidating, and note 32 §1
records the same thing happening to 6b's variant test.

A reader restoring another rung should treat a failure against `lib/` as a
question with two answers that look identical from the test output — *the test
is stale* or *`lib/` regressed* — and should expect to need the archived `src/`
to tell them apart.

**Note 24's reconciliation contract is still wrong in the record.** Its
§"Reconciliation contract" closes with:

> An element is rebuilt only when the component type at that id changes.

That is false of `lib/` and was disproved by rung 6b. Row 20 falsifies it
directly. The note was written before the fix and has not been corrected;
`lib/renderer.ts` carries the corrected rule as a comment at its site. A reader
who takes note 24 as the API's specification will write a renderer with the 6b
bug in it.

What else to distrust in the written record:

- **Note 29's Basecoat table** lists `btn-secondary` / `btn-destructive`
  classes. Rung 7 replaced those with `data-variant` attributes; the classes
  survive only in Basecoat's optional legacy compat stylesheet.
- **Note 20 §6** ("actions are rendered but not dispatched; no handler is
  attached") describes rung 2, not `lib/`. `lib/` still writes `data-action`,
  but it also dispatches.
- **Any material naming `beginRendering` or `surfaceUpdate`** predates the
  v0.8 → v0.9 rename.
- **The archives' `src/` directories** are superseded copies, kept as the record
  of how a finding was reached. `lib/` is what the code is.

## Not covered here

- **No `watchDataModel`.** The spec's `onChanged` / `onAction` modes for
  controlling *when* the client reports changes are absent; this reports on
  every input event. No debouncing either — a real agent integration will
  chatter on every keystroke.
- **Bindings bypass enum validation.** A binding may resolve to a value the
  catalogue forbids. Deliberate — the value is unknown until render — and
  unresolved: either resolve-then-validate at render, or accept the hole
  explicitly.
- **Reconciliation is O(tree) per update.** Every `updateDataModel` re-walks and
  re-validates the whole component tree. Fine for a dialog, wrong for a list. A
  path-to-component dependency map is the obvious fix and is not built.
- **No list rendering.** Bound collections, repeated components and keyed list
  reconciliation are all absent — and full-tree reconciliation would not survive
  them.
- **No `callAgentFunction` / `callRendererFunction`.** Only the simpler action
  event path exists; the typed bidirectional function calls are unimplemented.
- **Action names have no namespace.** Two apps contributing surfaces to the same
  shell could collide; whether action names need peer-scoping like command keys
  is unexamined.
- **Only `TextField` writes back.** No checkbox, select, or any other input, so
  the client-to-server path is proven for exactly one component.
- **No browser verification.** Everything here is happy-dom; IME composition,
  `input`-versus-`change` timing and scroll anchoring are untested, and note 35
  is the standing reminder that a DOM shim is not a browser.
- **No transport, no theming, no dock layout, no second catalogue.**
