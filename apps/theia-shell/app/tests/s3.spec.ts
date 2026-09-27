import { GetObjectCommand } from "@aws-sdk/client-s3";
import { expect, type Page, test } from "@playwright/test";
// @ts-expect-error — plain JS module
import { hasDocker, startRustFs } from "../../tools/rustfs.mjs";
import {
  explorer,
  fillMountForm,
  folderRow,
  mountNew,
  openFolderList,
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
  // The bucket's CORS must allow the app's own origin, which follows E2E_PORT.
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  s3 = await startRustFs({ port: 19101, origin });
});
test.afterAll(() => s3?.stop());

async function mountS3(
  page: Page,
  endpoint: string,
  keys = { id: s3.accessKeyId, secret: s3.secretAccessKey },
) {
  // One form: the mount's name and path, and everything needed to reach the bucket.
  await mountNew(page, "New S3 Bucket…", {
    name: "Cloud",
    fields: {
      endpoint,
      region: "us-east-1",
      bucket: s3.bucket,
      prefix: "",
      accessKeyId: keys.id,
      secretAccessKey: keys.secret,
    },
  });
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

test("within an S3 mount, move and copy a file (CopyObject CORS preflight)", async ({ page }) => {
  const errors = await start(page, "", { password: "pw" });
  await mountS3(page, s3.endpoint);
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();

  await page.evaluate(async () => {
    const files = (
      window as unknown as {
        theiaShell: {
          filesApi: {
            write(p: string, c: Uint8Array[]): Promise<void>;
            mkdir(p: string): Promise<void>;
            move(from: string, to: string): Promise<boolean>;
            copy(from: string, to: string): Promise<boolean>;
          };
        };
      }
    ).theiaShell.filesApi;
    await files.mkdir("/cloud/sub");
    await files.write("/cloud/move-me.md", [new TextEncoder().encode("move")]);
    await files.write("/cloud/copy-me.md", [new TextEncoder().encode("copy")]);
    await files.move("/cloud/move-me.md", "/cloud/sub/move-me.md");
    await files.copy("/cloud/copy-me.md", "/cloud/sub/copy-me.md");
  });

  // Moved: present at the destination, gone from the source.
  const moved = await s3.client.send(
    new GetObjectCommand({ Bucket: s3.bucket, Key: "sub/move-me.md" }),
  );
  expect(await moved.Body?.transformToString()).toBe("move");
  await expect(
    s3.client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: "move-me.md" })),
  ).rejects.toThrow();

  // Copied: present at both the source and the destination.
  const copiedSource = await s3.client.send(
    new GetObjectCommand({ Bucket: s3.bucket, Key: "copy-me.md" }),
  );
  expect(await copiedSource.Body?.transformToString()).toBe("copy");
  const copiedTarget = await s3.client.send(
    new GetObjectCommand({ Bucket: s3.bucket, Key: "sub/copy-me.md" }),
  );
  expect(await copiedTarget.Body?.transformToString()).toBe("copy");

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

test("a malformed endpoint is refused in the form", async ({ page }) => {
  await start(page, "?storage=memory");
  await openFolderList(page);
  await folderRow(page, "New S3 Bucket…").click();
  await fillMountForm(page, {
    name: "Cloud",
    fields: { endpoint: "localhost:9000", bucket: "b", accessKeyId: "a", secretAccessKey: "s" },
  });
  const dialog = page.locator(".mount-form-dialog");
  await expect(dialog.locator(".mount-form-error").filter({ hasText: "http://" })).toBeVisible();
  await expect(dialog.locator(".theia-button.main")).toBeDisabled();
});
