import { expect, type Page, test } from "@playwright/test";
import { explorer, runFromPalette, start } from "./helpers";

async function open(page: Page, folder: string, file: string) {
  await explorer(page).getByText(folder, { exact: true }).click();
  await explorer(page).getByText(file, { exact: true }).dblclick();
}

/** Opens an (already revealed) file in the text editor, replaces the first `find` and saves. */
async function editAsText(page: Page, file: string, find: string, replace: string) {
  await explorer(page).getByText(file, { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Open With" }).click();
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "Text Editor" }).click();
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await expect(editor).toContainText(find);
  await editor.click();
  // Find selects the first match; closing the find widget keeps the selection.
  await page.keyboard.press("Control+f");
  await page.keyboard.type(find);
  await page.keyboard.press("Escape");
  await page.keyboard.insertText(replace);
  await expect(editor).toContainText(replace);
  await page.keyboard.press("Control+s");
}

async function deleteFromExplorer(page: Page, file: string) {
  await explorer(page).getByText(file, { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: /^Delete$/ }).click();
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(explorer(page).getByText(file, { exact: true })).toHaveCount(0);
}

const tab = (page: Page, label: string) => page.locator(".lm-TabBar-tab", { hasText: label });

test.describe("image viewer", () => {
  test("an image opens in the viewer, not in the text editor", async ({ page }) => {
    const errors = await start(page);
    await open(page, "media", "gradient.png");

    const viewer = page.locator(".image-viewer-widget");
    await expect(viewer.locator(".image-viewer-status")).toContainText("320 × 200");
    const width = await viewer.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth);
    expect(width).toBe(320);
    await expect(page.locator(".theia-editor .monaco-editor")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("zoom from the tab toolbar, the keyboard and the command palette", async ({ page }) => {
    const errors = await start(page);
    await open(page, "media", "gradient.png");
    const status = page.locator(".image-viewer-status");
    // Small images are never enlarged to fit.
    await expect(status).toContainText("100% (fit)");

    await page.locator('[id="imageViewer.zoomIn"]').click();
    await expect(status).toContainText("150%");

    await page.locator(".image-viewer-canvas").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("-");
    await expect(status).toContainText("· 100% ·");
    await page.keyboard.press("-");
    await expect(status).toContainText("75%");
    await page.keyboard.press("0");
    await expect(status).toContainText("(fit)");

    await runFromPalette(page, "Image: Zoom In");
    await expect(status).toContainText("150%");
    expect(errors).toEqual([]);
  });

  test("an SVG is shown as an image", async ({ page }) => {
    const errors = await start(page);
    await open(page, "media", "logo.svg");
    await expect(page.locator(".image-viewer-status")).toContainText("240 × 120");
    expect(errors).toEqual([]);
  });

  test("the viewer reloads when the image is saved from the text editor", async ({ page }) => {
    const errors = await start(page, "?storage=memory");
    await open(page, "media", "logo.svg");
    const status = page.locator(".image-viewer-status");
    await expect(status).toContainText("240 × 120");

    await editAsText(page, "logo.svg", "240", "480");
    await tab(page, "logo.svg").first().click();
    await expect(status).toContainText("480 × 120");
    expect(errors).toEqual([]);
  });

  test("deleting an open image closes its viewer, as it does an editor, without errors", async ({
    page,
  }) => {
    const errors = await start(page, "?storage=memory");
    await open(page, "media", "gradient.png");
    await expect(page.locator(".image-viewer-status")).toContainText("320 × 200");

    await deleteFromExplorer(page, "gradient.png");
    await expect(tab(page, "gradient.png")).toHaveCount(0);
    await expect(page.locator(".image-viewer-widget")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("PDF viewer", () => {
  test("a PDF opens in EmbedPDF, with no request leaving the app", async ({ page, baseURL }) => {
    const foreign: string[] = [];
    page.context().on("request", (r) => {
      const url = r.url();
      if (!url.startsWith(baseURL as string) && !/^(blob|data):/.test(url)) foreign.push(url);
    });
    const errors = await start(page);
    await open(page, "docs", "sample.pdf");

    const viewer = page.locator(".pdf-viewer-widget");
    await expect(page.locator(".lm-TabBar-tab", { hasText: "sample.pdf" })).toBeVisible();
    await expect(viewer.locator("img[src^='blob:']").first()).toBeVisible({ timeout: 30_000 });
    expect(foreign).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("the viewer reloads when the PDF is saved from the text editor", async ({ page }) => {
    const errors = await start(page, "?storage=memory");
    await open(page, "docs", "sample.pdf");
    const pageImage = page.locator(".pdf-viewer-widget img[src^='blob:']").first();
    await expect(pageImage).toBeVisible({ timeout: 30_000 });
    const before = await pageImage.getAttribute("src");

    // The sample PDF is plain ASCII; a same-length edit keeps its xref offsets valid.
    await editAsText(page, "sample.pdf", "A sample PDF", "An edit PDF!");
    await tab(page, "sample.pdf").first().click();
    await expect(pageImage).toBeVisible({ timeout: 30_000 });
    await expect(pageImage).not.toHaveAttribute("src", before as string);
    expect(errors).toEqual([]);
  });

  test("deleting an open PDF closes its viewer, as it does an editor, without errors", async ({
    page,
  }) => {
    const errors = await start(page, "?storage=memory");
    await open(page, "docs", "sample.pdf");
    const viewer = page.locator(".pdf-viewer-widget");
    await expect(viewer.locator("img[src^='blob:']").first()).toBeVisible({ timeout: 30_000 });

    await deleteFromExplorer(page, "sample.pdf");
    await expect(tab(page, "sample.pdf")).toHaveCount(0);
    await expect(viewer).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
