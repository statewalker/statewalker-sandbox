# 03 — Data binding and action dispatch round-trip

`pnpm test 03-a2ui-binding`

**Question**: do data binding and action dispatch round-trip — can a surface be
made interactive without re-sending the component tree, and do user actions
travel back out?

**Answer: yes, on both counts.** But the interesting result is not the answer;
it is what repairing rung 2's full-repaint defect turned up. Keyed
reconciliation preserved element identity and focus was *still* destroyed,
because `replaceChildren` detaches and reattaches every child even when handed
the identical instances. Identity is necessary and not sufficient.

Three additions to rung 2's renderer:

| Feature | Mechanism |
|---|---|
| Data binding | `{"path": "/user/name"}` in place of a literal, resolved at render time |
| Server → client | `updateDataModel` writes a path, then repaints |
| Client → server | `TextField` input writes back and notifies the host |
| Action dispatch | click reads the action name and calls `onAction` with a data-model snapshot |

Two suites. `binding.test.ts` is **recovered** from
`21-prototype-03-a2ui-binding.tar.gz` (17 tests) with only its imports
rewritten to `../../lib/`; every assertion passed against the consolidated
renderer unchanged. `reconciliation.test.ts` is **reconstructed** — four
assertions written from the notes for claims the archive states in prose and
never checks. Each carries a `DERIVED-FROM-NOTE` marker.

## Verified — data binding (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | A bound value renders from the data model | `text: {path:"/user/name"}` with `/user` set to `{name:"Ada"}` renders `Ada` | Bindings are treated as literal objects |
| 2 | A bound component updates with **no `updateComponents`** | Two `updateDataModel` messages move the text `1` → `2` | The tree has to be re-sent to change a value |
| 3 | An unresolved path renders empty, not an error | `/nothing/here` yields `""` | A partial data model throws and wedges the surface |
| 4 | A nested write does not clobber siblings | Writing `/f/a` leaves `/f/b` intact | Path writes replace the parent object |
| 5 | Data models are **per surface** | Two surfaces both hold `/v` with different values | One model leaks between surfaces |

## Verified — focus (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 6 | An unrelated bound change does not steal focus | Type into a `TextField`, update `/status`; the same `input` instance is still `document.activeElement` with `selectionStart === 3` | Rule 1 below is dropped |
| 7 | The field being edited is never overwritten | `input.value` stays `"typing"` across a server update to another path | Rule 2 below is dropped |

## Verified — action dispatch (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 8 | A click emits the action name and surface id | `onAction` called with `{surfaceId:"dialog", name:"confirm"}` | Actions render but never dispatch |
| 9 | The declared `context` travels with it | `context: {id:"note-7"}` arrives on the event | Context is dropped, and a list button cannot say which row it is |
| 10 | A **snapshot of the data model** travels with every action | `dataModel` contains `{name:"Ada"}` | A submit button needs a separate collection step |
| 11 | A button with no action does nothing | `onAction` not called. Silence, not an error | An actionless button throws, and a peer can crash the shell with an omission |
| 12 | A **throwing handler cannot wedge the surface** | The click does not throw, and the surface still accepts `updateDataModel` afterwards | A foreign peer's surface can break the shell by triggering a handler that fails |

## Verified — client-to-server flow (recovered)

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 13 | User input writes back into the data model | An `input` event puts `Grace` at `/name` | The model is server-authoritative only |
| 14 | The host is notified of **user-originated** changes | `onDataModelChange` fires with path and value | The host cannot observe local edits |
| 15 | A **server** update stays silent | `onDataModelChange` is not called for `updateDataModel` | The two sides echo: server updates model → client reports change → server updates model |

## Verified — rung 2 guarantees, re-asserted (recovered)

Binding opened a fresh path for hostile data, so two rung-2 properties are
re-checked under it.

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 16 | A **bound** value containing markup renders as text | `/evil` = `<img src=x onerror=alert(1)>`; no `img` element exists | The binding path uses `innerHTML` where the literal path did not |
| 17 | Components outside the catalogue are still rejected | `Script` throws `not in catalogue` | Binding introduced a way around validation |

## Verified — the reconciliation contract (reconstructed)

| # | Claim | How it is established | Fails if | Source |
|---|---|---|---|---|
| 18 | `replaceChildren` blurs even with **identical instances** | Focus an `input`, call `host.replaceChildren(input)`; identity holds, `isConnected` is true, `activeElement` is no longer the input | The platform stops doing this — in which case rule 1 is dead weight and nothing else would say so | note 22 §3 |
| 19 | The renderer does not call `replaceChildren` when the child list is unchanged | The container's `replaceChildren` is wrapped and counted; an `updateDataModel` that changes a sibling's text records **zero** calls while the text still updates | Rule 1 is implemented as "diff the elements" rather than "diff the list" | note 24 §Reconciliation contract, rule 1 |
| 20 | The render key includes any property that affects **element identity** | Same id, same `component`, `variant` `body` → `h1`: the tag becomes `H1`, the element is a *different* instance, and no stale `p` remains | The cache is keyed on component type alone and a variant change leaves a stale tag | note 29 §"A bug found in the rung 3 renderer" |
| 21 | …and is not so coarse that everything rebuilds | Changing only `text` at a fixed `variant` returns the **same** element instance | Rules 1 and 2 stop protecting anything, because every update replaces the element |

## The contracts a caller must know

Reproduced from note 24 §3, because these are the parts a caller gets wrong:

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

### The two rules that keep focus alive

1. **Only call `replaceChildren` when the child list actually differs.**
   `replaceChildren` detaches and reattaches every child even when passed
   identical instances, and reattaching blurs. Rows 18 and 19.
2. **Never write `input.value` when that input is `document.activeElement`.**
   Row 7.

Note 24's version of this contract closes with "An element is rebuilt only
when the component type at that id changes." **That sentence is out of date**
and row 20 falsifies it: rung 6b found that `Text`'s `variant` selects the tag,
so the render key must include any property affecting element identity, not
just the component name. The note was written before the fix; `lib/renderer.ts`
carries the corrected rule at its site.

## Not covered here

- **No `watchDataModel`.** The spec's `onChanged` / `onAction` modes for
  controlling *when* the client reports changes are absent; this reports on
  every input event. No debouncing either.
- **Bindings bypass enum validation.** A binding may resolve to a value the
  catalogue forbids. Deliberate — the value is unknown until render — and
  unresolved: either resolve-then-validate at render, or accept the hole
  explicitly.
- **Reconciliation is O(tree) per update.** Every `updateDataModel` re-walks
  and re-validates the whole component tree. Fine for a dialog, wrong for a
  list. A path-to-component dependency map is the obvious fix and is not built.
- **No list rendering.** Bound collections, repeated components and keyed list
  reconciliation are all absent.
- **No `callAgentFunction` / `callRendererFunction`.** Only the simpler action
  event path exists.
- **Action names have no namespace.** Two apps contributing surfaces to the
  same shell could collide; whether action names need peer-scoping like command
  keys is unexamined.
- **No transport, no theming, no dock layout, no second catalogue.**
