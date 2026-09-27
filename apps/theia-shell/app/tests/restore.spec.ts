import { expect, type Page, test } from "@playwright/test";
// @ts-expect-error — plain JS module
import { hasDocker, startRustFs } from "../../tools/rustfs.mjs";
import { explorer, mountNew, runFromPalette, start, unlockVault } from "./helpers";

test.skip(!hasDocker(), "Docker is not available: the S3 tests need RustFS");
test.setTimeout(180_000);

let s3: Awaited<ReturnType<typeof startRustFs>>;
test.beforeAll(async () => {
  // The bucket's CORS must allow the app's own origin, which follows E2E_PORT.
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  s3 = await startRustFs({ port: 19110, origin, bucket: "restore" });
});
test.afterAll(() => s3?.stop());

const tab = (page: Page, label: string) => page.locator(".lm-TabBar-tab", { hasText: label });
const editorText = (page: Page) => page.locator(".theia-editor .view-lines");
const pdfPage = (page: Page) => page.locator(".pdf-viewer-widget img[src^='blob:']").first();

/** An S3 mount "Cloud" holding notes.md and Docs/sample.pdf, both open in tabs. */
async function openS3Files(page: Page) {
  await start(page, "", { password: "pw" });
  await mountNew(page, "New S3 Bucket…", {
    name: "Cloud",
    fields: {
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: s3.bucket,
      prefix: "",
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
  });
  await expect(explorer(page).getByText("Cloud", { exact: true })).toBeVisible();
  await expect(async () => {
    await page.evaluate(async () => {
      type Files = {
        read(p: string): AsyncIterable<Uint8Array>;
        write(p: string, c: Uint8Array[]): Promise<void>;
      };
      const files = (window as unknown as { theiaShell: { filesApi: Files } }).theiaShell.filesApi;
      const chunks: Uint8Array[] = [];
      for await (const chunk of files.read("/browser/docs/sample.pdf")) chunks.push(chunk);
      await files.write("/cloud/Docs/sample.pdf", chunks);
      await files.write("/cloud/notes.md", [new TextEncoder().encode("# Hello from S3\n")]);
    });
  }).toPass({ timeout: 30_000 });
  await explorer(page).getByText("Cloud", { exact: true }).click();
  await explorer(page).getByText("notes.md", { exact: true }).dblclick();
  await expect(editorText(page).last()).toContainText("Hello from S3");
  await explorer(page).getByText("Docs", { exact: true }).click();
  await explorer(page).getByText("sample.pdf", { exact: true }).last().dblclick();
  await expect(pdfPage(page)).toBeVisible({ timeout: 30_000 });
}

async function expectBothRestored(page: Page) {
  await expect(tab(page, "notes.md")).toHaveCount(1, { timeout: 30_000 });
  await tab(page, "notes.md").click();
  await expect(editorText(page).filter({ hasText: "Hello from S3" })).toBeVisible();
  await expect(tab(page, "sample.pdf")).toHaveCount(1);
  await tab(page, "sample.pdf").click();
  await expect(pdfPage(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".pdf-viewer-widget")).not.toContainText("cannot be read");
}

test("files opened on an S3 mount are restored after a reload and the unlock", async ({ page }) => {
  await openS3Files(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
  await page.reload();
  // The prompt comes before the layout is restored, which waits for the answer.
  await expect(page.locator(".vault-dialog")).toBeVisible();
  await expect(page.locator(".theia-preload")).toHaveCount(1);
  await expect(tab(page, "sample.pdf")).toHaveCount(0);
  await unlockVault(page, "pw");
  // Restored in place, as they were: the PDF (opened last) is still the current tab.
  await expect(tab(page, "sample.pdf")).toHaveClass(/lm-mod-current/, { timeout: 30_000 });
  const labels = await page.locator(".lm-TabBar-tabLabel").allTextContents();
  expect(labels.indexOf("notes.md")).toBeGreaterThanOrEqual(0);
  expect(labels.indexOf("notes.md")).toBeLessThan(labels.indexOf("sample.pdf"));
  await expectBothRestored(page);
  expect(errors).toEqual([]);
});

test("with the unlock prompt skipped at reload, the tabs come back after a later unlock", async ({
  page,
}) => {
  await openS3Files(page);
  await page.reload();
  await page.locator(".vault-dialog .theia-button.secondary").click(); // Skip
  await expect(page.locator(".vault-dialog")).toHaveCount(0);
  // The workbench starts without waiting for the locked mount.
  await expect(explorer(page).getByText("Cloud (locked)", { exact: true })).toBeVisible();
  await runFromPalette(page, "Secrets: Unlock");
  await unlockVault(page, "pw");
  await expectBothRestored(page);
});
