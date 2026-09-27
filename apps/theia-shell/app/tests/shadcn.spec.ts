import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  explorer,
  openFile,
  openMain,
  runFromPalette,
  start,
  unlockVault,
  waitForSettings,
} from "./helpers";

/** The computed colour a shadcn token resolves to on <body>, in the form getComputedStyle reports. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}

const style = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

async function openExplorerMenu(page: Page, file: string) {
  await explorer(page).getByText(file, { exact: true }).click({ button: "right" });
  const menu = page.locator(".lm-Menu").last();
  await expect(menu).toBeVisible();
  return menu;
}

async function selectTheme(page: Page, label: string) {
  await runFromPalette(page, "Color Theme");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: label }).first().click();
}

const TOGGLE = "Toggle shadcn/ui Style";

/** Starts the app and switches the shadcn/ui style on, as a user would: from the palette. */
async function startShadcn(page: Page) {
  const errors = await start(page);
  await runFromPalette(page, TOGGLE);
  await expect(page.locator("body")).toHaveClass(/\bshadcn-ui\b/);
  return errors;
}

test.describe("default style: stock Theia", () => {
  test("menus and dialogs keep Theia's own shape and colours", async ({ page }) => {
    const errors = await start(page);
    await expect(page.locator("body")).not.toHaveClass(/\bshadcn-ui\b/);
    const menu = await openExplorerMenu(page, "welcome.md");
    expect(await style(menu, "border-top-left-radius")).toBe("5px");
    expect(await style(menu, "background-color")).toBe(
      await token(page, "--theia-menu-background"),
    );
    await page.locator(".lm-Menu-itemLabel", { hasText: /^Delete$/ }).click();

    const block = page.locator(".dialogBlock");
    await expect(block).toBeVisible();
    expect(await style(block, "border-top-left-radius")).toBe("4px");
    expect(await style(block.locator(".dialogTitle"), "background-color")).toBe(
      await token(page, "--theia-statusBar-background"),
    );
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("the shadcn components take the Theia theme's colours", async ({ page }) => {
    const errors = await start(page);
    await openFile(page, "welcome.md");
    await runFromPalette(page, "Markdown: Show Outline");
    const first = page.locator(".markdown-outline .markdown-outline-item").first();
    await expect(first).toBeVisible();
    await first.hover();
    await expect
      .poll(() => style(first, "background-color"))
      .toBe(await token(page, "--theia-list-hoverBackground"));

    await runFromPalette(page, "Markdown: Open Preview to the Side");
    const h1 = page.locator(".markdown-preview h1");
    await expect(h1).toHaveText("Welcome");
    expect(await style(h1, "color")).toBe(await token(page, "--theia-editor-foreground"));
    expect(await style(page.locator(".markdown-preview-widget"), "background-color")).toBe(
      await token(page, "--theia-editor-background"),
    );
    expect(errors).toEqual([]);
  });

  test("the style toggles live, whatever the colour theme, and survives a reload", async ({
    page,
  }) => {
    const errors = await start(page);
    await selectTheme(page, "Dark");
    await expect(page.locator("body")).toHaveClass(/theia-dark/);
    const radius = async () => {
      const r = await style(await openExplorerMenu(page, "welcome.md"), "border-top-left-radius");
      await page.keyboard.press("Escape");
      return r;
    };
    expect(await radius()).toBe("5px");

    await runFromPalette(page, TOGGLE);
    await expect(page.locator("body")).toHaveClass(/\bshadcn-ui\b/);
    expect(await radius()).toBe("8px");

    // Theia writes settings.json just after the change: wait before reloading.
    await waitForSettings(page, '"appearance.style"');
    await waitForSettings(page, '"workbench.colorTheme"');
    await page.reload();
    await unlockVault(page, "test-password");
    await openMain(page);
    await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/\bshadcn-ui\b/);
    await expect(page.locator("body")).toHaveClass(/theia-dark/);

    await runFromPalette(page, TOGGLE);
    await expect(page.locator("body")).not.toHaveClass(/\bshadcn-ui\b/);
    expect(await radius()).toBe("5px");
    expect(errors).toEqual([]);
  });
});

test.describe("shadcn/ui style", () => {
  test("native menus take shadcn's DropdownMenu shape and colours", async ({ page }) => {
    const errors = await startShadcn(page);
    const menu = await openExplorerMenu(page, "welcome.md");

    expect(await style(menu, "border-top-left-radius")).toBe("8px");
    expect(await style(menu, "padding-top")).toBe("4px");
    expect(await style(menu, "background-color")).toBe(await token(page, "--popover"));
    expect(await style(menu, "border-top-color")).toBe(await token(page, "--border"));

    const item = menu.locator(".lm-Menu-item", { hasText: "Open With" });
    await item.hover();
    await expect(item).toHaveClass(/lm-mod-active/);
    // Items are table rows, which cannot be rounded: the end cells carry the radius.
    const first = item.locator("> div").first();
    const last = item.locator("> div").last();
    expect(await style(first, "border-top-left-radius")).toBe("6px");
    expect(await style(last, "border-top-right-radius")).toBe("6px");
    expect(await style(first, "background-color")).toBe(await token(page, "--accent"));
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("confirm dialogs take shadcn's DialogContent and Button shape", async ({ page }) => {
    const errors = await startShadcn(page);
    await openExplorerMenu(page, "welcome.md");
    await page.locator(".lm-Menu-itemLabel", { hasText: /^Delete$/ }).click();

    const block = page.locator(".dialogBlock");
    await expect(block).toBeVisible();
    expect(await style(block, "border-top-left-radius")).toBe("10px");
    expect(await style(block, "padding-top")).toBe("24px");
    expect(await style(block, "background-color")).toBe(await token(page, "--background"));

    const main = block.locator(".theia-button.main");
    expect(await style(main, "height")).toBe("36px");
    expect(await style(main, "background-color")).toBe(await token(page, "--primary"));
    expect(await style(main, "color")).toBe(await token(page, "--primary-foreground"));
    const secondary = block.locator(".theia-button.secondary");
    expect(await style(secondary, "border-top-color")).toBe(await token(page, "--border"));

    // Escape still closes a dialog, and nothing was deleted.
    await page.keyboard.press("Escape");
    await expect(block).toHaveCount(0);
    await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("the tokens follow the theme type", async ({ page }) => {
    const errors = await startShadcn(page);
    await selectTheme(page, "Dark");
    await expect(page.locator("body")).toHaveClass(/theia-dark/);
    const dark = await style(await openExplorerMenu(page, "welcome.md"), "background-color");
    expect(dark).toBe("oklch(0.205 0 0)");
    await page.keyboard.press("Escape");

    await selectTheme(page, "Light");
    await expect(page.locator("body")).toHaveClass(/theia-light/);
    const light = await style(await openExplorerMenu(page, "welcome.md"), "background-color");
    expect(light).toBe("oklch(1 0 0)");
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("Tailwind brings no preflight: Theia's own element styles are untouched", async ({
    page,
  }) => {
    await start(page);
    const sizes = await page.evaluate(() => {
      const h1 = document.createElement("h1");
      h1.textContent = "probe";
      document.body.appendChild(h1);
      const result = {
        h1: getComputedStyle(h1).fontSize,
        body: getComputedStyle(document.body).fontSize,
      };
      h1.remove();
      return result;
    });
    // Preflight would reset headings to `font-size: inherit`.
    expect(sizes.h1).not.toBe(sizes.body);
  });

  test("the outline lists headings as shadcn ghost buttons", async ({ page }) => {
    const errors = await startShadcn(page);
    await openFile(page, "welcome.md");
    await runFromPalette(page, "Markdown: Show Outline");

    const items = page.locator(".markdown-outline .markdown-outline-item");
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    await expect(page.locator('.markdown-outline [data-slot="button"]')).toHaveCount(count);

    const first = items.first();
    await first.hover();
    await expect.poll(() => style(first, "background-color")).toBe(await token(page, "--accent"));
    expect(errors).toEqual([]);
  });

  test("the preview is typeset with Tailwind Typography", async ({ page }) => {
    const errors = await startShadcn(page);
    await openFile(page, "welcome.md");
    await runFromPalette(page, "Markdown: Open Preview to the Side");

    const preview = page.locator(".markdown-preview");
    await expect(preview.locator("h1")).toHaveText("Welcome");
    await expect(preview).toHaveClass(/\bprose\b/);
    expect(await style(preview.locator("h1"), "font-weight")).toBe("800");
    expect(await style(preview.locator("h1"), "color")).toBe(await token(page, "--foreground"));
    expect(errors).toEqual([]);
  });

  test("the image viewer's status line uses the muted token", async ({ page }) => {
    const errors = await startShadcn(page);
    await explorer(page).getByText("media", { exact: true }).click();
    await explorer(page).getByText("gradient.png", { exact: true }).dblclick();

    const status = page.locator(".image-viewer-status");
    await expect(status).toContainText("320 × 200");
    expect(await style(status, "color")).toBe(await token(page, "--muted-foreground"));
    expect(await style(status, "border-top-color")).toBe(await token(page, "--border"));
    expect(errors).toEqual([]);
  });
});
