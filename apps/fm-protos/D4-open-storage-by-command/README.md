# D4-open-storage-by-command — rung record

_Recovered verbatim from the Drive session `2026-09-08.File-Manager/D4-open-storage-by-command/`._

---

<!-- source: 01-D4 rung record and code.md -->

# D4 — Opening a filesystem is a command · rung record

_10 September 2026 · node: 248 passed, 1 skipped (249) · browser: 53 passed (8 files) · mutations killed: 6/6_

## The seam

```ts
export const storagesOpen = Command.required("storages:open")
  .input(z.object({ mode: z.enum(["read", "readwrite"]).default("read"), suggestedName: z.string().optional() }))
  .output(z.object({ cancelled: z.boolean(), uri: z.string().optional(), name: z.string().optional() }))
```

Nothing in the app constructs a `FilesApi`. The environment answers this
command: in a browser, `showDirectoryPicker()` and a permission prompt; in a
test, an in-memory filesystem; in a host embedding us, whatever that host has
mounted already. The app cannot tell the difference — the picker is not a
special case, it is a handler.

**The core registers no fallback.** There is no sensible default filesystem to
invent, so an unwired environment fails with `no-handlers` rather than quietly
opening something nobody asked for. That is asserted.

The app layer contributes `registerStorageOpener(commands, registry, pick)`,
where `pick` is injected — production passes a `showDirectoryPicker` wrapper,
tests pass a function returning `MemFilesApi`. Everything downstream is
identical, so the tests exercise the real path rather than a parallel one.

A dismissed dialog returns `undefined` from the picker and resolves
`{ cancelled: true }`. Dismissal is a normal outcome, not a failure, and
nothing is registered.

## Adopted storages are runtime-only

`registry.adopt(uri, api, { name, caps })` registers a live instance the
environment just handed us. These cannot live in `storages.json`: a
`FileSystemDirectoryHandle` is not serialisable and its permission does not
survive a reload.

So once the last holder releases an adopted storage, it is **gone** —
re-acquiring throws *"no longer held; ask the environment to open it again"*
rather than constructing an empty stand-in under a familiar name. While any
holder remains (a panel, or a job that outlived its panel) it stays live, per
P2/P6.

`mode: "read"` adopts with `write`, `move` and `remove` declared false, so the
UI degrades per storage exactly as C0 intended — a picked read-only folder has
no delete button, and nothing has to check a flag at the point of use.

## Two real bugs found by the first run

**1. The opener ignored the C5 fallback rule.** It was registered without a
priority and without a `cmd.claimed` guard, so when a host claimed
`storages:open` at priority 0, the app's picker **ran alongside it** and adopted
a storage nobody asked for. This is the exact finding from C5 — *negative
priority orders listeners, it does not stop them* — reappearing in the first new
command written after it. Fixed: priority −1 plus the guard.

Worth generalising: **any new listener the app registers for a command a host
may override needs the fallback shape.** It is not a property of `files:*`.

**2. Copying from the root of a storage mangled every name.** `enumerate()`
computed the relative path as `info.path.slice(root.length + 1)`, which assumes
the root has no trailing separator — true of every path except `"/"`, where it
eats the first character: `/a.txt` became `.txt`.

Nobody hit it before because every prior test copied from `/src` or `/dir`. A
picked directory is mounted at its root, so **copying from `/` is the ordinary
case for this feature**, not an edge. A regression test now lives in the C5
suite, asserting `/dst/a.txt` exists and `/dst/.txt` does not.

## Browser half

`packages/fm-core/browser/d4-open-storage.test.ts` runs the same command with a
handler that returns **OPFS** — a genuine browser filesystem — and writes
through the adopted handle. It also covers the dismissal path in its real shape:
`showDirectoryPicker()` rejects with `AbortError` when the user presses Escape,
and the handler reports that as `{ cancelled: true }`.

The picker itself still cannot be driven by Playwright. That remains a recorded
gap — but the gap is now one function wide, and everything on either side of it
is tested.

## Mutations run

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | opener ignores `cmd.claimed` | 1 |
| M2 | opener registered at priority 0 | 1 |
| M3 | a dismissed dialog adopts anyway | 1 |
| M4 | `read` mode still grants write | 1 |
| M5 | released handle silently reconstructed | 1 |
| M6 | root slice back to `length + 1` | 1 |

## A boundary test earned its keep

The suite greps `packages/fm-app/src` for `new *FilesApi(` and for
`showDirectoryPicker`, and asserts neither appears. Both arrive through
`storages:open`, and now nothing can quietly reintroduce a direct construction.

