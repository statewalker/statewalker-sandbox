import { expect, test } from "@playwright/test";
import { explorer, openFile, readFile, start } from "./helpers";

test("the explorer shows the seeded FilesApi under its root label", async ({ page }) => {
  const errors = await start(page);
  // The single root is shown as the explorer section's header, not as a tree node.
  await expect(
    page.locator("#explorer-view-container--files").getByText("Files", { exact: true }),
  ).toBeVisible();
  await expect(explorer(page).getByText("notes", { exact: true })).toBeVisible();
  await explorer(page).getByText("notes", { exact: true }).click();
  await expect(explorer(page).getByText("ideas.md", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a file opens in the editor and saves back to the FilesApi", async ({ page }) => {
  const errors = await start(page);
  const editor = await openFile(page, "welcome.md");
  await expect(editor.locator(".view-lines")).toContainText("Welcome");

  await editor.locator(".view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nSaved from Theia.");
  expect(await readFile(page, "/welcome.md")).not.toContain("Saved from Theia.");
  await page.keyboard.press("Control+S");
  await expect.poll(() => readFile(page, "/welcome.md")).toContain("Saved from Theia.");
  expect(errors).toEqual([]);
});

test("the default OPFS storage keeps saved edits across a reload", async ({ page }) => {
  const errors = await start(page);
  const editor = await openFile(page, "welcome.md");
  await editor.locator(".view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nStill here after reload.");
  await page.keyboard.press("Control+S");
  await expect.poll(() => readFile(page, "/welcome.md")).toContain("Still here after reload.");

  await page.reload();
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
  expect(await readFile(page, "/welcome.md")).toContain("Still here after reload.");
  expect(errors).toEqual([]);
});

test("?storage=memory starts from the seed every time", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  const editor = await openFile(page, "welcome.md");
  await editor.locator(".view-lines").click();
  await page.keyboard.type("Gone after reload. ");
  await page.keyboard.press("Control+S");
  await expect.poll(() => readFile(page, "/welcome.md")).toContain("Gone after reload.");
  await page.reload();
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
  expect(await readFile(page, "/welcome.md")).not.toContain("Gone after reload.");
  expect(errors).toEqual([]);
});
