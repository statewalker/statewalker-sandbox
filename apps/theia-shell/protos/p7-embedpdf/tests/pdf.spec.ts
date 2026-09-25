import { expect, test } from "@playwright/test";

// P7: EmbedPDF, bundled by Theia's esbuild, renders a PDF read from the FilesApi
// — with PDFium's wasm served by the app itself and no request leaving it.
test("a PDF from the FilesApi renders in EmbedPDF, offline", async ({ page, baseURL }) => {
  const errors: string[] = [];
  const foreign: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  page.context().on("request", (r) => {
    const url = r.url();
    if (!url.startsWith(baseURL as string) && !/^(blob|data):/.test(url)) foreign.push(url);
  });

  await page.goto("/");
  await page.locator("#files").getByText("hello.pdf", { exact: true }).dblclick();

  const viewer = page.locator(".pdf-viewer-widget");
  await expect(viewer).toBeVisible();
  await expect(page.locator(".lm-TabBar-tab", { hasText: "hello.pdf" })).toBeVisible();
  // A rendered page: EmbedPDF draws each page (or tile) as an <img> with a blob: URL.
  await expect(viewer.locator("img[src^='blob:']").first()).toBeVisible({ timeout: 30_000 });

  expect(foreign).toEqual([]);
  expect(errors).toEqual([]);
});
