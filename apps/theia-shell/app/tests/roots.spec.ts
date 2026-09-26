import { expect, test } from "@playwright/test";
import { explorer, start, unlockVault } from "./helpers";

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
