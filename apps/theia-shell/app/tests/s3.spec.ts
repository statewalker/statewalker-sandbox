import { GetObjectCommand } from "@aws-sdk/client-s3";
import { expect, type Page, test } from "@playwright/test";
// @ts-expect-error — plain JS module
import { hasDocker, startRustFs } from "../../tools/rustfs.mjs";
import {
  explorer,
  openMain,
  readFile,
  runFromPalette,
  start,
  unlockVault,
  waitForSettings,
} from "./helpers";

test.skip(!hasDocker(), "Docker is not available: the S3 tests need RustFS");

let s3: Awaited<ReturnType<typeof startRustFs>>;
test.beforeAll(async () => {
  s3 = await startRustFs({ port: 19101, origin: "http://127.0.0.1:3100" });
});
test.afterAll(() => s3?.stop());

async function mountS3(
  page: Page,
  endpoint: string,
  keys = { id: s3.accessKeyId, secret: s3.secretAccessKey },
) {
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "S3 Bucket" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  for (const value of [
    "Cloud",
    "cloud",
    endpoint,
    "us-east-1",
    s3.bucket,
    "",
    keys.id,
    keys.secret,
  ]) {
    await input.fill(value);
    await page.keyboard.press("Enter");
  }
}

test("an S3 bucket mounts, stores files, and keeps its keys out of settings", async ({ page }) => {
  const errors = await start(page, "", { password: "pw" });
  await mountS3(page, s3.endpoint);
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const files = (
      window as unknown as {
        theiaShell: { filesApi: { write(p: string, c: Uint8Array[]): Promise<void> } };
      }
    ).theiaShell.filesApi;
    await files.write("/cloud/hello.md", [new TextEncoder().encode("# from the browser")]);
  });
  const object = await s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: "hello.md" }));
  expect(await object.Body?.transformToString()).toBe("# from the browser");

  // Read the files only once the mount is written, so "no key in them" means something.
  await waitForSettings(page, '"cloud"');
  const raw = await page.evaluate(async () => {
    const main = await (await navigator.storage.getDirectory()).getDirectoryHandle("main");
    const shell = await main.getDirectoryHandle(".shell");
    const read = async (dir: FileSystemDirectoryHandle, name: string) =>
      (await (await dir.getFileHandle(name)).getFile()).text();
    return (
      (await read(await shell.getDirectoryHandle("settings"), "settings.json")) +
      (await read(shell, "secrets.json"))
    );
  });
  expect(raw).not.toContain(s3.secretAccessKey);
  expect(raw).not.toContain(s3.accessKeyId);
  expect(raw).toContain('"cloud"');

  await page.reload();
  await unlockVault(page, "pw");
  await openMain(page);
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
  expect(await readFile(page, "/cloud/hello.md")).toBe("# from the browser");
  expect(errors).toEqual([]);
});

test("with the vault skipped, S3 shows as locked, and Unlock mounts it", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await mountS3(page, s3.endpoint);
  await waitForSettings(page, '"cloud"');
  await page.reload();
  await page.locator(".vault-dialog .theia-button.secondary").click(); // Skip
  await openMain(page);
  await expect(explorer(page).getByText("Cloud (locked)", { exact: true })).toBeVisible();
  await runFromPalette(page, "Secrets: Unlock");
  await unlockVault(page, "pw");
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
});

test("an unreachable endpoint shows as unavailable; other mounts work", async ({ page }) => {
  await start(page, "", { password: "pw" });
  await mountS3(page, "http://127.0.0.1:1");
  await expect(explorer(page).getByText(/^Cloud \(unavailable: /)).toBeVisible();
  await expect(explorer(page).getByText("Temporary", { exact: true })).toBeVisible();
});

test("a malformed endpoint is refused in the wizard", async ({ page }) => {
  await start(page, "?storage=memory");
  await runFromPalette(page, "Files: Mount File System…");
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "S3 Bucket" }).click();
  const input = page.locator(".quick-input-widget .quick-input-box input");
  for (const value of ["Cloud", "cloud"]) {
    await input.fill(value);
    await page.keyboard.press("Enter");
  }
  await input.fill("localhost:9000");
  await expect(page.locator(".quick-input-message")).toContainText("http://");
});
