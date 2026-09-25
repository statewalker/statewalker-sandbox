import { expect, test } from "@playwright/test";
import {
  explorer,
  openMain,
  readFile,
  runFromPalette,
  start,
  unlockVault,
  waitForSettings,
} from "./helpers";

async function mountMemory(page: import("@playwright/test").Page, name: string, key?: string) {
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "In Memory" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill(name);
  await page.keyboard.press("Enter");
  if (key !== undefined) await input.fill(key);
  await page.keyboard.press("Enter");
}

test("the main storage and the default Temporary mount show by name", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  await expect(explorer(page).getByText("Temporary", { exact: true })).toBeVisible();
  await expect(explorer(page).getByText(".shell", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the wizard mounts a memory file system with a key from its name", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  await mountMemory(page, "Scratch Pad");
  await expect(explorer(page).getByText("Scratch Pad", { exact: true })).toBeVisible();
  const mounts = await page.evaluate(async () => {
    const files = (
      window as unknown as {
        theiaShell: { filesApi: { list(p: string): AsyncIterable<{ name: string }> } };
      }
    ).theiaShell.filesApi;
    const names: string[] = [];
    for await (const e of files.list("/")) names.push(e.name);
    return names;
  });
  expect(mounts).toContain("scratch-pad");
  expect(errors).toEqual([]);
});

test("a name in another script gets the key 'mount' and keeps its name", async ({ page }) => {
  await start(page, "?storage=memory");
  await mountMemory(page, "Мой диск");
  await expect(explorer(page).getByText("Мой диск", { exact: true })).toBeVisible();
});

test("a duplicate key is refused", async ({ page }) => {
  await start(page, "?storage=memory");
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "In Memory" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Anything");
  await page.keyboard.press("Enter");
  await input.fill("temp");
  await expect(page.locator(".quick-input-message")).toContainText("already used");
});

test("Edit renames, Unmount removes", async ({ page }) => {
  await start(page, "?storage=memory");
  await mountMemory(page, "Scratch Pad");
  const folder = explorer(page).getByText("Scratch Pad", { exact: true });
  await folder.click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Edit Mount…" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Renamed");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(explorer(page).getByText("Renamed", { exact: true })).toBeVisible();
  await explorer(page).getByText("Renamed", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Unmount" }).click();
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(explorer(page).getByText("Renamed", { exact: true })).toHaveCount(0);
});

test("files.hidden hides a path everywhere, live", async ({ page }) => {
  await start(page, "?storage=memory");
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('{ "files.hidden": ["**/welcome.md"] }');
  await page.keyboard.press("Control+s");
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toHaveCount(0);
  expect(await readFile(page, "/browser/welcome.md")).toBeUndefined();
});

test("a malformed files.mounts entry is skipped with a warning; the others mount", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(
    '{ "files.mounts": [ { "name": "No key", "type": "memory", "config": {} }, { "key": "ok", "name": "Fine", "type": "memory", "config": {} } ] }',
  );
  await page.keyboard.press("Control+s");
  await expect(explorer(page).getByText("Fine", { exact: true })).toBeVisible();
  await expect(
    page.locator(".theia-notification-message").filter({ hasText: "missing key" }).first(),
  ).toBeVisible();
});

test("an OPFS mount and its files survive a reload", async ({ page }) => {
  await start(page, "", { password: "test-password" });
  await runFromPalette(page, "Files: Mount File System…");
  await page
    .locator(".quick-input-list .monaco-list-row", { hasText: "Browser Storage (OPFS)" })
    .click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Drafts");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter"); // key: drafts
  await page.keyboard.press("Enter"); // directory: drafts
  await expect(explorer(page).getByText("Drafts", { exact: true })).toBeVisible();
  await waitForSettings(page, '"drafts"');
  await page.evaluate(async () => {
    const files = (
      window as unknown as {
        theiaShell: { filesApi: { write(p: string, c: Uint8Array[]): Promise<void> } };
      }
    ).theiaShell.filesApi;
    await files.write("/drafts/idea.md", [new TextEncoder().encode("# idea")]);
  });
  await page.reload();
  await unlockVault(page, "test-password");
  await openMain(page);
  await expect(explorer(page).getByText("Drafts", { exact: true })).toBeVisible();
  expect(await readFile(page, "/drafts/idea.md")).toBe("# idea");
});

test("a local folder mounts through the picker and reconnects after a reload", async ({ page }) => {
  // Playwright cannot drive the native picker: hand out an OPFS directory instead.
  await page.addInitScript(() => {
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("picked", { create: true });
  });
  await start(page, "", { password: "test-password" });
  await runFromPalette(page, "Files: Mount File System…");
  await page
    .locator(".quick-input-list .monaco-list-row", { hasText: "Folder on this Computer" })
    .click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await input.fill("Local Computer");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(explorer(page).getByText("Local Computer", { exact: true })).toBeVisible();
  await waitForSettings(page, '"local-computer"');
  await page.reload();
  await unlockVault(page, "test-password");
  await openMain(page);
  await expect(explorer(page).getByText(/^Local Computer/)).toBeVisible();
});

async function writeSettings(page: import("@playwright/test").Page, json: string) {
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(json);
  await page.keyboard.press("Control+s");
}

test("a glob that does not compile is reported; the others apply and mounts keep working", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  await writeSettings(page, '{ "files.hidden": ["[abc", "**/welcome.md"] }');
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toHaveCount(0);
  await expect(
    page.locator(".theia-notification-message").filter({ hasText: "[abc" }).first(),
  ).toBeVisible();
  await writeSettings(
    page,
    '{ "files.hidden": ["[abc"], "files.mounts": [ { "key": "later", "name": "Later", "type": "memory", "config": {} } ] }',
  );
  await expect(explorer(page).getByText("Later", { exact: true })).toBeVisible();
});

test("a files.mounts that is not an array is reported, not replaced by the defaults", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  await writeSettings(page, '{ "files.mounts": { "key": "x" } }');
  await expect(
    page.locator(".theia-notification-message").filter({ hasText: "must be an array" }).first(),
  ).toBeVisible();
  await expect(explorer(page).getByText("Temporary", { exact: true })).toHaveCount(0);
});

test("the File menu offers Mount File System… and Choose Main Storage…", async ({ page }) => {
  await start(page, "?storage=memory");
  await page.locator("#theia-top-panel").getByText("File", { exact: true }).click();
  await expect(page.locator(".lm-Menu-item", { hasText: "Choose Main Storage…" })).toBeVisible();
  await page.locator(".lm-Menu-item", { hasText: "Mount File System…" }).click();
  await expect(
    page.locator(".quick-input-list .monaco-list-row", { hasText: "In Memory" }),
  ).toBeVisible();
});
