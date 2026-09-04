<!-- DERIVED-FROM-NOTE: 16-Prototypes 4 and 5 API Reference.md §3 -->
<!-- DERIVED-FROM-NOTE: 15-Prototypes 4 and 5: Manifest Generation and Activation.md §3 -->
<!-- DERIVED-FROM-NOTE: 39-Final Session Index and Status.md §1 -->

# 05 — Activation events: a contribution renders before its module is imported

`pnpm test 05-activation-events`

**Question**: can a contribution render before its module is imported?
**Answer: yes.** Lazy activation, VS Code style — the manifest declares what an
application contributes, the shell renders menus and the command palette from
the manifest alone, and the module is imported only when a command is actually
invoked.

## Goal

Rung 4 showed a manifest can be *derived* without executing the module. This is
the runtime half: the host can *act* on one without executing it either.
Together they make lazy loading real rather than aspirational.

**Why it mattered in the ladder.** This shell is a browser for meshes: the
applications it renders are served by *other peers*. Lazy activation is what
keeps the cost of **listing** an application separate from the cost of
**trusting** it. A shell can show a peer's menus, labels, icons and command
palette while that peer's code has never run in this page — the manifest is
data, and data is cheap to display and safe to ignore. Without it, a menu
listing ten peers' applications means ten foreign modules executing before the
user has clicked anything, and every decision downstream — what to import, what
to sandbox, what to show at all — has already been made by the code you were
deciding about.

**What a "no" would have invalidated.** The manifest-over-in-page-declaration
choice of note 02 §1, which was made *because* it enables activation-events-style
lazy loading; rung 4 itself, since a build-time manifest that the host must
still import past is a cache with no purpose; and the VS Code contribution model
as the reference model, whose whole shape is "declare separately from
implement". A "no" would have pushed the shell back to loading every
application it wanted to mention.

**The rung's original scope was cut.** Note 39 records it: cross-app
contribution by command key — app A contributing a menu entry that points at app
B's command, neither app knowing the other exists — **already passed at rung 1**,
being inherent to string-keyed commands rather than something to build. It is
not rebuilt here. The rung that survives, and the one this folder is, is lazy
activation. (The string-key indirection is visible anyway: `menu()` reads a
command's label from whichever manifest declared it, which need not be the
manifest that contributed the entry. That is a property, not a test.)

## This code is a reconstruction

**The archive `14-prototype-05-activation-events.tar.gz` is corrupt** — it
fails to decompress entirely ("invalid compressed data — format violated") and
no copy survives on any machine. `src/host.ts` and `tests/activation.test.ts`
were **rebuilt from note 16 §3**, which is a signature-level API reference, plus
note 15 §3, which records the behaviours the original suite established. Every
file says so in its header. Nothing here is recovered code, and the original
implementation may have differed in any respect the notes do not pin down.

The original suite had **9 tests**; this one has **15**. Note 15's table lists
six established behaviours and note 16 adds four contract clauses the table does
not cover, so the reconstruction is deliberately wider than the count it
replaces. Wider is safe; narrower would have left the notes' claims unpinned.

## Findings

| # | Claim | How it is established | Fails if |
|---|---|---|---|
| 1 | `register` + `menu` render labels, icons, groups and order **without importing** | Two manifests registered, `menu("editor:title")` rendered, then `imported` — the loader's call log — asserted empty | Any manifest-only method reaches the loader, even fire-and-forget |
| 2 | Menu ordering is manifest-driven, still without importing | `navigation` pins first, remaining groups lexicographic, `order` ascending inside a group, ungrouped last; `imported` still empty | Ordering needs runtime data, or rendering imports |
| 3 | `palette` lists every declared command **without importing** | Palette keys and UX metadata asserted across two apps; `imported` empty | The palette needs a live declaration to show a label |
| 4 | The menu is **stable across activation** | Entries captured before an invoke and after it, compared with `toEqual` | Importing changes what renders — which would mean the pre-import menu was a lie |
| 5 | `invoke` imports **once**, on first call for that app | Three sequential invokes; `imported` has one entry and the app's activation log one entry | The memo is missing, or keyed wrongly |
| 6 | Concurrent invokes **share one import** | Three parallel invokes via `Promise.all`; `imported` has one entry, all three results correct | Activation is not memoised until it settles |
| 7 | A failed load leaves **no half-activated app** | Loader rejects on first call; `isActivated("notes")` is `false` | Activation flags are set before the module is in hand |
| 8 | A failed load is **retryable** | Second invoke calls the loader again and succeeds; `imported` has two entries | The rejected promise is memoised — one transient failure would disable the app forever |
| 9 | A command with no matching activation event is refused **without calling the loader** | `notes:delete` invoked against a manifest activating only on `notes:new`; rejects `not activatable`, `imported` empty. An undeclared key rejects `unknown command`, also without importing | The host imports first and discovers the mismatch afterwards |
| 10 | Nothing is imported until `startup()`, which imports **only** `onStartup` apps | Two apps registered, `imported` empty; after `startup()` it is exactly `["app:mesh"]` and `isActivated("notes")` is `false` | Registration imports eagerly, or `startup` activates everything |
| 11 | The default export receives `{ listen }` and registers on **the host's bus** | A shell-side listener on the same `Commands` instance sees the payload of an app-invoked command | The app registers on a bus of its own, or `listen` is not passed |
| 12 | **Live declaration recovery**: dispatch goes through `mod[export]` | `invoke` round-trips payload to result, and a bad payload is rejected `input-validation` — schemas the JSON manifest does not carry, so they can only have come from the recovered declaration | The host needs a module-level registry, or a lookup by convention |
| 13 | A manifest naming an **export the module lacks** does not poison the app | Sibling command still invokes, `isActivated` true, the ghost command rejects `no live declaration` | A stale manifest entry fails the whole application |
| 14 | **A plain synchronous return does not claim a command** | `notes:delete`'s handler returns `{ deleted: true }` synchronously; the bus rejects with `CommandError.kind === "not-claimed"` | The bus treats any returned value as an answer — the expensive finding of note 39 |
| 15 | The loader receives the **module id verbatim** | A manifest with `module: "peer:QmAbc/notes@2"`; the loader's log holds exactly that string | The host concatenates a base path, breaking route-table and peer ids |

Tests 1, 2, 3, 9 and 10 are the negative half, and are the rung. `imported` is
the whole instrument: the loader is a spy that pushes the requested module id
into an array before doing anything else, so "did this method import the
module?" is `expect(imported).toEqual([])` — asserted as hard as the positive
case, and against the exact ids in the exact order for the positive one.

Both directions were checked by mutation: making `menu()` call the loader fails
tests 1 and 2, and keeping the rejected activation promise memoised fails test 8.

## Techniques and APIs

### The host surface

One factory, six methods (note 16 §3, verbatim):

```ts
function createActivationHost(opts: {
  slots: Slots;       // accepted and unused — note 16 §5 open thread
  commands: Commands; // @statewalker/shared-commands, the dispatch bus
  loader: Loader;     // (modulePath: string) => Promise<Record<string, unknown>>
}): ActivationHost;

interface ActivationHost {
  register(manifest: AppManifest): void;
  menu(location: string): RenderedMenuEntry[];
  palette(): ManifestCommand[];
  invoke(commandKey: string, payload: unknown): Promise<unknown>;
  startup(): Promise<void>;
  isActivated(appId: string): boolean;
}
```

`AppManifest` is prototype 4's generated `Manifest` plus `id` and `activation`,
minus `diagnostics` — the two prototypes compose with no adaptation (note 16 §4).
An `ActivationEvent` is a string: `"onStartup"` or `"onCommand:{key}"`.

### The import/no-import table — the heart of the rung

| Method | Imports the module |
|---|---|
| `register` | no |
| `menu` | **no** — renders entirely from manifest data |
| `palette` | **no** |
| `isActivated` | no |
| `invoke` | yes, on first call for that app |
| `startup` | yes, for apps declaring `onStartup` |

The two bold "no" entries are the prototype's result. Everything else in this
folder exists to make those two rows checkable. There is exactly one `loader(…)`
call site in `src/host.ts`, inside `activate()`; the four non-importing methods
are reachable without touching it, and two of them are synchronous.

### The activation contract

- Activation is **memoised per application**, so concurrent `invoke` calls share
  one import.
- **The memo is cleared on rejection.** A failed load leaves `isActivated ===
  false` and the live-declaration map empty, and the next `invoke` retries.
  Memoising a rejected promise would permanently disable an application after
  one transient failure.
- `invoke` on a command with no matching `onCommand:` event (and no `onStartup`)
  is refused **without calling the loader** — the check is against manifest data,
  which is the only thing the host has and all it needs.
- After import, the module's default export, **if callable**, is invoked with
  `{ listen }` so the application can register its handlers.

### The loader contract

The loader receives a **module id, not a path to concatenate**. Callers resolve
it against an explicit map or route table: Vite cannot statically analyse a
computed dynamic import specifier, and a real loader would be resolving against
a route table anyway. In these tests the ids are `"app:notes"` and
`"peer:QmAbc/notes@2"` — deliberately not path-shaped, so a host that tried to
build a URL from one would be caught.

### Live declaration recovery — `mod[c.export]`

The host needs a live `CommandDeclaration` to dispatch, but a manifest is plain
JSON: it carries a key and a policy name, no schemas and no functions. The
manifest's `export` field carries the **symbol name**, so after import the
declaration is `mod[c.export]`, stored per registration.

This replaced an earlier module-level registry — a global — which was wrong
because it leaked state across hosts and could not be cleared on failure. **It
is the concrete reason prototype 4 emits `export` at all.** What comes back is
checked structurally before use (`key` a string, `inputSchema` an object),
because a module is foreign code.

### Dispatch, via `@statewalker/shared-commands`

The host owns no dispatch logic; it owns the *timing* of dispatch. Declarations
are built by the shipped builder and dispatched on the shipped bus:

```ts
const NewNoteCommand = Command.required("notes:new")   // policy: reject on
  .input(z.object({ title: z.string() }))              //   no-handlers AND
  .output(z.object({ id: z.string() }))                //   observers-only
  .build();                                            // frozen declaration

commands.call(decl, payload).promise;   // what invoke() returns
commands.listen(decl, fn);              // what the app gets as `listen`
```

Three things the rung leans on and does not implement: the **policies**
(`required` / `async` / `silent` / `custom`, the first two rejecting when no
listener claims); the **claim rules** — a listener claims by returning `true`, a
promise, or by calling `cmd.resolve`, and by nothing else; and `CommandError`,
whose `kind` discriminates `input-validation`, `no-handlers`, `not-claimed`,
`listener-threw` and `output-validation`. Payload validation in test 12 is the
bus's, not the host's, which is exactly why it proves the recovered declaration
is the real one.

### The testing technique — a spy loader, and mutation in both directions

The transferable part. Note 15 puts it plainly: "the central assertion is
negative", and a negative assertion is only as good as its instrument.

```ts
const imported: string[] = [];
const loader: Loader = async (moduleId) => {
  imported.push(moduleId);       // FIRST, before anything can fail or filter
  …
};
```

Recording the id *before doing anything else* is the point: an import that
throws, an import of an unknown id, an import nobody awaits — all of them still
land in `imported`. That makes `expect(imported).toEqual([])` a real
measurement rather than an absence of evidence, and it makes the positive
assertion sharper too, since it names the exact ids in the exact order
(`["app:notes", "app:notes"]` is how the retry is established).

Modules are plain objects (note 15 §6: fake modules only), so the loader is a
map lookup and no bundler, filesystem or network is involved.

Green tests were not taken as proof that the instrument works. Two mutations
were applied to `src/host.ts` and the suite re-run:

| Mutation | Expected to fail | Result |
|---|---|---|
| `menu()` calls `activate()` fire-and-forget | tests 1 and 2 | both failed |
| the rejected activation promise is kept memoised | test 8 (retry) | failed |

Then reverted, and the suite re-run green. A negative assertion that has never
been made to fail is a comment.

## What note 16 §3 specified, and what was decided here

Specified, and followed exactly: every type and signature (`AppManifest`,
`ActivationEvent`, `Loader`, `ActivationHost`, `RenderedMenuEntry`,
`createActivationHost`); the import/no-import table; memoisation per app and its
clearing on rejection; `not activatable` without a loader call; the default
export invoked with `{ listen }`; `mod[c.export]` as the live declaration; the
loader taking a module id rather than a path. `slots` is accepted and unused —
note 16 §5 records that as an open thread, so the parameter is kept and ignored
rather than quietly dropped.

Decided here, because the note is silent. Each is marked `DECIDED HERE` at its
site in `src/host.ts`:

| Decision | Why |
|---|---|
| `invoke` **rejects** rather than throwing synchronously | Its declared type is `Promise<unknown>`; a caller should not have to guard both paths |
| An `export` the module lacks is **not** an activation failure — the command rejects at invoke time | Note 16 §5 records that nothing verifies a manifest still matches its source, so a stale entry should be survivable |
| A `default` export's return value is **awaited** | An app that registers asynchronously must be registered before the invoke that activated it dispatches |
| Menu sort order | Note 16 exposes `group` and `order` but states no rule; prototype 1's `resolveMenu` (note 11 §3) is reused verbatim, with ungrouped entries last |
| A colliding app `id` in `register` **throws** | Matches prototype 1's keyed-slot collision semantics |
| First manifest to declare a command key **owns** it | Two apps declaring the same key is undesigned |
| An undeclared command key rejects `unknown command` | Note 16 covers only "declared but not activatable" |
| `startup()` rejects if an eager app fails | Isolating startup failures is not described |
| `ActivationContext` is `{ listen: Commands["listen"] }` | Note 16 names the field and not its type; it is bound from the `Commands` passed in, the only `listen` in scope |

## Lessons learned

**This rung inherits "a plain synchronous return does not claim a command"; it
does not establish it.** The property is enforced by the shipped
`@statewalker/shared-commands` bus — a listener returning anything other than
`true`, a promise, or a direct `cmd.resolve` is recorded as observe-only, and
under `required` policy the command rejects `not-claimed`. The host contributes
nothing to it. Test 14 pins the behaviour at the host's boundary, which is worth
having, but **anyone citing rung 5 as the evidence for that finding is citing
the wrong rung**: the evidence is prototype 1's listener contract (note 11 §5)
and the bus's own tests. The finding is expensive and easy to rediscover
painfully — a handler that returns a perfectly good answer object and hangs
forever under `async` policy — which is why it is worth being precise about
where it actually lives.

**Part of the negative assertion is structural, and that is not a weakness — but
know which part.** `menu()` and `palette()` are synchronous, so they *cannot*
await an import; no amount of testing changes that, and a test that only proved
"a sync function did not await" would be theatre. What the spy actually catches
is the failure mode that a type signature does not: a **fire-and-forget** import
kicked off during rendering — prefetching, warming a cache, "activating early
since we're here" — which leaves the signature untouched and quietly destroys
the property. That is exactly what the first mutation simulated, and it is the
one worth guarding, because it is the change a well-meaning future edit makes.

**Note 16 §3 was a genuine specification, and test-count parity still is not
recoverable.** Rebuilding an implementation from a signature-level API reference
worked better than expected: types, contracts and error behaviours all
transcribed cleanly, and the one real gap — menu ordering — was filled from
another note in the same session (note 11 §3). But the record says the original
had *nine* tests and never says **which** nine, so the suite cannot be restored,
only re-derived: note 15's table gives six behaviours, note 16 adds four more
contract clauses, and honouring all ten takes fifteen tests. The lesson for the
notes themselves is that a table of *what was established* survives archive
corruption far better than a count of *how many assertions established it* —
and that a corrupt archive costs the test *choices*, not the API.

## Not covered here

- **Fake modules only.** Note 15 §6 scopes it: no real application, no DOM, no
  rendering. A module here is a plain object and the loader is a map lookup.
- **`when` is carried and not evaluated.** `ManifestMenuItem.when` survives into
  the host, but `RenderedMenuEntry` has no `when` field and
  `createActivationHost` takes no `Enablement`, so a `when`-guarded entry always
  renders. Enablement is prototype 1's (note 11 §4) and rung 08's.
- **No deactivation or unloading**, and no activation events beyond `onStartup`
  and `onCommand:` — both note 16 §5 open threads.
- **No `inputJsonSchema` in the manifest**, so the manifest cannot drive tool
  projection. Note 15 §7 calls this the most consequential open question of the
  pair; rung Z is where it is answered.
- **`Slots` is unused**, so manifest-declared and runtime-contributed menu items
  are never reconciled. Rendering reads manifests directly.
