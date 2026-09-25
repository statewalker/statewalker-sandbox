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

export async function start(page: Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  await page.goto(`/${query}`);
  await expect(explorer(page).getByText("welcome.md", { exact: true })).toBeVisible();
  return errors;
}
