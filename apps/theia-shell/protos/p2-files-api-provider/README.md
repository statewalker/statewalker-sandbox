# P2: `FilesApi` → Theia `FileSystemProvider`

**Question.** Can Theia's `FileSystemProvider` contract be implemented over a
`FilesApi` alone? How do missing files, the create/overwrite flags, errors and
change events map?

**Answer: yes, completely, with whole-file read/write plus folder copy.**

The code lives where the app uses it, in
[`packages/theia-files-api/src/common/files-api-fs-provider.ts`](../../packages/theia-files-api/src/common/files-api-fs-provider.ts).
The unit tests are in
[`packages/theia-files-api/tests`](../../packages/theia-files-api/tests).

| Theia | `FilesApi` | Notes |
|---|---|---|
| `stat` | `stats` | A directory has no size or mtime in `FilesApi`, so both are reported as `0`. The root `/` is always a directory. |
| `readdir` | `list(path)` | Direct children, already in path order. Checks first that the path is a directory. |
| `readFile` | `stats` + `read` | `FilesApi.read` of a missing file yields *nothing* rather than failing, so the provider checks `stats` first. |
| `writeFile` | `write` | `FilesApi.write` creates parent folders. Theia expects `FileNotFound` for a missing parent, so the provider checks first. `create` and `overwrite` are enforced here. |
| `mkdir` | `mkdir` | `FilesApi.mkdir` is `mkdir -p` and succeeds silently if the folder exists. The provider raises `FileExists` and `FileNotFound` (missing parent) as Theia expects. |
| `delete` | `remove` | `remove` is always recursive. A non-recursive delete of a non-empty folder is refused with `NoPermissions`. |
| `rename` / `copy` | `move` / `copy` | `overwrite` removes the target first. |
| capabilities | — | `FileReadWrite`, `FileFolderCopy`, `PathCaseSensitive`. There are no streams and no file descriptors; whole-file reads are enough for an editor. |
| `watch` / `onDidChangeFile` | — | `FilesApi` cannot watch, so the provider reports the changes **it** makes (ADDED, UPDATED, DELETED). A writer that bypasses Theia is only seen on the next read. |

## Findings

- **Theia's `const enum`s do not exist at runtime.** `FileChangeType` and
  `FileSystemProviderCapabilities` are `declare const enum`s, which only `tsc`
  inlines. An esbuild or vitest build that reads `FileChangeType.ADDED` gets
  `undefined`, so the capabilities came out as `NaN`.
  `src/common/const-enums.ts` holds the fixed values, typed as the enums.
  `FileType` and `FileSystemProviderErrorCode` are real enums and are fine.
- **Theia `URI` objects cache derived fields lazily**, so two equal URIs do not
  deep-equal. The tests compare them with `toString()`.
- The provider takes a `FilesApi` or a function that returns one. It is
  resolved on first use, so an app can open OPFS, a remote API or a mesh peer
  asynchronously.

## Red / green

- Red 1: a stub class, 21 of 21 failing (`fs.onDidChangeFile is not a function`).
- Red 2: the implementation using the enums, 21 of 21 failing
  (`Cannot read properties of undefined (reading 'FileReadWrite')`). This led to
  the const-enum finding.
- Red 3: 6 of 21 failing on URI deep-equality. This led to the URI finding.
- Green: `Tests  21 passed (21)`.

```bash
pnpm --filter @theia-shell/theia-files-api test
```
