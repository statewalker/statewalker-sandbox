# Pluggable FilesApi: mount points and a secret vault — design

Status: agreed in conversation 2026-09-25; awaiting review of this written form.

## Goal

The app's file system becomes a **composite**: every top-level folder is a
**mount point** backed by its own `FilesApi`. The root the app sees is a
**pipeline** — the composite wrapped in pluggable layers, the first being a
filter that hides paths — so it is both composable and filterable. Users mount
new file systems from the UI, each with its own configuration, a display
**name** ("Local Computer") and a unique **key** (the folder name, derived from
the name by default and editable). Mounts are stored with the other settings and
come back, mounted and visible, after a reload.

One mount is the **main storage**: persistent (OPFS or a local folder), holding
the settings and an encrypted **secret vault**. Secrets (S3 keys, …) are never
written in plain text: they are encrypted with a symmetric key, and that key is
itself locked by a password the user enters when the main storage opens.

Types in the first cut: **in-memory**, **OPFS**, **local folder** (File System
Access API) and **S3**. More types ("…") are added by binding one contribution.

## Non-goals

- No storage code. Every backend already exists in `@statewalker/webrun-files-*`
  0.10.0; this work only adapts a JSON config to their constructors.
- No HTTP or SQLite type yet (`webrun-files-http`'s `newClientStub`,
  `webrun-files-sqlite`). Each is one more adapter of the same shape, later.
- No password recovery: a forgotten password means resetting the vault, which
  loses the secrets (not the files, not the settings).
- No migration of files a previous build left at the OPFS root (sandbox
  prototype; they stay in OPFS, unseen).
- No runtime loading of new types; types are Theia DI contributions.

## Existing pieces used

| Need | Package / API | Call |
|---|---|---|
| Mount table | `webrun-files-composite` 0.10.0 | `new CompositeFilesApi(readOnly(new MemFilesApi())).mount("/<key>", api)`; lists each mount as a folder, and nothing can be written beside them. No `unmount` yet, so it is rebuilt on change (see *Follow-up in webrun-files*). |
| Filter layer | `webrun-files-composite` | `new FilteredFilesApi(api, newGlobPathFilter(...globs))`; hidden paths behave as absent, writes to them throw |
| Memory | `webrun-files-mem` | `new MemFilesApi()` |
| OPFS | `webrun-files-browser` | `new BrowserFilesApi({ rootHandle })` over a directory under `navigator.storage.getDirectory()` |
| Local folder | `webrun-files-browser` | `new BrowserFilesApi({ rootHandle })` over a picked handle; `isHandlerAccessible`, `verifyPermission` |
| S3 | `webrun-files-s3` (+ peer `@aws-sdk/client-s3`) | `new S3FilesApi({ client: new S3Client({ endpoint, region, credentials, forcePathStyle: true }), bucket, prefix })` |
| Secret API | `@theia/core` `KeyStoreService` / `CredentialsService` | browser-only Theia binds `KeyStoreService` to a stub that drops every secret; the app rebinds it to the vault |
| Crypto | WebCrypto (`crypto.subtle`) | PBKDF2, AES-GCM, `wrapKey` / `unwrapKey` |

## Main storage

- Exactly one mount is **main**: OPFS (the default) or a local folder the user
  picks. Which one is recorded in IndexedDB (database `theia-shell`, store
  `boot`) — not in `settings.json`, because the settings are read *from* it:

  ```ts
  type MainStorage =
    | { type: "opfs"; key: string; name: string }                       // OPFS dir "main/"
    | { type: "local-folder"; key: string; name: string; handle: FileSystemDirectoryHandle };
  ```

  Default: `{ type: "opfs", key: "browser", name: "Browser Storage" }`.
- The main mount holds a **system folder `/.shell/`**:

  | Path | Content |
  |---|---|
  | `/.shell/settings/` | Theia's config directory: `settings.json` (with `files.mounts`), keymaps, … |
  | `/.shell/vault.key.json` | the vault key, locked by the password (below) |
  | `/.shell/secrets.json` | the secrets, encrypted as a whole (below) |

- `/.shell/settings/` is served under its own scheme, `shell-system:`, by a
  second `FilesApiFileSystemProvider`, and Theia's config directory is moved
  there by rebinding `EnvVariablesServer.getConfigDirUri()` to
  `shell-system:///` (browser-only Theia hard-codes `file:///.theia`; its user
  storage delegates to whatever provider serves that URI).
- In the `file:` tree, `/<main key>/.shell` is hidden by a built-in layer that
  cannot be switched off (see *Layers*), so no user filter change can expose or
  break it.
- *Files: Choose Main Storage…* switches between OPFS and a local folder. If the
  target has no `/.shell/`, it offers to copy the current one (settings, vault
  key, secrets — the password stays the same) or to start empty; then reloads.
- A local-folder main needs a user gesture after every reload (browser rule).
  Before the workbench starts, a small **boot gate** (plain DOM, no Theia UI yet)
  shows "Open ‹name›" — the click that re-grants access — and "Use Browser
  Storage this time". A folder that is gone (`isHandlerAccessible` false) goes
  straight to the second choice, with the reason.
- `?storage=memory`, or a browser with neither OPFS nor directory handles: main
  is an in-memory mount (`browser`). Its vault is created with a random session
  key and **no password prompt**: nothing persists, so there is nothing to
  protect at rest, and the tests that use `?storage=memory` see no dialog.

## Secret vault

**Keys.**
- The **data key**: AES-GCM 256, generated with `crypto.subtle.generateKey` when
  the vault is created. It encrypts `secrets.json`.
- The **password key**: derived from the user's password with PBKDF2 (SHA-256,
  600 000 iterations, 16-byte random salt). It only wraps and unwraps the data
  key, never touches secrets.
- After unlocking, the data key is imported **non-extractable**: code on the page
  can use it but never read it.

**`/.shell/vault.key.json`** (no secret in clear):

```json
{
  "version": 1,
  "id": "<random uuid>",
  "kdf": { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": "<b64>" },
  "wrap": { "name": "AES-GCM", "iv": "<b64>" },
  "wrappedKey": "<b64>"
}
```

A wrong password fails AES-GCM's authentication when unwrapping, so it is
detected, never "succeeds" into garbage.

**`/.shell/secrets.json`**: `{ "version": 1, "iv": "<b64>", "data": "<b64>" }` —
the whole map `{ "<service>/<account>": "<password>" }` as one AES-GCM
ciphertext (additional data: the vault `id`). Names and values are both
encrypted; a fresh IV on every write; a tampered or swapped file fails to
decrypt and is reported, not silently emptied.

**Unlock flow** (when the main storage opens, after the workbench starts):
1. `vault.key.json` exists → if a remembered key is in IndexedDB for this vault
   `id`, use it; else a dialog asks the password, with **Remember on this
   device** and **Skip**. Wrong password → the dialog says so and asks again.
2. `vault.key.json` does not exist → the dialog asks for a **new** password
   (twice); the data key is generated, wrapped, and written; `secrets.json` is
   written empty.
3. **Remember on this device**: IndexedDB (store `vault`, key = vault `id`)
   keeps the *password key* as a non-extractable `CryptoKey` — not the password
   text. Same behaviour for the user (no prompt next time), but the password
   itself never touches disk. *Forget Remembered Password* deletes it.
4. **Skip**: the app works; the vault is **locked**. Mounts that need a secret
   show as locked; *Unlock Secrets* runs the dialog again.

**Commands**: *Secrets: Unlock*, *Secrets: Lock* (drops the data key from
memory), *Secrets: Change Password* (re-wraps the data key; `secrets.json` is
untouched), *Secrets: Forget Remembered Password*, *Secrets: Reset Vault*
(confirm: new data key, all secrets lost; for a forgotten password).

**`VaultKeyStoreService`** implements Theia's `KeyStoreService` over the vault
and is rebound in place of browser-only Theia's stub. So every Theia secret
consumer — mount types through `CredentialsService`, VS Code extensions'
`context.secrets` — lands in the vault. Locked: reads return `undefined`,
writes throw `Secrets are locked`. It fires an `onDidUnlock` event.

## Architecture

### `packages/theia-secret-vault` (new Theia extension)

The vault itself: key file and secrets file formats over a `FilesApi` (pure
module, WebCrypto only, unit-tested in Node), `VaultKeyStoreService`, the
unlock / create / change-password dialog, the commands above, and the
remembered-key store in IndexedDB. It depends on nothing mount-specific: it is
given the `FilesApi` of the folder holding `vault.key.json` and `secrets.json`.

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
    config: Record<string, string>;   // non-secret fields only
  }
  interface MountContext {
    interactive: boolean;             // running from a user gesture
    secret(field: string): Promise<string | undefined>; // from the vault
  }
  ```

  **Secret fields never go into `settings.json`.** The wizard stores each
  `secret` field through `CredentialsService` under service
  `theia-shell.mounts`, account `<key>/<field>`; `create` reads them with
  `ctx.secret(field)`. A key rename moves them; unmount deletes them. A type
  whose required secret is unavailable because the vault is locked gets status
  `locked`, and is re-created on `onDidUnlock`.

  `ctx.interactive` is false at boot; a type that needs a gesture (local
  folder) throws `NeedsUserGesture` then.

- **Built-in types**: memory; OPFS (field `directory`, default the key; storage
  under OPFS `mounts/<directory>`); local folder (field `directory` = pick a
  folder; the handle is kept in IndexedDB under `mount:<key>`, not in JSON).

- **`files.mounts` preference** (user scope → `/.shell/settings/settings.json`
  in the main storage): an array of `MountConfig` for the mounts other than
  main, with a JSON schema so a hand edit is checked. Unset means the app's
  defaults (below). The main mount comes from `MainStorage` and is always
  present.

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

  Built-in layers:
  - **system folder** (always on): hides `/<main key>/.shell`;
  - **hidden paths**: the `files.hidden` preference (glob list, default `[]`;
    the app sets its own default) through `FilteredFilesApi` +
    `newGlobPathFilter`.

  A hidden path is absent for every consumer of the root: explorer, editors,
  search, and `window.theiaShell.filesApi`.

- **`MountService`**:
  - owns a stable **`MountedFilesApi`**: a `FilesApi` that delegates to the
    current pipeline — `layers(composite)` — so callers never see a rebuild;
    a mount change, an unlock or a layer's `onDidChange` rebuilds it;
  - on start and on every `files.mounts` change: validates entries, diffs by
    key against what is mounted, calls `create` only for new or changed
    entries (in parallel), rebuilds the composite, then reports what changed:
    added at `/<key>`, deleted at a removed `/<key>`, updated at `/`. An entry
    whose type and config equal a mounted one's is a rename: its `FilesApi`
    instance is reused, not re-created;
  - keeps a status per key: `mounted`, `needs-access`, `locked`,
    `failed(message)`.

- **Commands and menus**:
  - *Files: Mount File System…* (command palette, explorer title): quick input
    steps type → name → key (prefilled with the slug, validated live) → the
    type's fields (secret fields as password inputs; if the vault is locked,
    it is unlocked first). It writes `files.mounts` and the vault.
  - On a root folder (explorer context menu): *Edit Mount…* (same steps,
    prefilled; secret fields shown as "unchanged" unless retyped; the type is
    fixed), *Unmount* (confirm, then remove the entry and its secrets),
    *Reconnect* (shown for `needs-access` and `failed`). The main mount has
    neither Unmount nor a type change; *Choose Main Storage…* replaces it.
  - *Files: Choose Main Storage…* (see *Main storage*).
- **Labels**: a `LabelProviderContribution` shows a root folder by its mount
  name, with a status suffix: "Cloud (unavailable: 403 Forbidden)",
  "Local Computer (click Reconnect)", "Cloud (locked)".

### `packages/theia-files-s3` (new, separate)

Only the S3 type. Separate because `@aws-sdk/client-s3` is large; an app that
does not want S3 does not depend on it. Fields: endpoint URL, region (default
`us-east-1`), bucket, prefix, access key id (`secret`), secret access key
(`secret`). Path-style addressing, so S3-compatible servers (RustFS, MinIO)
work.

### `packages/theia-files-api` (changed)

- `FilesApiFileSystemProvider` gains a public way to report that the tree
  changed under a path, and `FilesApiSource` may carry an `onDidChange` event
  that the provider forwards, so the explorer refreshes when a mount appears,
  changes or goes away, or a filter changes.
- The provider can be registered for a second scheme over another `FilesApi`
  (`shell-system:`).

### `app/files` (changed)

- Opens `MainStorage` (boot gate if needed), serves its `/.shell/settings/` as
  `shell-system:`, hands `/.shell/` to the vault, and binds `FilesApiSource` to
  `MountService`'s `MountedFilesApi`. `window.theiaShell.filesApi` stays (the
  filtered root), for tests and devtools.
- **Default hidden paths**: `files.hidden` defaults to
  `["**/.git", "**/.git/**", "**/.DS_Store"]` in this app.
- **Default mounts** (when `files.mounts` is unset): "Temporary" (`memory`, key
  `temp`). The main storage ("Browser Storage", `browser`) is seeded with the
  demo files when empty.

## Data flow

1. Boot: read `MainStorage` from IndexedDB → (boot gate for a local folder) →
   open the main `FilesApi` → register `shell-system:` → preferences load →
   `FilesApiSource` resolves → `MountService` mounts main, reads `files.mounts`
   (or the defaults), creates the other mounts (secret-needing ones wait for
   the vault), builds and wraps the composite → the explorer shows one folder
   per mount.
2. Vault: once the workbench is up, the unlock (or create) dialog runs, or a
   remembered key unlocks silently → `onDidUnlock` → `locked` mounts are
   created.
3. Change: wizard / Edit / Unmount / a hand edit of `settings.json` →
   `PreferenceService` change → diff by key → create what changed → rebuild →
   changes reported. An editor open on an unmounted path behaves as when its
   file is deleted.

## Keys (mount keys)

- Derived from the name: lower-case, runs of anything but `[a-z0-9]` → `-`,
  trimmed of `-`; empty → `mount`.
- Unique among mounts, main included; a clash gets `-2`, `-3`… in the
  suggestion, and the wizard refuses a key that is taken.
- Refused: empty, `.`, `..`, or containing `/`.
- Editing only the key or name is a rename: the mounted `FilesApi` instance is
  reused (nothing is lost, even in memory) and its secrets move with it. For
  OPFS the `directory` config, not the key, names the storage.
- Editing a type's config re-creates the mount; for an in-memory mount that
  means empty, and the wizard says so before applying.

## Errors and reconnect

- A mount whose `create` throws is mounted as an empty, read-only placeholder
  folder with status `failed(message)`; other mounts are unaffected.
- Local folder (not main) after a reload: the handle is restored from
  IndexedDB; if permission is not `granted`, status `needs-access` and a
  placeholder until *Reconnect* (the user gesture the browser requires). A
  handle whose folder is gone is `failed`.
- Vault: wrong password → asked again; `secrets.json` that does not decrypt
  (tampered, or from another vault) → error notification, vault stays locked,
  nothing is overwritten until *Reset Vault*.
- An invalid `files.mounts` entry (unknown type, bad key, duplicate, missing
  required field) is skipped and reported once in a notification.

## Follow-up in webrun-files: `CompositeFilesApi.unmount`

`CompositeFilesApi` has `mount` but no `unmount`, so `MountService` rebuilds the
composite on every change. The task
([statewalker/umbrella#44](https://github.com/statewalker/umbrella/issues/44))
adds `unmount(path): boolean` to `webrun-files-composite`. When a release
carries it, the app bumps `@statewalker/webrun-files-*` and `MountService`
mounts and unmounts in place on one composite. Until then the rebuild is behind
`MountedFilesApi`, so nothing outside `MountService` changes either way.

## Testing (red → green, as in PLAN.md)

**Unit (vitest; Node has WebCrypto)**
- vault: create → unlock with the right password; wrong password rejected;
  change password keeps the secrets; the remembered (non-extractable) password
  key unlocks without the password; reset loses secrets; `secrets.json` holds
  no plaintext name or value; a tampered or swapped `secrets.json` fails loudly;
  locked reads return `undefined` and writes throw;
- `VaultKeyStoreService` against Theia's `KeyStoreService` contract;
- mount keys: derivation, uniqueness suggestions, validation;
- `files.mounts` entry validation; secret fields rejected in `config`;
- `MountService` over `MemFilesApi`s: mounts list as root folders; a throwing
  `create` becomes a placeholder; a locked secret gives `locked`, then mounted
  on unlock; a change re-creates only the changed key; a rename keeps the
  instance, its files and its secrets; unmount removes the folder and its
  secrets; added / deleted / updated changes are reported;
- layers: priority order; the system-folder layer always hides `/<main>/.shell`;
  `files.hidden` hides from list/stats/read and refuses writes; changing it
  rebuilds and reports;
- adapters: each builds the right object from its config (S3: endpoint, region,
  path style, credentials from `ctx.secret`; no network);
- local folder permission states: granted → mounted, prompt at boot →
  `needs-access`, inaccessible → `failed`.

**e2e (Playwright, static build)**
- first run (OPFS): the create-password dialog; then the main mount "Browser
  Storage" with the demo files. Existing tests (`?storage=memory`, no dialog)
  are updated to open "Browser Storage" first;
- reload (OPFS): the password is asked; with *Remember*, it is not asked the
  next time; `.shell` is never shown in the explorer;
- wizard: mount memory "Scratch Pad", key prefilled `scratch-pad`; create and
  save a file; reload: the mount is back from `settings.json`;
- Edit changes the key; Unmount removes the folder; a duplicate key is refused;
- a `.git` folder is not shown; adding `**/*.log` to `files.hidden` hides a log
  file live;
- *Skip* → an S3 mount shows "locked"; *Unlock Secrets* mounts it;
- a broken S3 mount (unreachable endpoint) shows as unavailable while the other
  mounts work;
- local folder: the adapter's IndexedDB handle path and a local-folder *main*,
  driven with OPFS directory handles (Playwright cannot drive the native
  picker); the boot gate's "Use Browser Storage this time".

**e2e against S3 (RustFS in Docker)**
- A fixture starts `rustfs/rustfs:1.0.0-beta.8` on a free port, creates a bucket
  and allows the test origin. Probed: with default settings its preflight
  answers without `Access-Control-*` headers, so CORS must be configured —
  first try `PutBucketCors` on the bucket, else RustFS's server-side CORS
  settings. This is the plan's first task.
- Mount it through the wizard, save a file from the editor, read the object
  back from Node with the S3 SDK; the raw `settings.json` and `secrets.json`
  contain neither key; reload, unlock: mount and file are still there.
- Skipped, with a message, when Docker is unavailable.

## Risks

- **Same-origin code**: any script running on the app's origin can, while the
  vault is unlocked, ask it to decrypt (it cannot extract the keys). At rest,
  without the password or a remembered key, the secrets are unreadable. A
  remembered key trades that at-rest protection on this device for no prompt.
- **Forgotten password**: the secrets are lost (by design); *Reset Vault* makes
  a new, empty vault.
- **PBKDF2 cost**: 600 000 iterations take a noticeable fraction of a second on
  slow devices, once per unlock.
- **Bundle size**: `@aws-sdk/client-s3` adds several hundred KB; kept out of
  apps that do not depend on `theia-files-s3`.
- **Other `file:///.theia` users**: anything in Theia that builds the path by
  hand instead of asking `getConfigDirUri()` would miss the move. The e2e test
  that settings survive a reload guards the case that matters; a grep of the
  app's Theia packages for `.theia` is part of the task.
- **Boot gate before Theia**: a local-folder main needs a click before the
  workbench can load its settings; the gate is plain DOM, so it must stay
  small and be tested directly.
- **CORS**: a browser can only reach buckets that allow its origin; the failure
  shows as an unavailable mount with the error text.
