import { expect, type Locator, type Page, test } from "@playwright/test";
import { explorer, runFromPalette, start } from "./helpers";

export const panels = (page: Page) => page.locator(".file-panel");
export const row = (panel: Locator, name: string) =>
  panel.locator(".theia-TreeNode").filter({ has: panel.page().getByText(name, { exact: true }) });
const crumb = (panel: Locator, label: string) =>
  panel.locator(".file-panel-crumb", { hasText: label });

export async function openPanel(page: Page) {
  const before = await panels(page).count();
  await runFromPalette(page, "Open Files Panel");
  await expect(panels(page)).toHaveCount(before + 1);
  return panels(page).last();
}

test("a panel lists a folder flat, navigates into folders and back up", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await expect(row(panel, "Browser Storage")).toBeVisible();
  await row(panel, "Browser Storage").dblclick();
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(row(panel, "notes")).toBeVisible();
  await row(panel, "notes").dblclick();
  await expect(row(panel, "ideas.md")).toBeVisible();
  await expect(row(panel, "welcome.md")).toHaveCount(0);
  // Backspace goes up (tree-local key, not a keybinding).
  await row(panel, "ideas.md").click();
  await page.keyboard.press("Backspace");
  await expect(row(panel, "welcome.md")).toBeVisible();
  // Folders never expand in place.
  await expect(panel.locator(".theia-ExpansionToggle")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the panel shows size and date columns and sorts by clicking a header", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "docs").dblclick();
  await expect(row(panel, "sample.pdf").locator(".file-panel-size")).not.toHaveText("");
  const order = () => panel.locator(".theia-TreeNode .theia-TreeNodeSegmentGrow").allTextContents();
  await expect.poll(order).toEqual(["cheatsheet.md", "sample.pdf"]);
  await panel.locator(".file-panel-column", { hasText: "Name" }).click();
  await expect.poll(order).toEqual(["sample.pdf", "cheatsheet.md"]);
});

test("a file opens from the panel", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "welcome.md").dblclick();
  await expect(page.locator(".theia-editor .monaco-editor").last()).toBeVisible();
});

test("an empty folder says so", async ({ page }) => {
  await start(page, "?storage=memory");
  await page.evaluate(async () => {
    const files = (
      window as unknown as { theiaShell: { filesApi: { mkdir(p: string): Promise<void> } } }
    ).theiaShell.filesApi;
    await files.mkdir("/browser/empty");
  });
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "empty").dblclick();
  await expect(panel.getByText("This folder is empty")).toBeVisible();
});

test("the breadcrumb navigates to an ancestor", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await expect(crumb(panel, "notes")).toBeVisible();
  await crumb(panel, "Browser Storage").locator(".file-panel-crumb-label").click();
  await expect(row(panel, "welcome.md")).toBeVisible();
});

test("a crumb's dropdown lists its sibling folders and jumps to one", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await crumb(panel, "notes").locator(".file-panel-crumb-toggle").click();
  const list = page.locator(".file-panel-siblings");
  await expect(list.locator(".file-panel-sibling")).toHaveText(["docs", "media", "notes"]);
  await expect(list.locator(".file-panel-sibling.current")).toHaveText("notes");
  await list.locator(".file-panel-sibling", { hasText: "docs" }).click();
  await expect(row(panel, "cheatsheet.md")).toBeVisible();
  await expect(list).toHaveCount(0);
});

test("the first crumb's dropdown lists the workspace roots", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await panel.locator(".file-panel-crumb").first().locator(".file-panel-crumb-toggle").click();
  await expect(page.locator(".file-panel-siblings .file-panel-sibling")).toHaveText(["Files"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-panel-siblings")).toHaveCount(0);
});

async function contextMenu(panel: Locator, name: string, item: string) {
  await row(panel, name).click({ button: "right" });
  await panel.page().locator(".lm-Menu-item", { hasText: item }).first().click();
}

test("rename and delete from the panel's context menu reach the explorer", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await contextMenu(panel, "ideas.md", "Rename");
  const input = page.locator(".dialogContent input");
  await input.fill("plans.md");
  await page.keyboard.press("Enter");
  await expect(row(panel, "plans.md")).toBeVisible();
  await explorer(page).getByText("notes", { exact: true }).click();
  await expect(explorer(page).getByText("plans.md", { exact: true })).toBeVisible();

  await contextMenu(panel, "plans.md", "Delete");
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(row(panel, "plans.md")).toHaveCount(0);
  await expect(explorer(page).getByText("plans.md", { exact: true })).toHaveCount(0);
});

test("the panel's Open opens a file; the explorer's Open in Files Panel opens a folder", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await contextMenu(panel, "welcome.md", "Open");
  await expect(page.locator(".theia-editor .monaco-editor").last()).toBeVisible();

  await explorer(page).getByText("docs", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Open in Files Panel" }).click();
  await expect(row(panels(page).last(), "cheatsheet.md")).toBeVisible();
});
