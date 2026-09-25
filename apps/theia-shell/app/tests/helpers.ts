import { expect, type Page } from "@playwright/test";

type Files = {
  read(path: string): AsyncIterable<Uint8Array>;
  exists(path: string): Promise<boolean>;
};

/** Reads a file straight from the app's FilesApi (exposed as `theiaShell.filesApi`). */
export async function readFile(page: Page, path: string): Promise<string | undefined> {
  return page.evaluate(async (p) => {
    const files = (window as unknown as { theiaShell: { filesApi: Files } }).theiaShell.filesApi;
    if (!(await files.exists(p))) return undefined;
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of files.read(p)) text += decoder.decode(chunk, { stream: true });
    return text;
  }, path);
}

export const explorer = (page: Page) => page.locator("#files");

export const toast = (page: Page, text: string) =>
  page.locator(".theia-notification-toasts .theia-notification-message").filter({ hasText: text });

export async function runFromPalette(page: Page, label: string) {
  const input = page.locator(".quick-input-widget .quick-input-box input");
  // Keybindings go live a little after the explorer renders; retry F1.
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

export async function openFile(page: Page, ...segments: string[]) {
  for (const folder of segments.slice(0, -1)) {
    await explorer(page).getByText(folder, { exact: true }).click();
  }
  await explorer(page)
    .getByText(segments.at(-1) as string, { exact: true })
    .dblclick();
  const editor = page.locator(".theia-editor .monaco-editor").last();
  await expect(editor).toBeVisible();
  return editor;
}

export const MAIN = "Browser Storage";

/**
 * Opens the app and the main storage. With OPFS (no `storage=memory`) the
 * first visit asks for a new vault password; it is answered with `password`.
 */
export async function start(
  page: Page,
  query = "",
  { password = "test-password" }: { password?: string } = {},
) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  await page.goto(`/${query}`);
  if (!query.includes("storage=memory")) await unlockVault(page, password);
  await openMain(page);
  return errors;
}

export async function openMain(page: Page) {
  const main = explorer(page).getByText(MAIN, { exact: true });
  await expect(main).toBeVisible();
  const welcome = explorer(page).getByText("welcome.md", { exact: true });
  if (!(await welcome.isVisible())) await main.click();
  await expect(welcome).toBeVisible();
}

/** Creates or unlocks the vault through its dialog. */
export async function unlockVault(page: Page, password: string, remember = false) {
  const dialog = page.locator(".vault-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".vault-password").fill(password);
  const confirm = dialog.locator(".vault-password-confirm");
  if (await confirm.count()) await confirm.fill(password);
  if (remember) await dialog.locator(".vault-remember").check();
  await dialog.locator(".theia-button.main").click();
  await expect(dialog).toHaveCount(0);
}
