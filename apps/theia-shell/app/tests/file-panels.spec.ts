import { expect, type Locator, type Page, test } from "@playwright/test";
// @ts-expect-error — plain JS module
import { hasDocker, startRustFs } from "../../tools/rustfs.mjs";
import {
  explorer,
  mountNew,
  openMain,
  readFile,
  runFromPalette,
  start,
  toast,
  unlockVault,
} from "./helpers";

export const panels = (page: Page) => page.locator(".file-panel");
export const row = (panel: Locator, name: string) =>
  panel.locator(".theia-TreeNode").filter({ has: panel.page().getByText(name, { exact: true }) });
const crumb = (panel: Locator, label: string) =>
  panel.locator(".file-panel-crumb", { hasText: label });

export async function openPanel(page: Page) {
  const before = await panels(page).count();
  await runFromPalette(page, "Open Files Panel");
  await expect(panels(page)).toHaveCount(before + 1);
  return panels(page).last();
}

test("a panel lists a folder flat, navigates into folders and back up", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  const panel = await openPanel(page);
  // A new panel opens at the first workspace root: the main storage.
  await expect(panel.locator(".file-panel-crumb")).toHaveText(["Browser Storage"]);
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(row(panel, "notes")).toBeVisible();
  await row(panel, "notes").dblclick();
  await expect(row(panel, "ideas.md")).toBeVisible();
  await expect(row(panel, "welcome.md")).toHaveCount(0);
  // Backspace goes up (tree-local key, not a keybinding).
  await row(panel, "ideas.md").click();
  await page.keyboard.press("Backspace");
  await expect(row(panel, "welcome.md")).toBeVisible();
  // A workspace root is the top: nothing above the mounts is a workspace folder.
  await row(panel, "welcome.md").click();
  await page.keyboard.press("Backspace");
  await expect(panel.locator(".file-panel-crumb")).toHaveText(["Browser Storage"]);
  await expect(row(panel, "welcome.md")).toBeVisible();
  // Folders never expand in place.
  await expect(panel.locator(".theia-ExpansionToggle")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Backspace inside the type-to-filter box edits the filter, not the folder", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await row(panel, "ideas.md").click();
  await page.keyboard.press("i");
  await expect(panel.locator(".theia-search-input")).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(crumb(panel, "notes")).toBeVisible();
  await expect(row(panel, "ideas.md")).toBeVisible();
  await expect(row(panel, "welcome.md")).toHaveCount(0);
});

test("the panel shows size and date columns and sorts by clicking a header", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "docs").dblclick();
  await expect(row(panel, "sample.pdf").locator(".file-panel-size")).not.toHaveText("");
  const order = () => panel.locator(".theia-TreeNode .theia-TreeNodeSegmentGrow").allTextContents();
  await expect.poll(order).toEqual(["cheatsheet.md", "sample.pdf"]);
  await panel.locator(".file-panel-column", { hasText: "Name" }).click();
  await expect.poll(order).toEqual(["sample.pdf", "cheatsheet.md"]);
});

test("a file opens from the panel", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "welcome.md").dblclick();
  await expect(page.locator(".theia-editor .monaco-editor").last()).toBeVisible();
});

test("an empty folder says so", async ({ page }) => {
  await start(page, "?storage=memory");
  await page.evaluate(async () => {
    const files = (
      window as unknown as { theiaShell: { filesApi: { mkdir(p: string): Promise<void> } } }
    ).theiaShell.filesApi;
    await files.mkdir("/browser/empty");
  });
  const panel = await openPanel(page);
  await row(panel, "empty").dblclick();
  await expect(panel.getByText("This folder is empty")).toBeVisible();
});

test("the breadcrumb navigates to an ancestor", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await expect(crumb(panel, "notes")).toBeVisible();
  await crumb(panel, "Browser Storage").locator(".file-panel-crumb-label").click();
  await expect(row(panel, "welcome.md")).toBeVisible();
});

test("a crumb's dropdown lists its sibling folders and jumps to one", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await crumb(panel, "notes").locator(".file-panel-crumb-toggle").click();
  const list = page.locator(".file-panel-siblings");
  await expect(list.locator(".file-panel-sibling")).toHaveText(["docs", "media", "notes"]);
  await expect(list.locator(".file-panel-sibling.current")).toHaveText("notes");
  await list.locator(".file-panel-sibling", { hasText: "docs" }).click();
  await expect(row(panel, "cheatsheet.md")).toBeVisible();
  await expect(list).toHaveCount(0);
});

test("the first crumb's dropdown lists the workspace roots — the mounts", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  const first = panel.locator(".file-panel-crumb").first();
  await expect(first.locator(".file-panel-crumb-label")).toHaveText("Browser Storage");
  await first.locator(".file-panel-crumb-toggle").click();
  const list = page.locator(".file-panel-siblings");
  await expect(list.locator(".file-panel-sibling")).toHaveText(["Browser Storage", "Temporary"]);
  await expect(list.locator(".file-panel-sibling.current")).toHaveText("Browser Storage");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
  // Choosing another root takes the panel there.
  await first.locator(".file-panel-crumb-toggle").click();
  await list.locator(".file-panel-sibling", { hasText: "Temporary" }).click();
  await expect(panel.locator(".file-panel-crumb")).toHaveText(["Temporary"]);
  await expect(panel.getByText("This folder is empty")).toBeVisible();
});

/** Takes `panel` to another workspace root through its first crumb's dropdown. */
async function toRoot(panel: Locator, name: string) {
  await panel.locator(".file-panel-crumb").first().locator(".file-panel-crumb-toggle").click();
  await panel.page().locator(".file-panel-siblings .file-panel-sibling", { hasText: name }).click();
  await expect(panel.locator(".file-panel-crumb")).toHaveCount(1);
  await expect(panel.locator(".file-panel-crumb-label")).toContainText(name);
}

async function contextMenu(panel: Locator, name: string, item: string) {
  await row(panel, name).click({ button: "right" });
  await panel.page().locator(".lm-Menu-item", { hasText: item }).first().click();
}

test("rename and delete from the panel's context menu reach the explorer", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await contextMenu(panel, "ideas.md", "Rename");
  const input = page.locator(".dialogContent input");
  await input.fill("plans.md");
  await page.keyboard.press("Enter");
  await expect(row(panel, "plans.md")).toBeVisible();
  await explorer(page).getByText("notes", { exact: true }).click();
  await expect(explorer(page).getByText("plans.md", { exact: true })).toBeVisible();

  await contextMenu(panel, "plans.md", "Delete");
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(row(panel, "plans.md")).toHaveCount(0);
  await expect(explorer(page).getByText("plans.md", { exact: true })).toHaveCount(0);
});

test("the panel's Open opens a file; the explorer's Open in Files Panel opens a folder", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await contextMenu(panel, "welcome.md", "Open");
  await expect(page.locator(".theia-editor .monaco-editor").last()).toBeVisible();

  await explorer(page).getByText("docs", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Open in Files Panel" }).click();
  await expect(row(panels(page).last(), "cheatsheet.md")).toBeVisible();
});

const dialog = (page: Page) => page.locator(".file-panels-transfer-dialog");
const readText = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const files = (
      window as unknown as { theiaShell: { filesApi: { exists(p: string): Promise<boolean> } } }
    ).theiaShell.filesApi;
    return files.exists(p);
  }, path);

// `openPanel` returns `panels(page).last()`, which drifts once a second panel opens; pin each
// panel to its DOM position (panels are never closed or reordered within these tests) so both
// stay addressable once two are open.
async function twoPanels(page: Page, left: string[], right: string[]) {
  await openPanel(page);
  const a = panels(page).nth(0);
  for (const name of left) await row(a, name).dblclick();
  await openPanel(page);
  const b = panels(page).nth(1);
  for (const name of right) await row(b, name).dblclick();
  return [a, b] as const;
}

test("dragging between panels asks, and Copy copies", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, [], ["docs"]);
  await row(a, "welcome.md").dragTo(b.locator(".file-panel-tree"));
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).locator("input[name=file-panels-op]")).toHaveCount(2); // Copy, Move
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "welcome.md")).toBeVisible();
  await expect(row(a, "welcome.md")).toBeVisible();
});

test("Move moves", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, [], ["docs"]);
  await row(a, "welcome.md").dragTo(b.locator(".file-panel-tree"));
  await dialog(page).locator("input[name=file-panels-op][value=move]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "welcome.md")).toBeVisible();
  await expect(row(a, "welcome.md")).toHaveCount(0);
});

test("Move to Other Panel moves across workspace roots (mounts)", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, [], []);
  await toRoot(b, "Temporary");
  await row(a, "welcome.md").click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Move to Other Panel…" }).click();
  await expect(dialog(page).locator("input[name=file-panels-op][value=move]")).toBeChecked();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "welcome.md")).toBeVisible();
  await expect(row(a, "welcome.md")).toHaveCount(0);
  await expect.poll(() => readText(page, "/temp/welcome.md")).toBe(true);
  await expect.poll(() => readText(page, "/browser/welcome.md")).toBe(false);
});

test("a drop into the same folder offers only Copy or Rename; Copy makes a free name", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await row(panel, "ideas.md").dragTo(panel.locator(".file-panel-tree"), {
    targetPosition: { x: 20, y: 200 },
  });
  const ops = dialog(page).locator("input[name=file-panels-op]");
  await expect(ops).toHaveCount(2);
  await expect(dialog(page).locator("input[name=file-panels-op][value=rename]")).toHaveCount(1);
  await expect(dialog(page).locator(".file-panels-name")).toHaveValue("ideas copy.md");
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(panel, "ideas copy.md")).toBeVisible();
});

const writeText = (page: Page, path: string, text: string) =>
  page.evaluate(
    async ([p, t]) => {
      const files = (
        window as unknown as {
          theiaShell: {
            filesApi: { write(p: string, c: AsyncIterable<Uint8Array>): Promise<void> };
          };
        }
      ).theiaShell.filesApi;
      await files.write(
        p,
        (async function* () {
          yield new TextEncoder().encode(t);
        })(),
      );
    },
    [path, text] as const,
  );

for (const [policy, label] of [
  ["keepBoth", "Keep both"],
  ["skip", "Skip"],
  ["overwrite", "Overwrite"],
] as const) {
  test(`several items with a clash: ${label}`, async ({ page }) => {
    await start(page, "?storage=memory");
    // notes gets its own cheatsheet.md, so copying docs/{cheatsheet.md, sample.pdf} clashes once.
    await writeText(page, "/browser/notes/cheatsheet.md", "the old one");
    const source = await readFile(page, "/browser/docs/cheatsheet.md");
    const [a, b] = await twoPanels(page, ["docs"], ["notes"]);
    await row(a, "cheatsheet.md").click();
    await row(a, "sample.pdf").click({ modifiers: ["Control"] });
    await row(a, "sample.pdf").dragTo(b.locator(".file-panel-tree"));
    await expect(dialog(page).getByText("1 item already exists in the target:")).toBeVisible();
    await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
    await dialog(page).locator(`input[name=file-panels-clash][value=${policy}]`).check();
    await dialog(page).locator(".theia-button.main").click();
    await expect(row(b, "sample.pdf")).toBeVisible();
    if (policy === "keepBoth") {
      await expect(row(b, "cheatsheet copy.md")).toBeVisible();
      expect(await readFile(page, "/browser/notes/cheatsheet.md")).toBe("the old one");
    } else if (policy === "skip") {
      expect(await readFile(page, "/browser/notes/cheatsheet.md")).toBe("the old one");
      await expect(row(b, "cheatsheet copy.md")).toHaveCount(0);
    } else {
      await expect.poll(() => readFile(page, "/browser/notes/cheatsheet.md")).toBe(source);
      await expect(row(b, "cheatsheet copy.md")).toHaveCount(0);
    }
  });
}

test("dropping a folder into itself is refused", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").click();
  await row(panel, "welcome.md").click({ modifiers: ["Control"] });
  await row(panel, "welcome.md").dragTo(row(panel, "notes"));
  // Theia mirrors every notification into the (hidden) notification center, so a bare
  // page.getByText would match twice; scope to the visible toast.
  await expect(toast(page, "Cannot put “notes” inside itself")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(await readText(page, "/browser/welcome.md")).toBe(true);
});

test("names with spaces, # and % survive a copy", async ({ page }) => {
  await start(page, "?storage=memory");
  await page.evaluate(async () => {
    const files = (
      window as unknown as {
        theiaShell: { filesApi: { write(p: string, c: AsyncIterable<Uint8Array>): Promise<void> } };
      }
    ).theiaShell.filesApi;
    await files.write(
      "/browser/my #1 100%.txt",
      (async function* () {
        yield new TextEncoder().encode("x");
      })(),
    );
  });
  const [a, b] = await twoPanels(page, [], ["docs"]);
  await row(a, "my #1 100%.txt").dragTo(b.locator(".file-panel-tree"));
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect.poll(() => readText(page, "/browser/docs/my #1 100%.txt")).toBe(true);
});

test("the explorer drags into a panel with the dialog; failures are reported", async ({ page }) => {
  await start(page, "?storage=memory");
  // A mount that cannot be reached is an empty, read-only placeholder root: writes to it fail.
  await mountNew(page, "New S3 Bucket…", {
    name: "Cloud",
    fields: {
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      bucket: "b",
      prefix: "",
      accessKeyId: "a",
      secretAccessKey: "s",
    },
  });
  await expect(explorer(page).getByText(/^Cloud \(/)).toBeVisible();
  const panel = await openPanel(page);
  await toRoot(panel, "Cloud");
  await explorer(page)
    .getByText("welcome.md", { exact: true })
    .dragTo(panel.locator(".file-panel-tree"), { targetPosition: { x: 20, y: 200 } });
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(toast(page, "1 of 1 item failed")).toBeVisible();
});

test("an operating-system file dropped on a panel is uploaded", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  // Theia's TreeWidget wires onDragOver/onDrop onto the inner ".theia-TreeContainer" div, not
  // onto ".file-panel-tree" (the widget's own outer node) — a dispatchEvent on the outer node
  // never reaches that descendant listener, since native events bubble up, not down.
  await panel.locator(".file-panel-tree .theia-TreeContainer").evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "dropped.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(
        new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    }
  });
  // Theia's own FilesystemFrontendContribution opens a single freshly-uploaded file in an
  // editor (FileUploadService.onDidUpload is global, not ours to gate); that editor covers the
  // panel, per R8, so the upload is verified against the filesystem rather than the panel row.
  await expect.poll(() => readText(page, "/browser/dropped.txt")).toBe(true);
  await expect(dialog(page)).toHaveCount(0);
});

test("panel → explorer: a plain drop moves, Ctrl copies, no dialog", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  const notes = explorer(page).getByText("notes", { exact: true });

  await row(panel, "welcome.md").dragTo(notes);
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => readText(page, "/browser/notes/welcome.md")).toBe(true);
  await expect.poll(() => readText(page, "/browser/welcome.md")).toBe(false);

  await row(panel, "notes").dblclick();
  await page.keyboard.down("Control");
  await row(panel, "ideas.md").dragTo(explorer(page).getByText("docs", { exact: true }));
  await page.keyboard.up("Control");
  await expect.poll(() => readText(page, "/browser/docs/ideas.md")).toBe(true);
  await expect.poll(() => readText(page, "/browser/notes/ideas.md")).toBe(true);
});

test("explorer → explorer still moves without a dialog", async ({ page }) => {
  await start(page, "?storage=memory");
  await explorer(page)
    .getByText("welcome.md", { exact: true })
    .dragTo(explorer(page).getByText("docs", { exact: true }));
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => readText(page, "/browser/docs/welcome.md")).toBe(true);
});

test("Copy to Other Panel copies the selection into the other panel's folder", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, [], ["media"]);
  await row(a, "welcome.md").click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Copy to Other Panel…" }).click();
  await expect(dialog(page).locator("input[name=file-panels-op][value=copy]")).toBeChecked();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "welcome.md")).toBeVisible();
  // The copy is selected in the target panel, as after a drop.
  await expect(row(b, "welcome.md")).toHaveClass(/theia-mod-selected/);
});

test("panels come back after a reload, at their folders and sort", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a] = await twoPanels(page, ["docs"], ["notes"]);
  await a.locator(".file-panel-column", { hasText: "Name" }).click();
  // Theia stores the layout on unload.
  await page.reload();
  await openMain(page);
  await expect(panels(page)).toHaveCount(2);
  await expect(row(panels(page).first(), "cheatsheet.md")).toBeVisible();
  await expect(row(panels(page).last(), "ideas.md")).toBeVisible();
  await expect(panels(page).first().locator(".file-panel-column[aria-sort=descending]")).toHaveText(
    /Name/,
  );
});

test("a panel whose folder is deleted moves up and says so", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await explorer(page).getByText("notes", { exact: true }).click();
  await page.keyboard.press("Delete");
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(
    panel.getByText("“notes” no longer exists — showing “Browser Storage”"),
  ).toBeVisible();
});

test("a panel on a removed mount falls back to the first root, not above the roots", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  await mountNew(page, "New In-Memory Folder…", { name: "Scratch" });
  const panel = await openPanel(page);
  await toRoot(panel, "Scratch");
  await explorer(page).getByText("Scratch", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-itemLabel", { hasText: "Remove Folder from Workspace" }).click();
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(panel.locator(".file-panel-crumb")).toHaveText(["Browser Storage"]);
  await expect(
    panel.getByText("“scratch” no longer exists — showing “Browser Storage”"),
  ).toBeVisible();
});

test("a layout stored at the hidden file:/// comes back at the first root", async ({ page }) => {
  test.slow(); // two full app starts
  await start(page, "?storage=memory");
  await openPanel(page);
  // A layout saved before mounts became roots stores the panel at "file:///" — the read-only
  // composite above the mounts, which resolves fine. Rewrite the stored folder just before the
  // app reads its layout on the reload (Theia stores the layout on unload).
  await page.addInitScript(() => {
    let rewrites = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) as string;
      const value = localStorage.getItem(key) as string;
      const next = value.replace(
        /(folder\\*"\s*:\s*\\*")file:\/\/\/browser(\\*")/g,
        (_, before: string, after: string) => {
          rewrites++;
          return `${before}file:///${after}`;
        },
      );
      if (next !== value) localStorage.setItem(key, next);
    }
    (window as unknown as { layoutRewrites: number }).layoutRewrites = rewrites;
  });
  await page.reload();
  await openMain(page);
  expect(
    await page.evaluate(() => (window as unknown as { layoutRewrites: number }).layoutRewrites),
  ).toBe(1);
  await expect(panels(page)).toHaveCount(1);
  const panel = panels(page).first();
  await expect(panel.locator(".file-panel-crumb")).toHaveText(["Browser Storage"]);
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(panel.getByText(/no longer exists — showing “Browser Storage”/)).toBeVisible();
});

test("a drop on a breadcrumb segment copies there and opens no editor", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, ["docs"], ["notes"]);
  const editors = await page.locator(".theia-editor").count();
  await row(a, "cheatsheet.md").dragTo(
    crumb(b, "Browser Storage").locator(".file-panel-crumb-label"),
  );
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect.poll(() => readText(page, "/browser/cheatsheet.md")).toBe(true);
  await expect.poll(() => readText(page, "/browser/docs/cheatsheet.md")).toBe(true);
  await expect(page.locator(".theia-editor")).toHaveCount(editors);
});

test("a panel whose creation folder is gone after a reload comes back at its parent", async ({
  page,
}) => {
  await start(page, "?storage=memory");
  // Memory storage is re-seeded on reload, so a folder made during the test is gone afterwards.
  await page.evaluate(async () => {
    const files = (
      window as unknown as { theiaShell: { filesApi: { mkdir(p: string): Promise<void> } } }
    ).theiaShell.filesApi;
    await files.mkdir("/browser/fresh");
  });
  await runFromPalette(page, "Refresh in Explorer");
  await explorer(page).getByText("fresh", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Open in Files Panel" }).click();
  const panel = panels(page).last();
  await expect(panel.getByText("This folder is empty")).toBeVisible();
  await page.reload();
  await openMain(page);
  await expect(panels(page)).toHaveCount(1);
  await expect(row(panels(page).first(), "welcome.md")).toBeVisible();
  await expect(
    panels(page).first().getByText("“fresh” no longer exists — showing “Browser Storage”"),
  ).toBeVisible();
});

test("a folder that cannot be read says so, and Retry opens it once it can", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await expect(row(panel, "notes")).toBeVisible();
  // Make /browser/notes unreadable (not missing): the provider's stats throws a plain error.
  await page.evaluate(() => {
    const files = (window as unknown as { theiaShell: { filesApi: Record<string, unknown> } })
      .theiaShell.filesApi;
    const stats = files.stats as (p: string) => Promise<unknown>;
    files.stats = (p: string) =>
      p === "/browser/notes"
        ? Promise.reject(new Error("locked for the test"))
        : stats.call(files, p);
    (window as unknown as { unlockNotes: () => void }).unlockNotes = () => {
      delete files.stats;
    };
  });
  await row(panel, "notes").dblclick();
  const status = panel.locator(".file-panel-status");
  await expect(status).toContainText("“notes” is not available");
  await expect(status).toContainText("locked for the test");
  await expect(crumb(panel, "notes")).toBeVisible();
  await expect(row(panel, "welcome.md")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { unlockNotes: () => void }).unlockNotes());
  await status.getByRole("button", { name: "Retry" }).click();
  await expect(row(panel, "ideas.md")).toBeVisible();
  await expect(status).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the toolbar's Go Up acts on its panel while the focus is elsewhere", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "notes").dblclick();
  await expect(row(panel, "ideas.md")).toBeVisible();
  // The explorer takes the focus; the panel's tab-bar toolbar stays on screen.
  await explorer(page).getByText("media", { exact: true }).click();
  await page.locator('[id="file-panels.goUp"]').click();
  await expect(row(panel, "welcome.md")).toBeVisible();
  // At the workspace root there is nowhere further up.
  await page.locator('[id="file-panels.goUp"]').click();
  await expect(panel.locator(".file-panel-crumb")).toHaveText(["Browser Storage"]);
  await expect(row(panel, "welcome.md")).toBeVisible();
});

test("dragging over a folder row does not change the panel's selection", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "welcome.md").click();
  await row(panel, "welcome.md").dragTo(row(panel, "notes"));
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(row(panel, "welcome.md")).toHaveClass(/theia-mod-selected/);
  await expect(row(panel, "notes")).not.toHaveClass(/theia-mod-selected/);
});

test.describe("labels and returning to a folder after a mount recovers", () => {
  test.skip(!hasDocker(), "Docker is not available: the S3 tests need RustFS");
  test.setTimeout(120_000);

  let s3: Awaited<ReturnType<typeof startRustFs>>;
  test.beforeAll(async () => {
    // The bucket's CORS must allow the app's own origin, which follows E2E_PORT.
    const origin = new URL(test.info().project.use.baseURL as string).origin;
    s3 = await startRustFs({ port: 19111, origin, bucket: "panels" });
  });
  test.afterAll(() => s3?.stop());

  test("a panel's breadcrumb follows label changes; one that fell back returns to its folder", async ({
    page,
  }) => {
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
        const files = (
          window as unknown as {
            theiaShell: { filesApi: { write(p: string, c: Uint8Array[]): Promise<void> } };
          }
        ).theiaShell.filesApi;
        await files.write("/cloud/Docs/notes.md", [new TextEncoder().encode("# Docs")]);
      });
    }).toPass({ timeout: 30_000 });

    // Panel A stays at the mount root: a pure label re-render, no fallback involved.
    const panelA = await openPanel(page);
    await toRoot(panelA, "Cloud");
    await expect(panelA.locator(".file-panel-crumb")).toHaveText(["Cloud"]);

    // Panel B goes into Docs — the folder it must return to once the mount is back.
    const panelB = await openPanel(page);
    await toRoot(panelB, "Cloud");
    await row(panelB, "Docs").dblclick();
    await expect(panelB.locator(".file-panel-crumb")).toHaveText(["Cloud", "Docs"]);

    await page.reload();
    await page.locator(".vault-dialog .theia-button.secondary").click(); // Skip
    await expect(page.locator(".vault-dialog")).toHaveCount(0);
    await openMain(page);
    await expect(panels(page)).toHaveCount(2);
    const [a, b] = [panels(page).first(), panels(page).last()];
    await expect(a.locator(".file-panel-crumb")).toHaveText(["Cloud (locked)"]);
    await expect(b.locator(".file-panel-crumb")).toHaveText(["Cloud (locked)"]);
    await expect(b.getByText("“Docs” no longer exists — showing “Cloud (locked)”")).toBeVisible();

    await runFromPalette(page, "Secrets: Unlock");
    await unlockVault(page, "pw");

    // Panel A: same folder throughout — the label alone updates, no navigation.
    await expect(a.locator(".file-panel-crumb")).toHaveText(["Cloud"], { timeout: 30_000 });
    // Panel B: returns to Docs by itself, clearing the notice.
    await expect(b.locator(".file-panel-crumb")).toHaveText(["Cloud", "Docs"], {
      timeout: 30_000,
    });
    await expect(row(b, "notes.md")).toBeVisible();
    await expect(page.getByText(/locked/)).toHaveCount(0);
    await expect(page.getByText(/no longer exists/)).toHaveCount(0);
  });
});
