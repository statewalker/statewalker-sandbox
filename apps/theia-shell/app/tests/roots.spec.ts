import { expect, test } from "@playwright/test";
import {
  explorer,
  folderRow,
  mountNew,
  openFolderList,
  runFromPalette,
  start,
  unlockVault,
  waitForSettings,
} from "./helpers";

test("the mounts are the workspace's top-level folders, with no Files wrapper", async ({
  page,
}) => {
  const errors = await start(page, "?storage=memory");
  await expect(explorer(page).getByText("Browser Storage", { exact: true })).toBeVisible();
  await expect(explorer(page).getByText("Temporary", { exact: true })).toBeVisible();
  // Multi-root: the section header is the workspace, not the "Files" root label.
  await expect(
    page.locator("#explorer-view-container--files").getByText("Files", { exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the workspace survives a reload with default storage", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await page.reload();
  await unlockVault(page, "pw");
  await expect(explorer(page).getByText("Browser Storage", { exact: true })).toBeVisible();
  await expect(
    page.locator("#explorer-view-container--files").getByText("Files", { exact: true }),
  ).toHaveCount(0);
});

const root = (page: import("@playwright/test").Page, name: string) =>
  explorer(page).getByText(name, { exact: true });

async function removeFolder(page: import("@playwright/test").Page, name: string) {
  await root(page, name).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Remove Folder from Workspace" }).click();
}

test("Remove Folder unmounts and remembers; Add Folder brings it back; Forget deletes it", async ({
  page,
}) => {
  const errors = await start(page, "?storage=memory");
  await mountNew(page, "New In-Memory Folder…", { name: "Scratch" });
  await expect(root(page, "Scratch")).toBeVisible();

  await removeFolder(page, "Scratch");
  await expect(root(page, "Scratch")).toHaveCount(0);

  await runFromPalette(page, "Add Folder to Workspace");
  const row = folderRow(page, "Scratch");
  await expect(row).toBeVisible();
  await row.click();
  await expect(root(page, "Scratch")).toBeVisible();

  await removeFolder(page, "Scratch");
  await openFolderList(page);
  await folderRow(page, "Scratch").hover();
  await folderRow(page, "Scratch").locator(".codicon-trash").click();
  await page.locator(".dialogBlock .theia-button.main").click();
  await openFolderList(page);
  await expect(folderRow(page, "New In-Memory Folder…")).toBeVisible();
  await expect(
    page.locator(".quick-input-list .monaco-list-row", { hasText: "Scratch" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the main storage cannot be removed from the workspace", async ({ page }) => {
  await start(page, "?storage=memory");
  await removeFolder(page, "Browser Storage");
  await expect(
    page.locator(".theia-notification-message").filter({ hasText: "main storage" }).first(),
  ).toBeVisible();
  await expect(root(page, "Browser Storage")).toBeVisible();
});

test("a browser-storage folder no mount uses is offered and mounts in one click", async ({
  page,
}) => {
  await start(page, "", { password: "pw" });
  await page.evaluate(async () => {
    const mounts = await (await navigator.storage.getDirectory()).getDirectoryHandle("mounts", {
      create: true,
    });
    await mounts.getDirectoryHandle("archive", { create: true });
  });
  await openFolderList(page);
  await folderRow(page, "archive").click();
  await expect(root(page, "archive")).toBeVisible();
});

test("a workspace setting is saved in the mounts workspace and survives a reload", async ({
  page,
}) => {
  await start(page, "", { password: "pw" });
  await runFromPalette(page, "Preferences: Open Workspace Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('{ "editor.fontSize": 17 }');
  await page.keyboard.press("Control+s");
  const workspaceFile = async () =>
    page.evaluate(async () => {
      const main = await (await navigator.storage.getDirectory()).getDirectoryHandle("main");
      const dir = await (await main.getDirectoryHandle(".shell")).getDirectoryHandle("workspace");
      return (await (await dir.getFileHandle("mounts.theia-workspace")).getFile()).text();
    });
  await expect.poll(workspaceFile).toContain('"editor.fontSize": 17');
  await page.reload();
  await unlockVault(page, "pw");
  await expect(root(page, "Browser Storage")).toBeVisible();
  expect(await workspaceFile()).toContain('"editor.fontSize": 17');
  expect(JSON.parse(await workspaceFile()).folders.length).toBeGreaterThan(0);
});

test("after removing every other folder and reloading, only the main storage is a root", async ({
  page,
}) => {
  await start(page, "", { password: "pw" });
  await removeFolder(page, "Temporary");
  await expect(root(page, "Temporary")).toHaveCount(0);
  await waitForSettings(page, '"mounted": false');
  await page.reload();
  await unlockVault(page, "pw");
  await expect(root(page, "Browser Storage")).toBeVisible();
  await expect(root(page, "Temporary")).toHaveCount(0);
  await openFolderList(page);
  await expect(folderRow(page, "Temporary")).toBeVisible();
});
