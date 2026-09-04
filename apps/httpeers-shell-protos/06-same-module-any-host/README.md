# 06 — Same module, any host

`pnpm test 06-same-module-any-host`

## Goal

**Question.** Does the same application module mount unchanged, standalone and
hosted?

**Why it mattered.** Prototype 1 asserted this design — an application is a
default module receiving a context, usable in either host — but could not test
it: it was headless, and `View.mount(root, ctx)` typed `root` as `unknown`. The
assertion sat unverified underneath every rung above it. It is also the claim
that makes a shell for meshes a *browser*: an application served by a foreign
peer has to appear full-window in a bare page and as one pane among many in the
dock, and the peer must not know or care which.

**What a "no" would have cost.** A module would have to branch on its host, so
every application published to the mesh would carry host-conditional code — and
would have to be *tested* in both hosts by its author, not by the shell. The
shell could no longer tell a peer "publish one module"; it would have to
document a standalone build and a hosted build, and every rung above this one
(the dock, layout persistence, peer-served surfaces) would be built twice.
Divergence here does not stay here: it propagates into the publishing contract.

**Reject condition** (note 23): the two paths diverge, or the module has to know
which host it is in.

### The rule that makes it true rather than aspirational

`AppHost` exposes no surface id, no pane id, and no reference to the dock or the
renderer, so **a module cannot discover its host and therefore cannot branch on
it**. The surface id is an implementation detail the host chooses — the module's
own id when standalone, the pane id when docked — and it is never visible from
inside. The second half is that there is **one host builder**: `createAppHost`.
Identical shape holds by construction, not by two code paths that happen to
agree today.

## Findings

**Answer: yes — the two paths do not diverge.** This rung closes prototype 1's
open assertion, against `lib/mount.js` — the consolidated `shell-core` — with
the docked half running on real Dockview through `lib/dock.js`.

### Verified

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | The two mounts really are two | Different `data-surface` id, different `Renderer` instance, disjoint DOM roots, and the docked surface nested inside Dockview-built DOM | Both paths collapse to one mount, making every claim below vacuous |
| 2 | The host is the **same shape** in both | `Object.keys(host).sort()` equals `["getData","notify","render","setData"]` for both | A member is added to one path — note 33's mutation 1, "leak `surfaceId` into the docked host only" |
| 3 | The host exposes **nothing a module could branch on** | `surfaceId`, `paneId`, `id`, `dock`, `dockview`, `renderer`, `container`, `element`, `host`, `standalone`, `docked` are all absent under `in`; every value is a function, so no data field can smuggle an id | Any of those becomes reachable |
| 4 | `activate` receives **one argument** | Argument count recorded inside the module, asserted `[1, 1]` | A second parameter appears — the obvious place to put "which host am I" |
| 5 | There is **one builder**, so the shapes cannot drift | A host built directly by `createAppHost` over a throwaway renderer is key-identical to the one `mountStandalone` produced | `mountStandalone` builds its own host inline — note 33's mutation 2, the drift that happens naturally over time |
| 6 | The same module renders **byte-identical markup** in both | `innerHTML` of the `[data-surface]` element compared across paths, with a length/content guard so it cannot pass by both being empty | Anything host-derived leaks into the component tree |
| 7 | The surface id never reaches the module's markup | Neither `pane-alpha` nor `confirm-dialog` appears in its own surface body | The host writes its chosen id into the tree the module authored |
| 8 | `setData` / `getData` round-trip identically | Same initial model in both; `setData("/form/name","Ada")` then `getData()`, and the bound `input.value` reflects it | The two paths hold data differently, or the binding stops updating |
| 9 | `notify` reaches whatever embeds the module, in both | `onNotify` collected per path | Notification works in one host only |
| 10 | The action **affordance** is identical in both | `data-action="confirm"` on the button in both trees; the standalone event carries `name`, `context`, and the host-chosen `surfaceId` | The declared action renders differently depending on host |
| 11 | **DEFECT**: a docked module's actions never fire | Standalone click yields one `ActionEvent`; docked click yields none; a hand-wired renderer proves the same module and the same `createAppHost` produce an equal event once the callback is on the renderer | The wiring is fixed — this test is written to go **red** then. See below. |
| 12 | Two panes running the **same module** keep separate data models | Two panes, one module definition; typing into pane A's input leaves pane B's model at its initial value | One renderer is shared across panes, or the data model is keyed by module id |
| 13 | Standalone `dispose()` runs the disposer and deletes the surface | `trace.disposals`, `renderer.surfaces()`, and the `[data-surface]` element | Either half is skipped |
| 14 | **Known gap**: closing a dock pane does *not* run the disposer | `dockview.removePanel` removes the pane; `trace.disposals` stays empty | Dockview's disposal events get wired — again, deliberately red then |

14 tests, all passing. Typecheck clean — verified by pointing `tsc` at the test
file directly, because the app's `tsconfig.json` `include` glob does not match
rung folders and so `pnpm typecheck` never reaches them.

### What this rung found

**`createAppHost` accepts `onAction` and silently ignores it.**
`AppHostOptions` declares `onAction?`, and `createAppHost` takes an
`AppHostOptions` — but it only ever reads `onNotify`. Actions are wired at
*renderer construction*, `createRenderer(root, catalog, { onAction })`, which
`mountStandalone` does and nothing else can: `lib/dock.ts` builds each pane's
renderer itself, with no options and no hook to supply any.

So a module mounted into a pane renders correctly, holds data correctly, and its
buttons are dead. Test 11 pins it and isolates the cause: the identical module
through the identical `createAppHost` produces an event equal in every observable
field as soon as the renderer is the one carrying the callback.

**This is a wiring gap, not a hole in the abstraction** — the "same module, any
host" claim survives it — but it is the same trap as the documented "`theme` is
accepted and ignored" hole, and undocumented. `lib/` is read-only for this rung,
so it is reported, not fixed. Either `onAction` belongs on `createRenderer` alone
and should leave `AppHostOptions`, or `createShellDock` needs to accept renderer
options and forward them in `createComponent`.

### One divergence from the note

Note 33 describes the docked path as `dock.mountApp`, calling the shared
`createAppHost`. Consolidated `lib/dock.ts` (rungs 7 and 7a) has **no
`mountApp`**: a pane owns its renderer, and the `AppHost` is composed on top by
whoever mounts the module. The property under test is unaffected —
`createAppHost` is still the one and only host builder — but the docked path is
assembled in the test rather than imported, and that is stated in the test file
too, because the whole point of this rung is that the two paths are not quietly
two. The missing `mountApp` is also *why* the `onAction` gap exists.

## Techniques and APIs

### The API under test

```ts
// lib/mount.ts
interface AppHost {
  render(components: Component[]): void;      // replace the module's tree
  setData(path: string, value: unknown): void; // write the module's data model
  getData(): Record<string, unknown>;          // read it back
  notify(message: string): void;               // tell whatever is hosting me
}

interface AppModule {
  readonly id: string;
  activate(host: AppHost): void | (() => void); // may return a disposer
}

interface AppHostOptions {
  onAction?(event: ActionEvent): void;   // SEE BELOW — declared, not honoured here
  onNotify?(message: string): void;
}

interface MountHandle {
  readonly renderer: Renderer;
  dispose(): void;
}

function createAppHost(
  renderer: Renderer,
  surfaceId: string,
  catalog: Catalog,
  options?: AppHostOptions,
): AppHost;

function mountStandalone(
  container: HTMLElement,
  module: AppModule,
  catalog: Catalog,
  options?: AppHostOptions,
): MountHandle;
```

Three things about these signatures carry the rung's whole argument.

**`surfaceId` is a parameter of `createAppHost` and appears nowhere on the
returned `AppHost`.** The host builder is *told* which surface it is over; the
module it serves is never told. That asymmetry is the design, expressed in a
parameter list. `mountStandalone` passes `module.id`; a docked mount passes the
pane id. Neither is discoverable from inside.

**`createAppHost` sends `createSurface` itself**, before returning. Building a
host and creating its A2UI surface are one operation, which is why there is no
window in which a module could hold a host over a surface that does not exist.

**`AppHostOptions.onAction` is declared and ignored by `createAppHost`.** This
is not a footnote about a bug; it is the API's actual shape and belongs in its
description. `createAppHost` reads only `onNotify`. Action dispatch is wired
one layer down, at renderer construction:

```ts
createRenderer(root, catalog, { onAction })   // the ONLY place onAction is honoured
```

`mountStandalone` calls that, which is why standalone actions work. Any other
mount path — including every docked one, because `lib/dock.ts` builds each
pane's renderer itself with no options and no hook — passes `onAction` into
`createAppHost` and gets silence. Read the type and you will believe the option
works; read `createAppHost`'s body and you find it never touches the field.

### Making the two host paths genuinely different

An identical-outcome assertion over two identical mounts proves nothing, so the
first test is a non-vacuity guard and it runs first for that reason. The docked
path is made to differ from the standalone path in four ways at once:

| | Standalone (path A) | Docked (path B) |
|---|---|---|
| DOM root | created by the caller | created and owned by Dockview |
| Renderer | built by `mountStandalone` | built by `dock.ts`'s `createComponent` |
| Surface id | `confirm-dialog` (the module's id) | `pane-alpha` (the pane's id) |
| Neighbours | the only surface in the document | a pane, with siblings possible |

Test 1 asserts each of those separately — different `data-surface` value,
different `Renderer` instance, disjoint DOM subtrees, and the docked surface
nested *inside* Dockview-built DOM rather than directly under the host element.
Only then do tests 2–14 get to claim that outcomes are identical.

The same discipline applies to test 6: byte-identical markup would also be
"identical" if both trees were empty, so it carries a length floor and a
positive content check alongside the equality.

### Dockview under happy-dom

```ts
const dock = createShellDock(hostEl);
dock.dockview.layout(1200, 800);          // <- the container-measurement stub
dock.addPane({ id, title, origin, position? });
const renderer = dock.renderers.get(id)!; // one renderer per pane
dock.dockview.panels;                     // pane handles
dock.dockview.removePanel(panel);
```

happy-dom reports every element as 0×0, so Dockview lays out nothing and creates
no pane content unless it is given a measurement. One explicit
`dockview.layout(1200, 800)` is the whole stub — note 33 records the same
technique. `dock.renderers` is the seam this rung mounts onto: `createShellDock`
exposes the per-pane `Renderer`, and the `AppHost` is composed on top of it.

### Observing what the module receives

The module is written once and given a plain `Trace` object to push into:
the `AppHost` it was handed, `arguments.length` at each activation, and any
disposer calls. That turns three otherwise-unobservable claims into assertions
— the host's key set, that `activate` takes exactly one parameter, and that
`dispose()` really reaches the module — without the module knowing it is under
test. `activate(...args)` rather than `activate(host)` is deliberate: a second
parameter is the obvious place someone would later put "which host am I", and
counting arguments is how that gets caught.

Two mutation checks from note 33 §4 are re-expressed as ordinary assertions:
leaking `surfaceId` into one host is caught by key-set equality (test 2), and
duplicating the host builder inline is caught by comparing `mountStandalone`'s
host against one built directly by `createAppHost` over a throwaway renderer
(test 5).

## Lessons learned

**A "no divergence" claim is worth exactly as much as its non-vacuity guard.**
Two mounts that quietly share a renderer, a root or a surface id will agree
about everything, and the suite will be green and meaningless. The guard has to
assert the *differences* explicitly, and it should run first.

**Consolidation can delete a behaviour, not just a duplicate.** Note 33's docked
path was `dock.mountApp`, which called the shared `createAppHost`. It did not
survive into `shell-core`, and the action wiring went with it. This is the same
lesson `lib/ORIGIN.md` records from the 6b merge, in its other form: an
assertion true of an isolated copy fails the moment the copies meet, and a
behaviour present in only one copy vanishes the moment they merge. Both are
invisible until something tests across the seam — here, one suite exercising
both mount paths with one module.

**"Accepted and ignored" is a defect category, not an oversight.** `theme` on
`createSurface` is documented as accepted-and-ignored; `onAction` on
`AppHostOptions` is the same thing undocumented, and undocumented is worse: the
type system actively asserts the option exists. A field that is declared and
never read should either be removed from the type or be honoured.

**Test the gaps you decide not to close.** Tests 11 and 14 assert *current*
behaviour that is wrong (dead docked actions) or incomplete (no disposer on pane
close). They are written to go red when someone fixes them, with a comment
saying so. That is cheaper than a TODO nobody greps for, and it makes closing
the gap a deliberate act.

**happy-dom hides everything spatial.** Every element is 0×0 and nothing paints.
It is enough to prove that structure, identity and data flow do not diverge; it
proves nothing about whether either host *looks* right — which is exactly the
blind spot that hid both of rung 7's corrections to the 6b mapping for a whole
rung.

## Not covered here

- **No browser.** happy-dom, with Dockview's container measurement stubbed by an
  explicit `dockview.layout(1200, 800)` — happy-dom reports every element as 0×0.
  Nothing visual is verified.
- **No module loading.** Modules are passed in as objects. Prototype 5's
  activation host does the lazy-import half; the two are still not joined.
- **No contribution registration.** A module can render and hold data but cannot
  contribute menu items or commands. Prototype 1's `commands` / `slots` /
  `enablement` context and this rung's `AppHost` remain separate vocabularies,
  and how they compose is undesigned — note 33 calls this the most significant
  remaining gap in the shell.
- **No isolation boundary.** Same DOM, no iframe, as decided in note 02.
- Module ids and pane ids are independent, and nothing prevents two panes from
  mounting modules with colliding internal component ids. Surfaces are separate,
  so it is currently harmless and unexamined.
