# Mounts as workspace roots, and one form per mount — design

Status: agreed in conversation 2026-09-25; awaiting review of this written form.
Builds on [`2026-09-25-pluggable-files-api-design.md`](2026-09-25-pluggable-files-api-design.md).

## Goal

1. **Mounts are workspace roots.** The explorer shows every mount ("Browser
   Storage", "Temporary", "Cloud", …) as a top-level entry of the workspace, not
   nested under one "Files" folder.
2. **One form per mount.** The path alias (the mount key) is entered in the same
   dialog as the file system's own configuration (endpoint, bucket, keys, …).
3. **Local folders: pick first.** For *Folder on this Computer*, the folder is
   chosen first; the form then opens with the mount path defaulting to the
   folder's name.

## Non-goals

- No change to `files.mounts`, the mount types, the vault or the main storage.
  Existing settings keep working.
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
- Theia's workspace commands stay:
  - *Add Folder to Workspace…* opens the mount form (below);
  - *Remove Folder from Workspace* on a mount root does *Unmount* (with its
    confirmation); on the main storage it is refused with a message;
  - *Open Workspace…*, *Save Workspace As…*, *Close Workspace* keep Theia's
    behaviour. (After *Close Workspace*, a reload reopens the mounts workspace.)
- `FilesApiRootLabel` ("Files") is no longer shown in the app: there is no
  single root.

**Fallback** if the spike (first plan task) shows that browser-only Theia will
not open a workspace file outside `file:`: keep the file in the `file:` tree at a
path no mount can use, `file:///.workspace/mounts.theia-workspace`, served by a
small read-write system mount that the system-folder layer hides from listings
only (so Theia can still read and write it), and report the change in the plan.

## 2. One form per mount

- **Flow:** *Mount File System…* (or *Add Folder to Workspace…*) → pick the type
  (quick pick, as now) → for a type with an interactive step (`configure`, the
  local folder's picker) that step runs **first** → one **form dialog**.
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
  (required fields, unique key, URL fields, secret "keep" rule, key following
  the name until edited).
- **e2e:**
  - the explorer shows the mounts as roots, with no "Files" entry;
  - mounting adds a root live, *Unmount* and *Remove Folder from Workspace*
    remove it, *Add Folder to Workspace…* opens the form;
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
