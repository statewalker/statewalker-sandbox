import { expect, type Page, test } from "@playwright/test";

// P6: a static VS Code web extension runs in the browser-only plugin host.

const toast = (page: Page, text: string) =>
  page.locator(".theia-notification-toasts .theia-notification-message").filter({ hasText: text });

async function runFromPalette(page: Page, label: string) {
  const input = page.locator(".quick-input-widget .quick-input-box input");
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

test("the plugin's command runs in the web plugin host", async ({ page }) => {
  await runFromPalette(page, "P6: Hello from a VS Code extension");
  await expect(toast(page, "Hello from a VS Code web extension")).toBeVisible();
});

test("the plugin reads the FilesApi through vscode.workspace.fs", async ({ page }) => {
  await runFromPalette(page, "P6: Show README Title");
  await expect(toast(page, "README title: # P3")).toBeVisible();
});

test("a plugin deployed at runtime is picked up without a reload", async ({ page }) => {
  // Not there at start-up.
  const input = page.locator(".quick-input-widget .quick-input-box input");
  await expect(async () => {
    await page.keyboard.press("F1");
    await expect(input).toBeFocused({ timeout: 1000 });
  }).toPass();
  await input.pressSequentially("P6: Deployed at Runtime");
  await expect(page.locator(".quick-input-list .monaco-list-row")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Deploy: metadata arrives at runtime; the files are already reachable by URL.
  await page.evaluate(async () => {
    const plugins = await (await fetch("late-plugins.json")).json();
    const deploy = (window as unknown as { p6Deploy(p: unknown): Promise<void> }).p6Deploy;
    for (const plugin of plugins) await deploy(plugin);
  });

  await runFromPalette(page, "P6: Deployed at Runtime");
  await expect(toast(page, "Hello from a plugin deployed at runtime")).toBeVisible();
});
