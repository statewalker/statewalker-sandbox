import { expect, type Page, test } from "@playwright/test";
import { explorer, openFile, start } from "./helpers";

async function open(page: Page, folder: string, file: string) {
  const node = explorer(page).getByText(file, { exact: true });
  if (!(await node.isVisible())) await explorer(page).getByText(folder, { exact: true }).click();
  await node.dblclick();
}

const tab = (page: Page, label: string) => page.locator(".lm-TabBar-tab", { hasText: label });
const selectedInExplorer = (page: Page) => explorer(page).locator(".theia-mod-selected");
const openEditors = (page: Page) => page.locator("#theia-open-editors-widget");

async function showOpenEditors(page: Page) {
  const header = page.locator(".theia-view-container-part-header", { hasText: /open editors/i });
  if ((await openEditors(page).isVisible()) === false) await header.click();
  await expect(openEditors(page)).toBeVisible();
}

test.describe("viewers are navigatable", () => {
  test("open images and PDFs are listed in Open Editors, and activate from there", async ({
    page,
  }) => {
    const errors = await start(page);
    await openFile(page, "welcome.md");
    await open(page, "media", "gradient.png");
    await expect(page.locator(".image-viewer-status")).toContainText("320 × 200");
    await open(page, "docs", "sample.pdf");
    await expect(page.locator(".pdf-viewer-widget")).toBeVisible();

    await showOpenEditors(page);
    const entries = openEditors(page).locator(".theia-TreeNode");
    for (const name of ["welcome.md", "gradient.png", "sample.pdf"]) {
      await expect(entries.filter({ hasText: name })).toHaveCount(1);
    }

    await entries.filter({ hasText: "gradient.png" }).click();
    await expect(tab(page, "gradient.png")).toHaveClass(/lm-mod-current/);
    await expect(page.locator(".image-viewer-widget")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the explorer follows the active viewer", async ({ page }) => {
    const errors = await start(page);
    await openFile(page, "welcome.md");
    await open(page, "media", "gradient.png");
    await open(page, "docs", "sample.pdf");
    await expect(page.locator(".pdf-viewer-widget")).toBeVisible();

    await tab(page, "welcome.md").click();
    await expect(selectedInExplorer(page)).toHaveText("welcome.md");
    await tab(page, "gradient.png").click();
    await expect(selectedInExplorer(page)).toHaveText("gradient.png");
    await tab(page, "sample.pdf").click();
    await expect(selectedInExplorer(page)).toHaveText("sample.pdf");
    expect(errors).toEqual([]);
  });

  test("renaming an open image moves its viewer to the new name", async ({ page }) => {
    const errors = await start(page);
    await open(page, "media", "gradient.png");
    await expect(page.locator(".image-viewer-status")).toContainText("320 × 200");

    await explorer(page).getByText("gradient.png", { exact: true }).click();
    await page.keyboard.press("F2");
    const input = page.locator(".dialogBlock input");
    await expect(input).toBeFocused();
    await input.fill("renamed.png");
    await page.keyboard.press("Enter");

    await expect(tab(page, "renamed.png")).toBeVisible();
    await expect(tab(page, "gradient.png")).toHaveCount(0);
    await expect(page.locator(".image-viewer-status")).toContainText("320 × 200");
    expect(errors).toEqual([]);
  });
});

test.describe("search", () => {
  test("Find in Files lists the matching text files and opens one at the match", async ({
    page,
  }) => {
    const errors = await start(page);
    const input = page.locator("#search-input-field");
    // Keybindings go live a little after the explorer renders; retry.
    await expect(async () => {
      await page.keyboard.press("Control+Shift+F");
      await expect(input).toBeFocused({ timeout: 1000 });
    }).toPass();
    const results = page.locator("#search-in-workspace .result-head .file-name");

    await input.fill("FilesApi");
    await page.keyboard.press("Enter");
    await expect(results.filter({ hasText: "welcome.md" })).toHaveCount(1);

    // Every PNG holds the bytes "IHDR", but binary files are not text-searched.
    await input.fill("IHDR");
    await page.keyboard.press("Enter");
    await expect(page.locator("#search-in-workspace")).toContainText("No results found");
    await expect(results).toHaveCount(0);

    await input.fill("Components installed");
    await page.keyboard.press("Enter");
    await expect(results).toHaveText(["ideas.md"]);
    await page.locator("#search-in-workspace .resultLine").first().click();
    await expect(tab(page, "ideas.md")).toBeVisible();
    // The match is selected, so the cursor sits at its end: "- " + 20 characters.
    await expect(page.locator("#theia-statusBar")).toContainText("Ln 4, Col 23");
    expect(errors).toEqual([]);
  });

  test("Quick Open finds a file by name and opens it in its viewer", async ({ page }) => {
    const errors = await start(page);
    const input = page.locator(".quick-input-widget .quick-input-box input");
    await expect(async () => {
      await page.keyboard.press("Control+P");
      await expect(input).toBeFocused({ timeout: 1000 });
    }).toPass();
    await input.pressSequentially("gradient");
    await expect(
      page.locator(".quick-input-list .monaco-list-row", { hasText: "gradient.png" }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator(".image-viewer-status")).toContainText("320 × 200");
    expect(errors).toEqual([]);
  });
});
