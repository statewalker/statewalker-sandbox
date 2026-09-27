import { expect, test } from "@playwright/test";

// P1: a browser-only Theia app renders its shell from a static server, with no
// DI failures and without ever trying to reach a backend.
test("the Theia shell renders with no backend", async ({ page }) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror ${e.message.split("\n")[0]}`));
  page.on("websocket", (ws) => problems.push(`websocket ${ws.url()}`));
  page.on("requestfailed", (req) => problems.push(`failed ${req.url()}`));

  await page.goto("/");
  await expect(page.locator("#theia-app-shell")).toBeVisible();
  await expect(page.locator(".theia-preload")).toHaveCount(0);
  // The main menu is contributed, so the top panel shows.
  await expect(page.locator("#theia-top-panel")).toBeVisible();
  await expect(page.locator("#theia-top-panel").getByText("File", { exact: true })).toBeVisible();

  // The command palette works (QuickInputService is bound).
  await page.keyboard.press("F1");
  await expect(page.locator(".quick-input-widget")).toBeVisible();

  expect(problems).toEqual([]);
});
