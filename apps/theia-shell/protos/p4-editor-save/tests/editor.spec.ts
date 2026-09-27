import { expect, type Page, test } from "@playwright/test";

type Files = { read(path: string): AsyncIterable<Uint8Array> };

async function readFromFilesApi(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => {
    const files = (window as unknown as { filesApi: Files }).filesApi;
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of files.read(p)) text += decoder.decode(chunk, { stream: true });
    return text;
  }, path);
}

// P4: Monaco works browser-only, shows the FilesApi content, and Save writes
// back through the provider into the FilesApi.
test("open, edit and save a file through the FilesApi", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));

  await page.goto("/");
  await page.locator("#files").getByText("README.md", { exact: true }).dblclick();

  const editor = page.locator(".monaco-editor").first();
  await expect(editor).toBeVisible();
  await expect(editor.locator(".view-lines")).toContainText("Served from a FilesApi.");

  await editor.locator(".view-lines").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Edited in Theia.");
  // The tab shows the dirty marker before saving.
  await expect(page.locator(".lm-TabBar-tab.theia-mod-dirty")).toHaveCount(1);
  // Nothing reaches the FilesApi until Save.
  expect(await readFromFilesApi(page, "/README.md")).not.toContain("Edited in Theia.");

  await page.keyboard.press("Control+S");
  await expect(page.locator(".lm-TabBar-tab.theia-mod-dirty")).toHaveCount(0);
  await expect.poll(() => readFromFilesApi(page, "/README.md")).toContain("Edited in Theia.");
  expect(await readFromFilesApi(page, "/README.md")).toContain("# P3");

  expect(errors).toEqual([]);
});
