# Pluggable FilesApi: mount points — design

Status: agreed in conversation 2026-09-25; awaiting review of this written form.

## Goal

The app's file system becomes a **composite**: every top-level folder is a
**mount point** backed by its own `FilesApi`. The root the app sees is a
**pipeline** — the composite wrapped in pluggable layers, the first being a
filter that hides paths (system folders, VCS folders, junk) — so it is both
composable and filterable. Users mount new file systems
from the UI, each with its own configuration, a display **name** ("Local
Computer") and a unique **key** (the folder name, derived from the name by
default and editable). Mounts are stored with the other settings and come back,
mounted and visible, after a reload.

Types in the first cut: **in-memory**, **OPFS**, **local folder** (File System
Access API) and **S3**. More types ("…") are added by binding one contribution.

## Non-goals

- No storage code. Every backend already exists in `@statewalker/webrun-files-*`
  0.10.0; this work only adapts a JSON config to their constructors.
- No HTTP or SQLite type yet (`webrun-files-http`'s `newClientStub`,
  `webrun-files-sqlite`). Each is one more adapter of the same shape, later.
- No secret store. S3 keys are stored in `settings.json` in plain text (see
  *Risks*).
- No migration of files a previous build left at the OPFS root (sandbox
  prototype; they stay in OPFS, unseen).
- No runtime loading of new types; types are Theia DI contributions.

## Existing pieces used

| Need | Package (0.10.0) | Call |
|---|---|---|
| Mount table | `webrun-files-composite` | `new CompositeFilesApi(readOnly(new MemFilesApi())).mount("/<key>", api)`; lists each mount as a folder, and nothing can be written beside them. It has no `unmount` yet, so it is rebuilt on change (see *Follow-up in webrun-files*). |
| Filter layer | `webrun-files-composite` | `new FilteredFilesApi(api, newGlobPathFilter(...globs))`; hidden paths behave as absent, writes to them throw |
| Memory | `webrun-files-mem` | `new MemFilesApi()` |
| OPFS | `webrun-files-browser` | `new BrowserFilesApi({ rootHandle })`, the handle being `mounts/<dir>` under `navigator.storage.getDirectory()` |
| Local folder | `webrun-files-browser` | `openBrowserFilesApi({ handlerKey, readwrite, get, set, del })`; `isHandlerAccessible`, `verifyPermission` |
| S3 | `webrun-files-s3` (+ peer `@aws-sdk/client-s3`) | `new S3FilesApi({ client: new S3Client({ endpoint, region, credentials, forcePathStyle: true }), bucket, prefix })` |

## Architecture

### `packages/theia-files-mounts` (new Theia extension)

- **`MountType`** — the contribution point (multi-bound):

  ```ts
  interface MountType {
    readonly id: string;              // "memory", "opfs", "local-folder", "s3"
    readonly label: string;           // "In Memory", "Browser Storage (OPFS)", …
    readonly fields: MountField[];    // what the wizard asks, in order
    isAvailable(): boolean;           // e.g. OPFS / showDirectoryPicker present
    create(mount: MountConfig, ctx: MountContext): Promise<FilesApi>;
  }
  interface MountField {
    name: string; label: string;
    kind: "text" | "secret" | "url" | "directory";
    required?: boolean; default?: string;
  }
  interface MountConfig {             // one entry of the `files.mounts` preference
    key: string; name: string; type: string;
    config: Record<string, string>;
  }
  ```

  `ctx.interactive` is true when `create` runs from a user gesture (wizard,
  *Reconnect*), false at boot; a type that needs a gesture (local folder) throws
  `NeedsUserGesture` when it is false.

- **Built-in types** in this package: memory, OPFS (field `directory`, default:
  the key), local folder (field `directory` = pick a folder; the handle is kept
  in IndexedDB under `mount:<key>`, not in JSON).

- **`files.mounts` preference** (user scope → `settings.json` in the system
  store, see *System store*): an array of `MountConfig`, with a JSON schema so a
  hand edit is checked. Unset means the app's defaults (below).

- **`FilesApiLayer`** — the second contribution point (multi-bound): a wrapper
  applied around the composite to form the root the app sees.

  ```ts
  interface FilesApiLayer {
    readonly id: string;
    readonly priority: number;          // lower wraps first (closer to the composite)
    wrap(root: FilesApi): FilesApi;     // FilteredFilesApi, GuardedFilesApi, readOnly…
    readonly onDidChange?: Event<void>; // e.g. its preference changed
  }
  ```

  Built-in layer: **hidden paths**, from the `files.hidden` preference (glob
  list, default `[]`; the app sets its own default) through `FilteredFilesApi`
  + `newGlobPathFilter`. A hidden path is absent for every consumer of the root:
  explorer, editors, search, and `window.theiaShell.filesApi`.

- **`MountService`**:
  - owns a stable **`MountedFilesApi`**: a `FilesApi` that delegates to the
    current pipeline — `layers(composite)` — so callers never see a rebuild;
    a mount change or a layer's `onDidChange` rebuilds the pipeline;
  - on start and on every `files.mounts` change: validates entries, diffs by
    key against what is mounted, calls `create` only for new or changed
    entries (in parallel), rebuilds the composite, then reports what changed:
    added at `/<key>`, deleted at a removed `/<key>`, updated at `/`. An entry
    whose type and config equal a mounted one's is a rename: its `FilesApi`
    instance is reused, not re-created;
  - keeps a status per key: `mounted`, `needs-access`, `failed(message)`.

- **Commands and menus**:
  - *Files: Mount File System…* (command palette, explorer title): quick input
    steps type → name → key (prefilled with the slug, validated live) → the
    type's fields. It writes `files.mounts`.
  - On a root folder (explorer context menu): *Edit Mount…* (same steps,
    prefilled; the type is fixed), *Unmount* (confirm, then remove the entry),
    *Reconnect* (shown for `needs-access` and `failed`).
- **Labels**: a `LabelProviderContribution` shows a root folder by its mount
  name, with a status suffix: "Cloud (unavailable: 403 Forbidden)",
  "Local Computer (click Reconnect)".

### `packages/theia-files-s3` (new, separate)

Only the S3 type. Separate because `@aws-sdk/client-s3` is large; an app that
does not want S3 does not depend on it. Fields: endpoint URL, region (default
`us-east-1`), bucket, prefix, access key id, secret access key (`secret`).
Path-style addressing, so S3-compatible servers (RustFS, MinIO) work.

### `packages/theia-files-api` (changed)

- `FilesApiFileSystemProvider` gains a public way to report that the tree
  changed under a path, and `FilesApiSource` may carry an `onDidChange` event
  that the provider forwards. `MountService` uses it so the explorer refreshes
  when a mount appears, changes or goes away, or a filter changes.
- The provider can be registered for a second scheme over another `FilesApi`
  (used for the system store below).

### `app/files` (changed)

- **System store, out of the user tree**: `BrowserFilesApi` over OPFS
  `system/`, or `MemFilesApi` when OPFS is missing or `?storage=memory`. It is
  served under its own scheme, `shell-system:`, by a second
  `FilesApiFileSystemProvider`, and Theia's config directory is moved there by
  rebinding `EnvVariablesServer.getConfigDirUri()` to `shell-system:///.theia`
  (browser-only Theia hard-codes `file:///.theia`; its user storage delegates to
  whatever provider serves that URI). So `settings.json`, keymaps and the mount
  table never appear under `file:`, and no root filter can hide them from Theia.
- **Default hidden paths**: `files.hidden` defaults to
  `["**/.git", "**/.git/**", "**/.DS_Store"]` in this app.
- **Defaults** (when `files.mounts` is unset): "Browser Storage" (`opfs`, key
  `browser`, seeded with the demo files) and "Temporary" (`memory`, key `temp`).
  With `?storage=memory` or no OPFS, "Browser Storage" is replaced by an
  in-memory mount of the same key, so the demo still appears.
- The app binds `FilesApiSource` to `MountService`'s `MountedFilesApi`.
  `window.theiaShell.filesApi` stays (the root pipeline, filtered), for tests and
  devtools.

## Data flow

1. Boot: the `shell-system:` provider is registered → preferences load from the
   system store → `FilesApiSource` resolves → `MountService` reads
   `files.mounts` (or the defaults), creates the mounts, builds the composite,
   wraps it in the layers. The explorer shows one folder per mount.
2. Change: wizard / Edit / Unmount / a hand edit of `settings.json` →
   `PreferenceService` change → diff by key → create what changed → rebuild →
   changes reported. An editor open on an unmounted path behaves as when its
   file is deleted.
3. Seeding: the "Browser Storage" default mount is seeded with the demo tree
   when empty (as `seedIfEmpty` does today, one level down).

## Keys

- Derived from the name: lower-case, runs of anything but `[a-z0-9]` → `-`,
  trimmed of `-`; empty → `mount`.
- Unique among mounts; a clash gets `-2`, `-3`… in the suggestion, and the
  wizard refuses a key that is taken.
- Refused: empty, `.`, `..`, or containing `/`. (Nothing is reserved at the
  root any more: the system store is not in the tree.)
- Editing only the key or name is a rename: the mounted `FilesApi` instance is
  reused, so nothing is lost, even for an in-memory mount. For OPFS the
  `directory` config, not the key, names the storage.
- Editing a type's config re-creates the mount; for an in-memory mount that
  means empty, and the wizard says so before applying.

## Errors and reconnect

- A mount whose `create` throws is mounted as an empty, read-only placeholder
  folder with status `failed(message)`; other mounts are unaffected.
- Local folder after a reload: the handle is restored from IndexedDB; if
  permission is not `granted`, status `needs-access` and a placeholder until
  *Reconnect* (the user gesture the browser requires). A handle whose folder is
  gone (`isHandlerAccessible` false) is `failed`.
- An invalid `files.mounts` entry (unknown type, bad key, duplicate, missing
  required field) is skipped and reported once in a notification.

## Follow-up in webrun-files: `CompositeFilesApi.unmount`

`CompositeFilesApi` has `mount` but no `unmount`, so `MountService` rebuilds the
composite on every change. The task (tracked on the umbrella tracker) adds
`unmount(path): boolean` to `webrun-files-composite`: it removes the mount at
exactly that prefix (normalized), returns whether one was removed, refuses `/`,
and leaves nested mounts of other prefixes alone; ships with tests in
`webrun-files-tests`' style and a changeset. When a release carries it, the app
bumps `@statewalker/webrun-files-*` and `MountService` mounts and unmounts in
place on one composite instead of rebuilding. Until then the rebuild is
behind `MountedFilesApi`, so nothing outside `MountService` changes either way.

## Testing (red → green, as in PLAN.md)

**Unit (vitest)**
- key derivation, uniqueness suggestions, key validation;
- `files.mounts` entry validation;
- `MountService` over `MemFilesApi`s: mounts list as root folders; a throwing
  `create` becomes a placeholder with its message; a change re-creates only the
  changed key; a pure rename keeps the instance and its files; unmount removes
  the folder; added / deleted / updated changes are reported;
- layers: applied in priority order; `files.hidden` globs hide a path from
  list/stats/read and refuse writes to it; changing the preference rebuilds the
  pipeline and reports a change;
- adapters: each builds the right object from its config (S3: the client's
  endpoint, region, path style and credentials; no network);
- local folder permission states: granted → mounted, prompt at boot →
  `needs-access`, inaccessible → `failed`.

**e2e (Playwright, static build)**
- default mounts appear with their names; the demo files are under
  "Browser Storage" (existing tests updated to open that folder first);
- wizard: mount memory "Scratch Pad", key prefilled `scratch-pad`; create and
  save a file in it;
- default OPFS storage: after a reload the mount is back from `settings.json`;
- Edit changes the key; Unmount removes the folder; a duplicate key is refused;
- a `.git` folder in a mount is not shown; adding `**/*.log` to `files.hidden`
  hides a log file live; `settings.json` still loads after a reload (the
  `shell-system:` move);
- a broken S3 mount (unreachable endpoint) is shown as unavailable while the
  other mounts work;
- local folder: the adapter's IndexedDB handle path, driven with an OPFS
  directory handle (Playwright cannot drive the native picker).

**e2e against S3 (RustFS in Docker)**
- A fixture starts `rustfs/rustfs:1.0.0-beta.8` on a free port, creates a bucket
  and allows the test origin. Probed: with default settings its preflight
  answers without `Access-Control-*` headers, so CORS must be configured —
  first try `PutBucketCors` on the bucket, else RustFS's server-side CORS
  settings. This is the plan's first task.
- Mount it through the wizard, save a file from the editor, read the object
  back from Node with the S3 SDK; reload; mount and file are still there.
- Skipped, with a message, when Docker is unavailable.

## Risks

- **Secrets in plain text**: S3 keys sit in `settings.json` in the system store (OPFS),
  readable by any script on the origin. Acceptable for this prototype, as asked;
  the follow-up is a secret store keyed by mount.
- **Bundle size**: `@aws-sdk/client-s3` adds several hundred KB; kept out of
  apps that do not depend on `theia-files-s3`.
- **Preferences load from the file system they describe**: avoided by serving
  the system store under `shell-system:`, never a mount and never filtered.
- **Other `file:///.theia` users**: anything in Theia that builds the path by
  hand instead of asking `getConfigDirUri()` would miss the move. The e2e test
  that settings survive a reload guards the case that matters; a grep of the
  app's Theia packages for `.theia` is part of the task.
- **CORS**: a browser can only reach buckets that allow its origin; the
  failure shows as an unavailable mount with the error text.
