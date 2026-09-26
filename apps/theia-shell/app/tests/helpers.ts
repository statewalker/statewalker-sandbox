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
  // The row with this exact label: fuzzy ranking may put a similar command first
  // (e.g. "Open Workspace Settings (JSON)" in a multi-root workspace).
  const row = page
    .locator(".quick-input-list .monaco-list-row")
    .filter({ has: page.locator(".monaco-icon-label", { hasText: label }) })
    .first();
  await expect(row).toBeVisible();
  await row.click();
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

/** The main storage's settings.json, read straight from OPFS (default storage only). */
export async function settingsText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const main = await (await navigator.storage.getDirectory()).getDirectoryHandle("main");
    const settings = await (await main.getDirectoryHandle(".shell")).getDirectoryHandle("settings");
    return (await (await settings.getFileHandle("settings.json")).getFile()).text();
  });
}

/**
 * Theia fires a preference change before it writes settings.json; a reload in
 * between loses the change. Wait for the file before reloading.
 */
export async function waitForSettings(page: Page, text: string) {
  await expect.poll(() => settingsText(page).catch(() => "")).toContain(text);
}

/** *File → Mount File System…* / *Add Folder to Workspace…*: the folder list. */
export async function openFolderList(page: Page) {
  await runFromPalette(page, "Files: Mount File System…");
  await expect(page.locator(".quick-input-widget .quick-input-list")).toBeVisible();
}

export const folderRow = (page: Page, text: string) =>
  page.locator(".quick-input-list .monaco-list-row", { hasText: text }).first();

/** Fills the mount form; `fields` by field name. */
export async function fillMountForm(
  page: Page,
  values: { name?: string; key?: string; fields?: Record<string, string> },
) {
  const dialog = page.locator(".mount-form-dialog");
  await expect(dialog).toBeVisible();
  if (values.name !== undefined) await dialog.locator(".mount-form-name").fill(values.name);
  if (values.key !== undefined) await dialog.locator(".mount-form-key").fill(values.key);
  for (const [field, value] of Object.entries(values.fields ?? {})) {
    await dialog.locator(`.mount-form-field[data-field="${field}"]`).fill(value);
  }
}

export async function submitMountForm(page: Page) {
  const dialog = page.locator(".mount-form-dialog");
  await dialog.locator(".theia-button.main").click();
  await expect(dialog).toHaveCount(0);
}

/** A new mount of the list's "New …" row `row`, through the form. */
export async function mountNew(
  page: Page,
  row: string,
  values: { name?: string; key?: string; fields?: Record<string, string> },
) {
  await openFolderList(page);
  await folderRow(page, row).click();
  await fillMountForm(page, values);
  await submitMountForm(page);
}
