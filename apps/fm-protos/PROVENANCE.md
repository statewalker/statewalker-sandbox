# Provenance

What in this app is **recovered code**, what was **ported** to this layout, and what
was changed — restored 2026-09-10 from the Drive session
`notes/drive/2026-09-08.File-Manager/`.

The distinction is load-bearing and is not blurred: recovered code is evidence of
what the September ladder did; a port is a mechanical move; a fix is a change I made
and is listed individually below.

## Sources, and why there were three of them

The session published its material three ways, and all three were needed:

1. **Rung archives** (`02-*.tar.gz`, one per rung) — the acceptance suites. Fourteen
   of fifteen decompress. `02-D1 view adapter and suite.tar.gz` is **corrupt**: it
   yields `index.ts` intact and `view-adapter.ts` truncated into garbage at ~121
   lines. Note 15 predicted exactly this failure mode for binary uploads.
2. **Rung records** (`01-*.md`) — prose plus inline `ts` blocks. For P0–P6 these
   carry whole files; for the C and D rungs they carry only excerpts, because the
   full sources were in the archives beside them.
3. **`WORKING-TREE-2026-09-10/`** — the whole tree at D5, split across ten parts.
   It was **still uploading** when this work began and completed midway through;
   parts 8–10 arrived after the P0–P3 rungs had already been rebuilt from records.

**All library sources here come from the working tree** — they are the real files,
not reconstructions. The suites come from the archives, except the seven whose
archives never existed, which come from the working tree too.

### What this replaced

P0–P3 were first rebuilt from the records' inline blocks, red→green, before the
working tree finished uploading. Those reconstructions were **discarded** in favour
of the recovered files once they arrived — they had been merged forward by hand
(P3's `operation` field, P6's `onCleanup`) and the real files are better evidence.
The rebuild is only visible now as the order of the commits.

## Per rung

| Rung | Sources | Suite |
| --- | --- | --- |
| `P0`–`P6` | working tree | rung archives |
| `C0` | working tree | working tree (`c0-core-decisions`, `boundaries`) |
| `C1`–`C5`, `C05` | working tree | rung archives |
| `D1` | working tree (its archive is corrupt) | working tree |
| `D15` | working tree | rung archive |
| `D2a`, `D3`, `D4`, `D5` | working tree | working tree — no archive was ever made |
| `D2b` | working tree | working tree (6 browser suites + 2 from fm-core) |

Each rung's `README.md` is its record, copied verbatim.

## Ported, not changed

- **Layout.** `packages/<pkg>/src` → `lib/<pkg>/src`; `packages/<pkg>/test` and
  `test/` → `<rung>/tests`. The `@fm/core` / `@fm/app` / `@fm/ui` aliases are
  unchanged, so no import inside a source file was touched.
- **P-era test imports.** The P0–P6 suites predate the package split and imported
  `../src/core/*.js`. Rewritten to the `@fm/*` aliases — the convention the project
  itself adopted at C0.
- **Suites that grep the source tree.** `boundaries.test.ts`, `p5-conflicts`,
  `d15-conflict-dialog` and `d4-open-storage` read the source directory to assert a
  boundary. Their paths now resolve to `lib/`. In `boundaries.test.ts` the check for
  fm-ui's *suites* can no longer be "the files in `packages/fm-ui/test`", because
  suites are filed per rung; it now selects every rung suite that imports `@fm/ui`,
  which states the rule the directory used to imply. It also now covers `.tsx`,
  which the original filter excluded.
- **Vitest 5.** The recovered `package.json` pins `vitest ^5.0.0`; the monorepo
  catalog offers 4.1.11. This app pins 5 to match what the ladder was tested on and
  because `@vitest/browser-playwright` requires it. Node suites pass on both.

## Defects the restoration surfaced

The original tree had **no `typecheck` script**, and its `tsconfig.json` declared
neither `DOM` nor `jsx`, so the `.tsx` files could never have compiled. Adding
`pnpm typecheck` surfaced 28 errors in code that had never been typechecked. All are
fixed; none changed behaviour, and all 313 tests pass before and after.

1. **`PanelModel` was unusable as a value.** `ui-declarations.ts` ended with
   `export type { PanelModel };`, re-exporting the class as a *type*. Since the
   barrel exports `ui-declarations.js` too, `import { PanelModel } from "@fm/app"`
   resolved to the type — so `new PanelModel(...)` was a type error for every
   consumer, including the C1 and D1 suites. It works at run time, which is why no
   test caught it. The vestigial re-export is removed; nothing imported it.
2. **Two different `PanelSpec` interfaces.** `bootstrap.ts` declared the P0
   descriptor `{id, slot, storage, path}` and `panels-model.ts` the C2 spec
   `{storage, path, slot?, name?}`. Both were re-exported by `export *`, making the
   name ambiguous — so `@fm/app` exported **neither**. Neither escapes its own
   module, so the older one is now `BootstrapPanelSpec`.
3. **The checkpoint cursor could not describe a delete.** `"delete"` was added to
   the job operation union in `copy-job.ts` and `job-model.ts`, but
   `checkpoints.ts` still typed the cursor's `spec.operation` as `"copy" | "move"`.
   A delete job's resume record was untypeable. Widened.
4. **`FilesApi` was imported from `@fm/core`, which never exported it.**
   (`open-storage.ts`.) A type-only import, so erased at run time. Now imported from
   `@statewalker/webrun-files`.

### One dependency worth knowing about

The C5 fallback rule reads **`cmd.claimed`**, but `@statewalker/shared-commands`
declares `claimed` only on `CommandInternal`, which it does **not** export — the
public `Command` type has no such field. `file-commands.ts` and `open-storage.ts`
typed their listener parameters structurally to reach it, which is why they matched
no `CommandListener`. Rather than hide that, both now name it:

```ts
type Claimable<P, R> = Command<P, R> & { readonly claimed: boolean };
```

The behaviour is unchanged, but the code now says out loud that it depends on a
field the bus sets and the package does not publish. If shared-commands ever stops
setting it, the C5 override rule breaks silently — that is worth an upstream issue.

### Two test-side typing slips, also fixed

- `c2-panel-set.test.ts` passed an arrow whose expression body returned the new
  `PanelModel` into a callback declared to return `void`. Block body now.
- `p3-job-engine.test.ts`'s `SpyFilesApi` declared `list`'s options as `never`, so
  the recursive walk it performs could not be typed. Typed as `ListOptions`.

## One test that no longer skips

`c05-real-adapter.test.ts` guards a permission-denial case with
`it.skipIf(process.getuid?.() === 0)`. The original run was as root, so it reported
*259 passed, 1 skipped*. Here it runs as an ordinary user, so the case executes —
**260 passed, 0 skipped**. Same suite, one more assertion actually exercised.
