import { expect, test } from "@playwright/test";
import { explorer, openFile, readFile, runFromPalette, start } from "./helpers";

test.describe("markdown extension", () => {
  test("File > New Markdown File creates, opens and saves a file", async ({ page }) => {
    const errors = await start(page);
    await page.locator("#theia-top-panel").getByText("File", { exact: true }).click();
    await page.locator(".lm-Menu-item", { hasText: "New Markdown File" }).click();

    await expect(page.locator(".lm-TabBar-tab", { hasText: "untitled.md" })).toBeVisible();
    await expect(explorer(page).getByText("untitled.md", { exact: true })).toBeVisible();
    await expect.poll(() => readFile(page, "/untitled.md")).toBe("# Untitled\n\n");
    expect(errors).toEqual([]);
  });

  test("the preview renders the active editor and follows it live", async ({ page }) => {
    const errors = await start(page);
    const editor = await openFile(page, "welcome.md");
    await runFromPalette(page, "Markdown: Open Preview to the Side");

    const preview = page.locator(".markdown-preview");
    await expect(preview.locator("h1")).toHaveText("Welcome");

    await editor.locator(".view-lines").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n\n## Typed live");
    // Unsaved edits show up: the preview reads the editor model, not the file.
    await expect(preview.locator("h2", { hasText: "Typed live" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the preview opens from the explorer context menu", async ({ page }) => {
    const errors = await start(page);
    await explorer(page).getByText("notes", { exact: true }).click();
    await explorer(page).getByText("ideas.md", { exact: true }).click({ button: "right" });
    await page.locator(".lm-Menu-item", { hasText: "Open Markdown Preview" }).click();
    await expect(page.locator(".markdown-preview h1")).toHaveText("Ideas");
    expect(errors).toEqual([]);
  });

  test("the outline lists the headings and reveals the one clicked", async ({ page }) => {
    const errors = await start(page);
    await openFile(page, "welcome.md");
    await runFromPalette(page, "Markdown: Show Outline");

    const outline = page.locator(".markdown-outline");
    await expect(outline.locator(".markdown-outline-item")).toHaveText([
      "Welcome",
      "Getting started",
      "Files",
      "Markdown",
    ]);
    await outline.locator(".markdown-outline-item", { hasText: "Markdown" }).click();
    // The editor's cursor moves to that heading's line.
    await expect(page.locator("#theia-statusBar")).toContainText("Ln 13,");
    expect(errors).toEqual([]);
  });

  test("Toggle Bold from the editor context menu wraps the selection", async ({ page }) => {
    const errors = await start(page);
    const editor = await openFile(page, "notes", "ideas.md");
    await editor.getByText("Plain line").click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await editor.getByText("Plain line").click({ button: "right" });
    await page.locator(".lm-Menu-item", { hasText: "Markdown" }).hover();
    await page.locator(".lm-Menu-item", { hasText: "Toggle Bold" }).click();

    await page.keyboard.press("Control+S");
    await expect.poll(() => readFile(page, "/notes/ideas.md")).toContain("**Plain line**");
    expect(errors).toEqual([]);
  });

  test("Toggle Heading has a keybinding", async ({ page }) => {
    const errors = await start(page);
    const editor = await openFile(page, "notes", "ideas.md");
    await editor.getByText("Another line").click();
    await page.keyboard.press("Control+Alt+H");
    await page.keyboard.press("Control+S");
    await expect.poll(() => readFile(page, "/notes/ideas.md")).toContain("# Another line");
    expect(errors).toEqual([]);
  });
});
