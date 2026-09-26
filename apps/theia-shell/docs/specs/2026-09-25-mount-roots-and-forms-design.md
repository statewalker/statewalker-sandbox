# Mounts as workspace roots, and one form per mount — design

Status: agreed in conversation 2026-09-25; awaiting review of this written form.
Builds on [`2026-09-25-pluggable-files-api-design.md`](2026-09-25-pluggable-files-api-design.md).

## Goal

1. **Mounts are workspace roots.** The explorer shows every mount ("Browser
   Storage", "Temporary", "Cloud", …) as a top-level workspace folder, not
   nested under one "Files" folder; a newly mounted folder appears there at once.
2. **Add / Remove Folder is mount / unmount.** *Add Folder to Workspace…* lists
   every known file system not in the workspace — including ones removed
   earlier — to re-add in one click, plus entries to mount a new one.
   *Remove Folder from Workspace* unmounts a folder but **remembers** it
   (configuration, S3 keys, local folder handle); *Forget* deletes it for good.
3. **One form per mount.** The mount path (the name of the workspace folder) is
   entered in the same dialog as the file system's own configuration — for S3,
   endpoint, region, bucket, prefix and keys.
4. **Local folders: pick first.** For a local folder, the browser's folder picker
   opens first; the form then opens with the name and mount path defaulting to
   the selected folder's name.

## Non-goals

- No change to the mount types' backends, the vault or the main storage.
  Existing `files.mounts` settings keep working (every entry without the new
  `mounted` flag counts as mounted).
- No per-root settings UI.

## 1. Mounts as workspace roots

**Findings (Theia 1.76, browser-only).**
- `WorkspaceService.computeRoots()` reads the roots of a multi-root workspace
  from a workspace file (`*.theia-workspace`, `{ "folders": [{ "path": … }] }`)
  through `FileService`, so the file may live under any scheme with a provider.
  Theia recomputes the roots when that file changes.
- The default workspace comes from the URL fragment first — read as a **path**
  with the `file` scheme — then from `WorkspaceServer.getMostRecentlyUsedWorkspace()`.
  Theia also writes the workspace's path back into the fragment. So a
  workspace file outside `file:` needs `WorkspaceService` to be told where it is.

**Design.**
- A derived workspace file, `shell-system:///workspace.theia-workspace` (in the
  main storage: `/.shell/settings/workspace.theia-workspace`), lists one folder per
  mount: main first, then `files.mounts` in order, as `file:///<key>`.
  `files.mounts` stays the only source of truth: `MountService` rewrites the
  file's `folders` through Theia's `FileService` whenever the mounted set
  changes, keeping any other content (Theia stores workspace-scope settings
  there, which makes them writable — closing a known gap).
- A `WorkspaceService` subclass (`MountsWorkspaceService`) always opens that
  file: its default workspace URI is the workspace file, whatever the fragment
  says, and it does not write the fragment. `FilesApiWorkspaceServer` returns
  the same URI.
- Labels: roots are `file:///<key>`, already labelled by `MountLabelContribution`
  with the mount's name and status.
- Theia's workspace commands stay, with new meanings:
  - *Add Folder to Workspace…* (and *File → Mount File System…*, the same
    command) opens the **folder list** (below);
  - *Remove Folder from Workspace* on a mount unmounts it and remembers it; on
    the main storage it is refused with a message. *Unmount* in the explorer's
    context menu is the same action;
  - *Open Workspace…*, *Save Workspace As…*, *Close Workspace* keep Theia's
    behaviour. (After *Close Workspace*, a reload reopens the mounts workspace.)

**Remembered folders.**
- A `files.mounts` entry gains an optional `"mounted": false`. Removing a folder
  sets it; nothing else about the entry, its vault secrets or its local folder
  handle changes. Adding it back clears it. Absent means mounted.
- *Forget* (in the folder list, per remembered entry, with a confirmation)
  deletes the entry, its secrets and its local handle — what *Unmount* did before.
- Keys stay unique across all entries, mounted or remembered, so a remembered
  folder's secrets and handle never collide with another's.

**The folder list** (a quick pick, *Add Folder to Workspace…*):
- **Remembered file systems**, each with its type — "Cloud (S3 bucket)",
  "Photos (folder on this computer)", "Drafts (browser storage)" — one click
  re-adds it (a local folder may ask for access: that click is the gesture);
- **Browser-storage folders** that exist under OPFS `mounts/` but no entry
  refers to — "archive (browser storage)" — one click mounts it with that name;
- then, per available type: **"New folder on this computer…"**, **"New S3
  bucket…"**, **"New browser-storage folder…"**, **"New in-memory folder…"**,
  each opening the form flow below;
- each remembered entry has a *Forget* button in its row.
- `FilesApiRootLabel` ("Files") is no longer shown in the app: there is no
  single root.

**Fallback** if the spike (first plan task) shows that browser-only Theia will
not open a workspace file outside `file:`: keep the file in the `file:` tree at a
path no mount can use, `file:///.workspace/mounts.theia-workspace`, served by a
small read-write system mount that the system-folder layer hides from listings
only (so Theia can still read and write it), and report the change in the plan.

## 2. One form per mount

- **Flow:** a "New …" entry of the folder list → for a type with an interactive
  step (`configure`, the local folder's picker) that step runs **first** → one
  **form dialog**.
- **The form** (`MountFormDialog`, a Theia `AbstractDialog`):
  - **Name** — for a local folder, prefilled with the folder's name;
  - **Mount path** — the key; prefilled with `suggestKey(name)` and following the
    name until edited by hand; validated live (`validateKey`, unique);
  - then the type's `fields` in order: text, URL (http/https), secret (password
    input; in *Edit Mount…* empty means "keep the current value").
  - Errors are shown in the dialog; **Mount** (or **Save**) is disabled until
    the form is valid. Cancel changes nothing.
- *Edit Mount…* opens the same form, prefilled, with the type fixed; for a local
  folder it does not re-run the picker (a "Choose another folder…" button in the
  form does).
- `MountType` changes: `configure` runs before the form and may return
  suggestions (`{ config, name? }`) — the local folder returns
  `{ config: { directory, handleId }, name: handle.name }`.
- The form's validation is a pure function (`validateMountForm`) so it is
  unit-tested; the dialog only renders it.

## Testing (red → green)

- **Spike first** (plan Task 1): a browser-only Theia opening
  `shell-system:///workspace.theia-workspace` through `MountsWorkspaceService`
  shows its folders as roots, follows edits of the file live, and reopens it
  after a reload. If it cannot, take the fallback above.
- **Unit:** building the workspace file from the mounted set (order, main first,
  other content kept, no rewrite when nothing changed); `validateMountForm`
  (required fields, unique key across mounted and remembered entries, URL
  fields, secret "keep" rule, key following the name until edited);
  `mounted: false` entries are validated but not mounted; building the folder
  list (remembered entries, unreferenced browser-storage folders, "New …" per
  available type).
- **e2e:**
  - the explorer shows the mounts as roots, with no "Files" entry;
  - mounting adds a root live; *Remove Folder from Workspace* removes it and
    *Add Folder to Workspace…* lists it as remembered — re-adding brings back
    its files (memory aside: an in-memory folder comes back empty); *Forget*
    removes it from the list;
  - local folder: the picker comes first, the mount path defaults to the
    folder's name;
  - S3: endpoint, bucket and keys in one form; a bad URL disables *Mount*;
  - a workspace-scope setting can be saved and survives a reload;
  - every existing app e2e test, updated to the roots and the form.

## Risks

- Theia code that assumes a `file:` workspace (the fragment, recent workspaces)
  — handled by the subclass; the spike proves it before anything is built on it.
- *Open Workspace…* / *Close Workspace* leave the mounts workspace for the
  session; a reload restores it. Acceptable, as agreed.
