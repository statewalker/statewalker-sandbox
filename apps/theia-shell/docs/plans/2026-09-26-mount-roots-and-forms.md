# Mounts as workspace roots, and one form per mount — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every mount is a top-level workspace folder; *Add/Remove Folder to/from Workspace* mount and unmount (removed folders are remembered and re-addable from a list); a new mount is configured in one form, and a local folder is picked before the form opens.

**Architecture:** A derived multi-root workspace file (`shell-system:///workspace.theia-workspace`) listing `file:///<key>` per mounted folder, kept in sync by `MountService` and always opened by a `WorkspaceService` subclass. `files.mounts` entries gain `mounted?: false` for remembered folders. Pure logic (workspace file, folder list, form validation) lives in `src/common` with vitest tests; the quick-pick list, the form dialog and the command overrides live in `src/browser`, covered by Playwright.

**Tech Stack:** Theia 1.76.0 browser-only, TypeScript 5.9 (CommonJS), vitest 4, Playwright 1.56, `@statewalker/webrun-files*` 0.10.0.

**Spec:** `apps/theia-shell/docs/specs/2026-09-25-mount-roots-and-forms-design.md` (on top of `2026-09-25-pluggable-files-api-design.md`).

All paths are relative to `apps/theia-shell/`. Package `M` = `packages/theia-files-mounts`.

## Global Constraints

- Exact pins as today (`@theia/*` 1.76.0, `@statewalker/webrun-files*` 0.10.0).
- Workspace file: `shell-system:///workspace.theia-workspace` (= main storage `/.shell/settings/workspace.theia-workspace`), folders as `{ "path": "file:///<key>" }`, main first, then mounted `files.mounts` entries in order.
- `files.mounts` entry: `{ key, name, type, config, mounted? }`; `mounted` absent or `true` = mounted, `false` = remembered.
- Keys unique across all entries (mounted and remembered) and the main key.
- Commands replaced by id: `workspace:addFolder` → the folder list; `workspace:removeFolder` → unmount-and-remember. `files.mount` (*Mount File System…*) = the folder list too.
- Red → green for every change; biome clean (`npx -y @biomejs/biome@2.5.11 check apps/theia-shell` from the repo root); commits `theia-shell: …` with the `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` trailer.

## Review Focus

1. A hand-edited `files.mounts` with `"mounted": "no"` (not a boolean) → reported like any bad entry, the rest mount (Task 2 test).
2. Removing the last non-main folder, then reloading → the workspace shows only the main storage and the list still offers the removed one (Task 5 e2e).
3. Re-adding a remembered local folder whose permission lapsed → the list click is the gesture that asks the browser; a denied request leaves it listed and says why (Task 3: remount is interactive).
4. A mount path typed with trailing spaces or upper case → trimmed; case kept but uniqueness is exact (Task 4 `validateMountForm` test).
5. A workspace file edited by hand (extra settings, a stray folder) → `folders` is rewritten from the mounts, every other key is kept (Task 1 test).

---

### Task 1: Spike + the workspace file (roots from mounts)

**Files:**
- Create: `M/src/common/workspace-file.ts`; Test: `M/tests/workspace-file.test.ts`
- Create: `M/src/browser/mounts-workspace-service.ts`
- Modify: `M/src/browser/mount-service.ts` (write the workspace file after every rebuild)
- Modify: `M/src/browser/mounts-frontend-module.ts` (rebind `WorkspaceService`; `FilesApiWorkspaceRoot` → the workspace file URI)
- Test (e2e): `app/tests/roots.spec.ts`

**Interfaces — produces:**
- `WORKSPACE_FILE_URI = "shell-system:///workspace.theia-workspace"`
- `updateWorkspaceFile(existing: string | undefined, keys: readonly string[]): string | undefined` — the new text, or `undefined` when `folders` already matches.

- [ ] **Step 1: Failing unit test** `M/tests/workspace-file.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { updateWorkspaceFile } from "../src/common/workspace-file";

describe("updateWorkspaceFile", () => {
  it("lists one file:/// folder per key, in order", () => {
    const text = updateWorkspaceFile(undefined, ["browser", "temp", "cloud"]) as string;
    expect(JSON.parse(text).folders).toEqual([
      { path: "file:///browser" },
      { path: "file:///temp" },
      { path: "file:///cloud" },
    ]);
  });

  it("keeps everything else in the file, and rewrites only folders", () => {
    const existing = JSON.stringify({ folders: [{ path: "file:///stray" }], settings: { "editor.fontSize": 16 } });
    const next = JSON.parse(updateWorkspaceFile(existing, ["browser"]) as string);
    expect(next.settings).toEqual({ "editor.fontSize": 16 });
    expect(next.folders).toEqual([{ path: "file:///browser" }]);
  });

  it("returns undefined when nothing changes", () => {
    const text = updateWorkspaceFile(undefined, ["browser"]) as string;
    expect(updateWorkspaceFile(text, ["browser"])).toBeUndefined();
  });

  it("replaces a file that is not valid JSON", () => {
    expect(JSON.parse(updateWorkspaceFile("{ oops", ["browser"]) as string).folders).toHaveLength(1);
  });
});
```
Run `pnpm --filter @theia-shell/theia-files-mounts exec vitest run tests/workspace-file.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement** `M/src/common/workspace-file.ts`:
```ts
/** The multi-root workspace whose folders are the mounts (main storage, `.shell/settings`). */
export const WORKSPACE_FILE_URI = "shell-system:///workspace.theia-workspace";

/**
 * The workspace file's text with `folders` set to one `file:///<key>` per key,
 * everything else kept — or undefined when `folders` already matches.
 */
export function updateWorkspaceFile(existing: string | undefined, keys: readonly string[]): string | undefined {
  let data: Record<string, unknown> = {};
  if (existing !== undefined) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
    } catch {
      data = {};
    }
  }
  const folders = keys.map((key) => ({ path: `file:///${key}` }));
  if (existing !== undefined && JSON.stringify(data.folders) === JSON.stringify(folders)) return undefined;
  return `${JSON.stringify({ ...data, folders }, null, 2)}\n`;
}
```
Run → 4 passed. (Theia writes JSONC; comments in a hand-edited file are lost when `folders` changes — acceptable, note in README.)

- [ ] **Step 3: Failing e2e** `app/tests/roots.spec.ts`:
```ts
import { expect, test } from "@playwright/test";
import { explorer, start, unlockVault } from "./helpers";

test("the mounts are the workspace's top-level folders, with no Files wrapper", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  const roots = page.locator("#files .theia-TreeNode[data-node-id]").filter({ has: page.locator(".theia-TreeNodeSegment") });
  await expect(explorer(page).getByText("Browser Storage", { exact: true })).toBeVisible();
  await expect(explorer(page).getByText("Temporary", { exact: true })).toBeVisible();
  // Multi-root: the section header is the workspace, not the "Files" root label.
  await expect(page.locator("#explorer-view-container--files").getByText("Files", { exact: true })).toHaveCount(0);
  void roots;
  expect(errors).toEqual([]);
});

test("the workspace survives a reload with default storage", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await page.reload();
  await unlockVault(page, "pw");
  await expect(explorer(page).getByText("Browser Storage", { exact: true })).toBeVisible();
  expect(new URL(page.url()).hash).not.toContain("file");
});
```
Build the app, run `pnpm exec playwright test tests/roots.spec.ts` in `app/` → FAIL (a "Files" header is shown).

- [ ] **Step 4: Implement the spike's code**

`M/src/browser/mounts-workspace-service.ts`:
```ts
import { injectable } from "@theia/core/shared/inversify";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { WORKSPACE_FILE_URI } from "../common/workspace-file";

/**
 * Always opens the mounts workspace. Theia reads the default workspace from the
 * URL fragment as a `file:` path and writes it back there; the mounts
 * workspace lives under `shell-system:`, so both are bypassed.
 */
@injectable()
export class MountsWorkspaceService extends WorkspaceService {
  protected override async getDefaultWorkspaceUri(): Promise<string | undefined> {
    return WORKSPACE_FILE_URI;
  }

  protected override setURLFragment(): void {}
}
```
In `mount-service.ts`: inject `FileService` (`@theia/filesystem/lib/browser/file-service`); after each successful `table.apply(...)` in `apply()`, call `await this.syncWorkspaceFile()`:
```ts
  /** Keeps the workspace file's folders equal to the mounted keys (main first). */
  protected async syncWorkspaceFile(): Promise<void> {
    const uri = new URI(WORKSPACE_FILE_URI);
    const existing = (await this.fileService.exists(uri))
      ? (await this.fileService.read(uri)).value
      : undefined;
    const next = updateWorkspaceFile(existing, this.table.configs().map((c) => c.key));
    if (next !== undefined) await this.fileService.write(uri, next);
  }
```
(`URI` from `@theia/core/lib/common/uri`, value import.) The first `apply([])` in `doStart` writes the file with the main key before Theia opens the workspace? No: Theia opens the workspace during startup, possibly before `start()` resolves. Therefore also make `MountsWorkspaceService.getDefaultWorkspaceUri` await a file that exists: inject `MountService` and `await this.mounts.start()` first (it writes the file with at least the main root). Guard the circularity: `MountService` must not inject `WorkspaceService`.

`mounts-frontend-module.ts`: `rebind(WorkspaceService).to(MountsWorkspaceService).inSingletonScope();` and `rebindOrBind(FilesApiWorkspaceRoot).toConstantValue(WORKSPACE_FILE_URI);`.

- [ ] **Step 5: Run the spike e2e** (`pnpm --filter @theia-shell/app build`, then the spec). **Decision point:**
  - Both tests pass and adding a mount through the existing wizard shows a new root without a reload (check by hand with the mounts spec's `mountMemory` flow) → continue.
  - Theia refuses the `shell-system:` workspace (roots empty, errors) → apply the spec's fallback: add a read-write mount at `/.workspace` over the main storage's `/.shell/workspace` (hidden from listings only), use `file:///.workspace/mounts.theia-workspace`, record the ruling, then continue.

- [ ] **Step 6: Update existing e2e expectations** that relied on the single root (`files.spec.ts` root-label test: assert "Browser Storage" is a root and no "Files" header). Run all app e2e; commit:
`theia-shell: the mounts are the workspace's roots`.

---

### Task 2: Remembered folders (`mounted: false`)

**Files:** Modify `M/src/common/mount-config.ts`, `M/src/browser/mount-service.ts`, `M/src/browser/mount-preferences.ts` (schema: `mounted: boolean`); Test `M/tests/mount-config.test.ts`.

**Interfaces — produces:** `validateMountConfigs` accepts `mounted?: boolean` (a non-boolean is an error) and returns every valid entry (mounted and remembered); new `isMounted(c: MountConfig): boolean`; `MountConfig.mounted?: boolean`. `MountService`: `unmount(key)` → sets `mounted: false` (keeps secrets and handle); `remount(key)` (interactive) → clears it; `forget(key)` → old unmount behaviour (delete entry, secrets, `type.forget`); `rememberedMounts(): MountConfig[]`.

- [ ] **Step 1: Failing tests** — add to `mount-config.test.ts`:
```ts
describe("remembered folders", () => {
  it("accepts mounted: false and keeps the key taken", () => {
    const raw = [
      { key: "cloud", name: "Cloud", type: "s3", config: { endpoint: "http://x" }, mounted: false },
      { key: "cloud", name: "Again", type: "s3", config: { endpoint: "http://x" } },
    ];
    const result = validateMountConfigs(raw, types, []);
    expect(result.valid.map((m) => m.key)).toEqual(["cloud"]);
    expect(result.valid[0].mounted).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("refuses a mounted flag that is not a boolean", () => {
    const raw = [{ key: "a", name: "A", type: "s3", config: { endpoint: "http://x" }, mounted: "no" }];
    expect(validateMountConfigs(raw, types, []).errors[0]).toMatch(/mounted/);
  });

  it("isMounted: absent or true is mounted", () => {
    expect(isMounted({ key: "a", name: "A", type: "s3", config: {} })).toBe(true);
    expect(isMounted({ key: "a", name: "A", type: "s3", config: {}, mounted: false })).toBe(false);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement.** In `mount-types.ts` add `mounted?: boolean` to `MountConfig`. In `mount-config.ts` `checkEntry`: `if ("mounted" in entry && typeof (entry as MountConfig).mounted !== "boolean") return \`mount "${key}": "mounted" must be true or false.\`;` and export `export const isMounted = (c: MountConfig) => c.mounted !== false;`. In `MountService.applyPreferences`, pass `valid.filter(isMounted)` to `apply`; `configuredMounts()` still returns all. Rename today's `unmount` body to `forget(key)`; new `unmount(key)` = `setMounted(key, false)`, `remount(key)` = `setMounted(key, true)` then `reconnect(key)` (interactive create); `setMounted` rewrites the entry in `files.mounts` (`mounted` removed when true). Schema: `mounted: { type: "boolean", description: "false: unmounted but remembered" }`.

- [ ] **Step 3:** unit tests green; the existing *Unmount* e2e now expects the folder gone from the explorer (unchanged) — run the mounts spec; commit `theia-shell: removed folders are remembered (mounted: false)`.

---

### Task 3: The folder list — *Add Folder to Workspace…*

**Files:** Create `M/src/common/folder-list.ts`, Test `M/tests/folder-list.test.ts`; Create `M/src/browser/folder-list-quick-pick.ts`; Modify `M/src/browser/mount-commands.ts` (override `workspace:addFolder`, `workspace:removeFolder`; `files.mount` → the list), `M/src/browser/mount-types/opfs-mount-type.ts` (`listDirectories(): Promise<string[]>`).

**Interfaces — produces:**
```ts
export type FolderListItem =
  | { kind: "remembered"; mount: MountConfig; label: string; description: string }
  | { kind: "opfs"; directory: string; label: string; description: string }
  | { kind: "new"; typeId: string; label: string };
export function buildFolderList(
  entries: readonly MountConfig[],
  types: ReadonlyMap<string, MountType>,
  opfsDirectories: readonly string[],
): FolderListItem[];
```
Order: remembered (in `files.mounts` order), then unreferenced OPFS directories (sorted), then one "new" per available type in type order. Labels: remembered/opfs → the name / directory; description → the type label ("S3 Bucket", "Browser Storage (OPFS)"…). New labels: `New ${type.label}…` with `memory` → "New In-Memory Folder…", `local-folder` → "New Folder on this Computer…", `s3` → "New S3 Bucket…", `opfs` → "New Browser-Storage Folder…" (a `newLabel?: string` on `MountType`, falling back to `New ${label}…`).

- [ ] **Step 1: Failing test** `M/tests/folder-list.test.ts`:
```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { buildFolderList } from "../src/common/folder-list";
import type { MountType } from "../src/common/mount-types";

const type = (id: string, label: string, available = true, newLabel?: string): MountType => ({
  id, label, newLabel, fields: [], isAvailable: () => available, create: async () => new MemFilesApi(),
});
const types = new Map([
  ["memory", type("memory", "In Memory", true, "New In-Memory Folder…")],
  ["opfs", type("opfs", "Browser Storage (OPFS)")],
  ["local-folder", type("local-folder", "Folder on this Computer", false)],
]);

describe("buildFolderList", () => {
  it("lists remembered folders, unreferenced browser-storage folders, then new ones", () => {
    const entries = [
      { key: "temp", name: "Temporary", type: "memory", config: {} },
      { key: "drafts", name: "Drafts", type: "opfs", config: { directory: "drafts" }, mounted: false },
      { key: "old", name: "Old", type: "opfs", config: { directory: "old" } },
    ];
    const items = buildFolderList(entries, types, ["old", "archive", "drafts", "zeta"]);
    expect(items.map((i) => [i.kind, i.label])).toEqual([
      ["remembered", "Drafts"],
      ["opfs", "archive"],
      ["opfs", "zeta"],
      ["new", "New In-Memory Folder…"],
      ["new", "New Browser Storage (OPFS)…"],
    ]);
    expect(items[0]).toMatchObject({ description: "Browser Storage (OPFS)" });
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** `folder-list.ts` per the interface (skip mounted entries; OPFS directories referenced by any entry's `config.directory` of type `opfs` are excluded; types with `isAvailable()` false get no "new" item). Add `newLabel?: string` to `MountType`; set it on the built-in types and S3 (`"New S3 Bucket…"`), local folder (`"New Folder on this Computer…"`), OPFS (`"New Browser-Storage Folder…"`) — update the test's expectations accordingly if you set OPFS's `newLabel` in the fake too. `OpfsMountType.listDirectories()`: iterate `navigator.storage.getDirectory()` → `mounts` (create if missing) `.values()` and return directory names.

- [ ] **Step 3: The quick pick** `folder-list-quick-pick.ts`: builds items from `buildFolderList(mounts.configuredMounts(), mounts.types(), await opfs.listDirectories())`, separators "Remembered", "In browser storage", "New"; remembered rows carry a `buttons: [{ iconClass: "codicon codicon-trash", tooltip: "Forget" }]` — use `QuickInputService.createQuickPick()` to handle `onDidTriggerItemButton` (confirm with `ConfirmDialog`, then `mounts.forget(key)` and refresh the items). Accept:
  - remembered → `mounts.remount(key)`;
  - opfs → open the form (Task 4) for type `opfs` prefilled with `name = directory`, `config.directory = directory`;
  - new → the form flow for that type (Task 4).

- [ ] **Step 4: Commands.** In `MountCommandContribution.registerCommands`: `commands.unregisterCommand(WorkspaceCommands.ADD_FOLDER.id)` then register it with `execute: () => this.folderList()`; same for `WorkspaceCommands.REMOVE_FOLDER.id` with `UriAwareCommandHandler.MultiSelect(this.selection, { execute: (uris) => …unmount each non-main mount root, refuse main with messages.warn…, isVisible: (uris) => uris.every((u) => !!this.mounts.mountAt(u)) })`. `files.mount` → `this.folderList()`. Keep the explorer's *Unmount* (same action as Remove Folder). Theia's own menu entries for these ids now run ours.

- [ ] **Step 5:** unit green; commit `theia-shell: Add Folder to Workspace lists remembered and new folders`.

---

### Task 4: One form per mount; local folder picked first

**Files:** Create `M/src/common/mount-form.ts`, Test `M/tests/mount-form.test.ts`; Create `M/src/browser/mount-form-dialog.ts`; Modify `M/src/common/mount-types.ts` (`configure` returns `{ config; name? }`), `M/src/browser/mount-types/local-folder-mount-type.ts`, `M/src/browser/mount-commands.ts` (new/edit flows use the form).

**Interfaces — produces:**
```ts
export interface MountFormValues { name: string; key: string; keyEdited: boolean; fields: Record<string, string> }
export interface MountFormErrors { name?: string; key?: string; fields: Record<string, string> }
export function validateMountForm(
  type: MountType, values: MountFormValues,
  options: { taken: readonly string[]; editing: boolean },
): { errors: MountFormErrors; valid: boolean; key: string };
```
`key` returned = `values.keyEdited ? values.key.trim() : suggestKey(values.name.trim(), taken)`.

- [ ] **Step 1: Failing test** `M/tests/mount-form.test.ts`:
```ts
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { validateMountForm } from "../src/common/mount-form";
import type { MountType } from "../src/common/mount-types";

const s3: MountType = {
  id: "s3", label: "S3 Bucket", isAvailable: () => true, create: async () => new MemFilesApi(),
  fields: [
    { name: "endpoint", label: "Endpoint URL", kind: "url", required: true },
    { name: "bucket", label: "Bucket", kind: "text", required: true },
    { name: "secretAccessKey", label: "Secret access key", kind: "secret", required: true },
  ],
};
const filled = { endpoint: "http://h:9000", bucket: "b", secretAccessKey: "s" };

describe("validateMountForm", () => {
  it("derives the key from the name until it is edited", () => {
    const r = validateMountForm(s3, { name: " My Cloud ", key: "", keyEdited: false, fields: filled }, { taken: ["my-cloud"], editing: false });
    expect(r.key).toBe("my-cloud-2");
    expect(r.valid).toBe(true);
  });

  it("trims an edited key and checks it exactly", () => {
    const r = validateMountForm(s3, { name: "X", key: " Cloud ", keyEdited: true, fields: filled }, { taken: ["cloud"], editing: false });
    expect(r.key).toBe("Cloud");
    expect(r.valid).toBe(true);
    const clash = validateMountForm(s3, { name: "X", key: "cloud", keyEdited: true, fields: filled }, { taken: ["cloud"], editing: false });
    expect(clash.errors.key).toMatch(/already used/);
  });

  it("requires the name and required fields, and checks URLs", () => {
    const r = validateMountForm(s3, { name: "", key: "", keyEdited: false, fields: { endpoint: "localhost:9000" } }, { taken: [], editing: false });
    expect(r.valid).toBe(false);
    expect(r.errors.name).toBeDefined();
    expect(r.errors.fields.endpoint).toMatch(/http/);
    expect(r.errors.fields.bucket).toBeDefined();
    expect(r.errors.fields.secretAccessKey).toBeDefined();
  });

  it("lets a secret stay empty when editing (keep the current value)", () => {
    const r = validateMountForm(s3, { name: "C", key: "c", keyEdited: true, fields: { endpoint: "http://h", bucket: "b" } }, { taken: [], editing: true });
    expect(r.valid).toBe(true);
  });
});
```
Run → FAIL.

- [ ] **Step 2: Implement** `mount-form.ts` using `suggestKey`/`validateKey` (name required after trim; required non-secret fields non-empty after trim; `url` fields must match `/^https?:\/\/[^/]/i`; required secrets non-empty unless `editing`). Run → green.

- [ ] **Step 3: `MountFormDialog`** (`AbstractDialog<MountFormResult>`, `MountFormResult = { name; key; config; secrets }`): inputs `.mount-form-name`, `.mount-form-key` (typing in it sets `keyEdited`), one input per field `.mount-form-field[data-field="<name>"]` (password for secrets, placeholder "Leave empty to keep" when editing), a per-field error line; `isValid` returns `validateMountForm(...)` → a message listing the first error, `{ message: "", result: false }` in preview when only empty; the key input shows the derived key while not edited; accept button "Mount" (new) / "Save" (edit); optional "Choose another folder…" button when the type has `configure` and the dialog is editing, which re-runs `configure` and updates name/key if not edited.

- [ ] **Step 4: Local folder first.** `LocalFolderMountType.configure()` returns `{ config: { directory: handle.name, handleId }, name: handle.name }`. The "new" flow: if the type has `configure`, run it first (cancel → stop), then open the form with `name` prefilled from its suggestion and `config` merged; else open the form directly. The edit flow (explorer *Edit Mount…*) opens the form prefilled (name, key with `keyEdited: true`, non-secret fields), type fixed. On accept → `mounts.saveMount({ key, name, type, config }, secrets, previousKey)` (vault unlock first when the type has secret fields, as today). Remove the quick-input chain from `mount-commands.ts`.

- [ ] **Step 5:** unit green; build; commit `theia-shell: one form per mount; a local folder is picked before the form`.

---

### Task 5: End to end

**Files:** Modify `app/tests/mounts.spec.ts`, `app/tests/s3.spec.ts`, `app/tests/helpers.ts` (a `mountViaForm(page, typeLabel, values)` helper); add cases to `app/tests/roots.spec.ts`.

- [ ] **Step 1: Rewrite the flows** that used the quick-input chain (`mountMemory`, S3 `mountS3`, OPFS, local folder, Edit) to: *File → Mount File System…* (or palette *Workspace: Add Folder to Workspace…*) → pick the "New …" row → fill `.mount-form-*` → click **Mount**. Duplicate-key and malformed-endpoint tests assert the dialog's error and a disabled **Mount** button.
- [ ] **Step 2: New cases** (`roots.spec.ts`):
  - mounting a memory folder adds a root live; *Remove Folder from Workspace* (explorer context menu on the root) removes it; *Add Folder to Workspace…* lists it under "Remembered"; clicking it brings it back as a root;
  - *Forget* removes it from the list;
  - removing the main storage is refused with a message;
  - local folder: with `showDirectoryPicker` stubbed (as today) to return an OPFS directory named `photos`, the form opens after the pick with name "photos" and path `photos`;
  - an OPFS directory created under `mounts/archive` (page.evaluate) is offered as "archive (Browser Storage)" and mounts in one click;
  - a workspace-scope setting: *Preferences: Open Workspace Settings (JSON)*, save `{"editor.fontSize": 17}`, reload + unlock → still set (read it back from the workspace file with `settingsText`-like helper on `workspace.theia-workspace`);
  - after removing all non-main folders and reloading, only "Browser Storage" is a root and the list offers the removed ones.
- [ ] **Step 3:** run the whole app e2e red first against the Task-4 build where they are new, then green; commit `theia-shell: e2e for roots, remembered folders and the mount form`.

---

### Task 6: Docs and the full check

- [ ] `M/README.md` (roots, the workspace file, remembered folders, the list, the form, commands), `app/README.md` (how to mount: File → Mount File System… / Add Folder to Workspace…; the list; the form; counts; red/green), root `README.md` if the layout changed, `PLAN.md` status counts, and remove the *Known gap* about workspace-scope settings.
- [ ] Full check: `pnpm build && pnpm test && pnpm test:e2e` (P7 is red on `main` already — see the note in the final report), biome clean; commit `theia-shell: document mounts as workspace roots`.
