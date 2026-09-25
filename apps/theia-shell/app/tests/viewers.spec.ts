import { expect, type Page, test } from "@playwright/test";
import { explorer, runFromPalette, start } from "./helpers";

async function open(page: Page, folder: string, file: string) {
  await explorer(page).getByText(folder, { exact: true }).click();
  await explorer(page).getByText(file, { exact: true }).dblclick();
}

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
});
