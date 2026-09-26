import { expect, type Locator, type Page, test } from "@playwright/test";
import { runFromPalette, start } from "./helpers";

export const panels = (page: Page) => page.locator(".file-panel");
export const row = (panel: Locator, name: string) =>
  panel.locator(".theia-TreeNode").filter({ has: panel.page().getByText(name, { exact: true }) });

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
