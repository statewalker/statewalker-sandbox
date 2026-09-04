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

Rung 4 showed a manifest can be *derived* without executing the module. This is
the runtime half: the host can *act* on one without executing it either.
Together they make lazy loading real rather than aspirational.

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

**Rung 5 as originally scoped was dropped.** Note 39 records it: cross-app
contribution by command key already passed at rung 1, being inherent to
string-keyed commands rather than something to build. It is not rebuilt here.
The rung that survives — and the one this folder is — is lazy activation.
(The string-key indirection is visible anyway: `menu()` reads a command's label
from whichever manifest declared it, which need not be the manifest that
contributed the entry. That is a property, not a test.)

## Verified

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
