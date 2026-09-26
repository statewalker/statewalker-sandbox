# @theia-shell/theia-files-mounts

A Theia extension that turns a browser-only app's file system into **mount
points**: every workspace folder is a `FilesApi` of its own (memory, browser
storage, a folder on the computer, S3, …), over one **main storage** that also
holds the settings and the secret vault. Every backend is an existing
`@statewalker/webrun-files-*` class; this package adapts configurations to
them. The design is in
[`docs/specs/2026-09-25-pluggable-files-api-design.md`](../../docs/specs/2026-09-25-pluggable-files-api-design.md).

## Extension points

**`MountType`** — a kind of file system. Bind with `bind(MountType).to(…)`.

```ts
interface MountType {
  readonly id: string;              // "memory", "opfs", "local-folder", "s3"
  readonly label: string;           // shown in the wizard
  readonly fields: MountField[];    // what the wizard asks, in order
  isAvailable(): boolean;
  create(mount: MountConfig, ctx: MountContext): Promise<FilesApi>;
  newLabel?: string;                // the folder list's "New …" row, e.g. "New S3 Bucket…"
  configure?(mount: MountConfig): Promise<{ config: Record<string, string>; name?: string } | undefined>; // runs before the form (folder picker)
  forget?(mount: MountConfig): Promise<void>;                                  // on unmount
}
interface MountField {
  name: string; label: string; kind: "text" | "secret" | "url";
  required?: boolean; default?: string | ((mount: { key: string; name: string }) => string);
}
interface MountContext {
  interactive: boolean;             // from a click: may ask the browser for access
  locked: boolean;                  // the vault is locked
  secret(field: string): Promise<string | undefined>;
}
```

`create` throws `NeedsUserGesture` when it can only proceed from a click, and
`SecretsLocked` when a secret is missing because the vault is locked. Any other
error makes the mount a placeholder with that message, and so does a `create`
that has not answered after 15 s, so one unreachable host never holds up the
other mounts. `secret` fields are
stored in the vault (`CredentialsService`, service `theia-shell.mounts`,
account `<key>/<field>`), never in settings.

Built in: **memory**, **OPFS** (a folder under OPFS `mounts/`), **local folder**
(File System Access; the handle is kept in IndexedDB under a random `handleId`,
so renaming the key keeps it). `theia-files-s3` adds **S3**.

**`FilesApiLayer`** — a wrapper around the whole tree, applied in `priority`
order (lower is closer to the mounts):

```ts
interface FilesApiLayer {
  readonly id: string;
  readonly priority: number;
  wrap(root: FilesApi): FilesApi;     // FilteredFilesApi, GuardedFilesApi, readOnly…
  readonly onDidChange?: Event<void>; // wrap differently from now on
}
```

Built in: **system folder** (always hides `/<main key>/.shell`) and **hidden
paths** (the `files.hidden` globs). A hidden path is absent for everyone:
explorer, editors, search.

## Mounts are the workspace's roots

The explorer shows one top-level workspace folder per mount — the main storage
first, then `files.mounts` in order — with no single "Files" root. A
multi-root workspace file lists them (`{ "folders": [{ "path": "file:///<key>",
"name": "<name>" }] }`); `MountService` rewrites its `folders` whenever the
mounts change — editing only `folders`, as JSONC, so comments, trailing
commas and every other key stay — and workspace-scope settings (which Theia
stores there) work too. A file it cannot parse is left alone and reported. At
startup it only creates a missing file; the full list follows once the
settings are read.

Mount paths cannot start with `.` (reserved for system mounts) or contain
`/ \ # ? %` (they would change the root's URI).

Theia 1.76 opens only `file:` workspaces, so the file lives in the `file:` tree:
`file:///.workspace/mounts.theia-workspace`, a system mount over the main
storage's `/.shell/workspace`. It is never a root; the key `.workspace` is
reserved. `MountsWorkspaceService` always opens it and leaves the URL alone.

## Adding and removing folders

- ***File → Mount File System…*** and ***Add Folder to Workspace…*** open the
  **folder list**: remembered folders (one click adds one back), browser-storage
  folders under OPFS `mounts/` that no mount uses (one click mounts one), and a
  "New …" row per available type. A remembered row has a *Forget* button.
- A "New …" row runs the type's interactive step first (a local folder: the
  folder picker), then opens **one form**: the name, the mount path (the
  workspace folder's name; it follows the name until edited, and must be
  unique among all mounts, remembered ones included) and the type's fields.
  **Mount** stays disabled until the form is valid; errors show under each field.
- ***Remove Folder from Workspace*** (and *Unmount*) takes a folder out of the
  workspace but **remembers** it: its `files.mounts` entry gets
  `"mounted": false`, and its secrets and local folder handle are kept. The main
  storage cannot be removed. *Forget* deletes the entry, its secrets and handle.
- *Edit Mount…* opens the same form, prefilled; a local folder's form has
  *Choose another folder…*.

## Main storage

One mount is main: OPFS (`main/`) by default, or a folder on the computer
(*Files: Choose Main Storage…*). Which one is kept in IndexedDB
(`theia-shell-boot`), because the settings are read from it. Its `/.shell`
holds `settings/` (Theia's config directory), `vault.key.json` and
`secrets.json`. A local-folder main storage needs a click after each reload: a
small boot gate, before the workbench, offers "Open ‹name›" or "Use Browser
Storage this time". `?storage=memory`, or no OPFS, gives an in-memory main
storage.

Theia's settings are served from `/.shell/settings` under their own scheme,
`shell-system:`, so they are never in the file tree and no filter can hide them
from Theia. That takes three rebinds: `EnvVariablesServer.getConfigDirUri()` →
`shell-system:///`; `UserStorageContribution` → a subclass whose `getDelegate()`
activates `shell-system` (Theia hard-codes `file`); and a `FileServiceContribution`
registering the provider.

The root never waits for preferences — folder-scope preferences are read
through it — so it starts with the main mount, and the other mounts follow as
reported changes once preferences are ready.

## Settings

```json
{
  "files.mounts": [
    { "key": "temp", "name": "Temporary", "type": "memory", "config": {} },
    { "key": "drafts", "name": "Drafts", "type": "opfs", "config": { "directory": "drafts" } },
    {
      "key": "cloud", "name": "Cloud", "type": "s3",
      "config": { "endpoint": "https://s3.example.com", "region": "us-east-1", "bucket": "notes" }
    }
  ],
  "files.hidden": ["**/.git", "**/.git/**", "**/*.log"]
}
```

Unset, both fall back to the app's `MountDefaults`. A bad `files.mounts` entry
(no key, a duplicate or unknown type, a secret in `config`) is skipped with one
warning; the rest mount. A `files.mounts` that is not an array is reported, not
replaced by the defaults. A `files.hidden` glob that does not compile is
ignored with one warning; the others apply. Changes to the tree run one at a
time, and a failed one is reported without blocking the next.

## Commands

*File → Mount File System…* / *Add Folder to Workspace…* (the folder list), and
on a mount's folder: *Edit Mount…*, *Remove Folder from Workspace* / *Unmount*,
*Reconnect* (for mounts that need access or failed). *File → Choose Main
Storage…*.

## Known gaps

- Theia fires a preference change before it writes `settings.json`; a reload in
  the next instant loses a mount just made.
- `CompositeFilesApi` has no `unmount` yet
  ([statewalker/umbrella#44](https://github.com/statewalker/umbrella/issues/44)),
  so the composite is rebuilt on every change, behind `MountedFilesApi`.

## Red / green

- Keys, config checks, layers, mount table (`tests/mount-*.test.ts`,
  `layers.test.ts`). Red: the modules missing. Green: 17 of 17.
- Folder access (`tests/folder-access.test.ts`). Red: the module missing.
  Green: 5 of 5.
- System folder (`tests/system-folder.test.ts`). Red: the module missing.
  Green: 2 of 2; the package's 24 of 24.
- The Theia wiring is covered end to end in `app/tests/mounts.spec.ts`,
  `roots.spec.ts` and `vault.spec.ts`.
- **Workspace roots, remembered folders, the list and the form.** Unit, each
  seen red first: the workspace file (6), system mounts left out of the roots,
  `mounted: false` (3, one already green as a guard), the folder list (1), the
  form's validation (4). End to end: the roots tests red, then green through a
  spike that found Theia refuses non-`file:` workspaces (hence
  `/.workspace`). The later `roots.spec.ts` cases were written after the code;
  the key one was checked by mutation (making *Remove* forget fails it).
- **After the final review**, each seen red first: a failed step no longer
  blocks later mount changes (`SerialQueue`, 2 tests); a glob that does not
  compile is skipped and reported (1); a mount that never answers is failed
  after a timeout (1); a malformed `files.mounts` is reported, not replaced
  (`mountsSetting`, 2); end to end, a bad glob and a non-array `files.mounts`
  (2). The package's 30 of 30.
