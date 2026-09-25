import { expect, test } from "@playwright/test";
import { explorer, openMain, runFromPalette, start, unlockVault, waitForSettings } from "./helpers";

test("the first OPFS run creates the vault; the next asks for the password", async ({ page }) => {
  await start(page, "", { password: "first-password" });
  await page.reload();
  const dialog = page.locator(".vault-dialog");
  await expect(dialog.locator(".vault-password-confirm")).toHaveCount(0);
  await dialog.locator(".vault-password").fill("wrong");
  await dialog.locator(".theia-button.main").click();
  // The dialog stays open, the error shown in it, until the vault is really unlocked.
  await expect(dialog.locator(".dialogControl .error")).toContainText("Wrong password");
  await dialog.locator(".vault-password").fill("first-password");
  await dialog.locator(".theia-button.main").click();
  await expect(dialog).toHaveCount(0);
  await openMain(page);
});

test("Remember on this device skips the prompt next time", async ({ page }) => {
  await page.goto("/");
  await unlockVault(page, "pw", true);
  await openMain(page);
  await page.reload();
  await openMain(page);
  await expect(page.locator(".vault-dialog")).toHaveCount(0);
});

test("an empty password is refused when creating the vault", async ({ page }) => {
  await page.goto("/");
  const dialog = page.locator(".vault-dialog");
  // The button is disabled while the password is empty; Enter says why.
  await expect(dialog.locator(".theia-button.main")).toBeDisabled();
  await dialog.locator(".vault-password").press("Enter");
  await expect(dialog.locator(".dialogControl .error")).toContainText("Enter a password");
});

test("settings.json lives in the main storage's .shell, not in the file tree", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await runFromPalette(page, "Preferences: Open Settings (JSON)");
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText('{ "files.hidden": ["**/*.tmp"] }');
  await page.keyboard.press("Control+s");
  // Theia writes settings.json shortly after the change: poll the file in OPFS.
  await waitForSettings(page, "**/*.tmp");
});

test("a local-folder main needs a click after a reload; the fallback opens browser storage", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("home", { create: true });
  });
  await start(page, "", { password: "pw" });
  await runFromPalette(page, "Files: Choose Main Storage…");
  await page
    .locator(".quick-input-list .monaco-list-row", { hasText: "A Folder on this Computer" })
    .click();
  await page
    .locator(".quick-input-list .monaco-list-row", { hasText: "Copy my current settings" })
    .click();
  await page.waitForEvent("load");
  // OPFS handles report "granted", so no gate: the app opens straight on the folder "home",
  // with the copied settings and vault (same password) and the demo files seeded into it.
  await expect(page.locator(".boot-gate")).toHaveCount(0);
  await unlockVault(page, "pw");
  await expect(explorer(page).getByText("home", { exact: true })).toBeVisible();
  await expect(explorer(page).getByText("Browser Storage", { exact: true })).toHaveCount(0);
});

test("the boot gate: a denied click stays, the fallback resolves", async ({ page }) => {
  await page.goto("/?storage=memory");
  const result = await page.evaluate(async () => {
    const { bootGate } = (
      window as unknown as {
        theiaShell: {
          bootGate: typeof import("@theia-shell/theia-files-mounts/lib/browser/boot-gate").bootGate;
        };
      }
    ).theiaShell;
    const pending = bootGate(
      "Home",
      async () => false,
      async () => true,
    );
    (document.querySelector(".boot-gate-open") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 50));
    const text = document.querySelector(".boot-gate p")?.textContent;
    (document.querySelector(".boot-gate-fallback") as HTMLButtonElement).click();
    return { text, choice: await pending };
  });
  expect(result.text).toContain("not granted");
  expect(result.choice).toBe("fallback");
});
