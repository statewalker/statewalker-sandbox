import { expect, type Page, test } from "@playwright/test";

// P5: a Theia extension contributes a command, a keybinding, a main-menu item,
// an explorer context-menu item and a view — all working browser-only.

// Toasts only: the (closed) notification center renders a second copy.
const notification = (page: Page, text: string) =>
  page.locator(".theia-notification-toasts .theia-notification-message").filter({ hasText: text });

async function runFromPalette(page: Page, label: string) {
  const input = page.locator(".quick-input-widget .quick-input-box input");
  // Keybindings are registered once the app is ready, a little after the
  // explorer renders; retry until F1 opens the palette.
  await expect(async () => {
    await page.keyboard.press("F1");
    await expect(input).toBeFocused({ timeout: 1000 });
  }).toPass();
  await input.pressSequentially(label);
  await expect(
    page.locator(".quick-input-list .monaco-list-row.focused", { hasText: label }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#files").getByText("README.md", { exact: true })).toBeVisible();
});

test("command from the palette", async ({ page }) => {
  await runFromPalette(page, "P5: Say Hello");
  await expect(notification(page, "Hello from P5")).toBeVisible();
});

test("command from its keybinding", async ({ page }) => {
  await page.locator("#files").click();
  await page.keyboard.press("Control+Alt+H");
  await expect(notification(page, "Hello from P5")).toBeVisible();
});

test("command from the main menu", async ({ page }) => {
  await page.locator("#theia-top-panel").getByText("Help", { exact: true }).click();
  await page.locator(".lm-Menu-item", { hasText: "P5: Say Hello" }).click();
  await expect(notification(page, "Hello from P5")).toBeVisible();
});

test("command from the explorer context menu gets the file", async ({ page }) => {
  await page.locator("#files").getByText("README.md", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "P5: Show Path" }).click();
  await expect(notification(page, "P5 path: /README.md")).toBeVisible();
});

test("a contributed view opens and renders", async ({ page }) => {
  await runFromPalette(page, "View: Toggle P5 Hello");
  const view = page.locator("#p5-hello-view");
  await expect(view).toBeVisible();
  await expect(view).toContainText("Hello view from P5");
  // Its tab sits in the left side bar next to the explorer.
  await expect(page.locator("#shell-tab-p5-hello-view")).toBeVisible();
});
