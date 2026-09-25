import { expect, test } from "@playwright/test";

// P3: the navigator shows the content of the FilesApi the app provides, and the
// workspace root is that FilesApi's root, opened without any backend.
test("the explorer lists the FilesApi tree", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));

  await page.goto("/");
  const explorer = page.locator("#files");
  await expect(explorer).toBeVisible();
  await expect(explorer.getByText("README.md", { exact: true })).toBeVisible();
  await expect(explorer.getByText("docs", { exact: true })).toBeVisible();

  await explorer.getByText("docs", { exact: true }).click();
  await expect(explorer.getByText("guide.md", { exact: true })).toBeVisible();

  expect(errors).toEqual([]);
});
