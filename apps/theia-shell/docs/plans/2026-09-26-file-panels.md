# File panels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Midnight-Commander-style file panels for the theia-shell app — any number of one-folder
views in the main area, a breadcrumb with sibling-folder dropdowns, the explorer's file commands,
and copy/move by drag and drop and menu commands, with a Copy/Move/Rename dialog on every drop into
a panel.

**Architecture:** A new frontend-only Theia extension, `packages/theia-file-panels`. Pure logic
(messages, formatting, sorting, breadcrumb segments, transfer planning and execution) lives in
`src/common` and is unit-tested in Node. The panel is Theia's own `FileTreeWidget` used as a flat,
one-level tree (the file dialog's shape) inside a widget that adds a React header. Drops into a
panel go through one `FileDropHandler` and a `TransferDialog`; the explorer gains one case — a
panel drag — through a subclass that falls through to Theia's handler for everything else.

**Tech Stack:** Theia 1.76.0 (browser-only), TypeScript 5.9 (CommonJS), React 18 via
`@theia/core/shared/react`, Lumino, `Intl` (NumberFormat, DateTimeFormat, Collator, PluralRules),
vitest 4, Playwright 1.56.

**Spec:** `apps/theia-shell/docs/specs/2026-09-26-file-panels-design.md` (read it first; this plan
argues from it).

All paths are relative to `apps/theia-shell/` unless they start with `/`. The work happens in the
worktree `worktrees/theia-file-panels/statewalker-sandbox` on branch `feat/theia-shell-file-panels`.

## Global Constraints

- Exact version pins, as the existing packages do: `@theia/*` `1.76.0`.
- Package compiles with `tsc -p tsconfig.json` extending `../../tsconfig.theia.json` (CommonJS,
  `moduleResolution: node`, `jsx: react`); `src/` → `lib/`; unit tests in `tests/**/*.test.ts`,
  vitest, `environment: "node"`.
- `theiaExtensions`: `frontend` and `frontendOnly` both `lib/browser/file-panels-frontend-module`.
- The package is added to `app/package.json` `dependencies` **and** to the `--filter` lists of its
  `build` and `build:prod` scripts.
- **Extension rule (spec):** only exported Theia classes/interfaces/DI symbols, and only their
  public or protected members. No private members, no copies of Theia internals. The explorer's
  existing drop behaviour never changes.
- **No keybindings.** No `KeybindingContribution`. Keys inside a focused list are tree-local.
- **i18n:** every user-visible string comes from `src/common/file-panels-nls.ts`; each message is a
  function whose body calls `nls.localize("theia-shell/file-panels/<key>", "<English>", ...args)`
  with **string-literal** key and default (so `theia nls-extract` can find them). No concatenated
  messages; placeholders `{0}`, `{1}`. Plural messages select a CLDR category with
  `Intl.PluralRules` and have one literal key per category they may hit
  (`zero|one|two|few|many|other`), the English default of non-English categories being the
  `other` text. Numbers, dates, sizes and name ordering use `Intl` with `currentLocale()`.
- CSS uses logical properties only (`margin-inline-start`, `padding-inline`, `text-align: start`…).
- Drag payload types: `theia-editor-dnd` (Theia's, via `ApplicationShell.setDraggedEditorUris`)
  and `theia-file-panels/uris` (newline-separated URI strings; panel drags only).
- Red → green, as PLAN.md's *Method*: every test is run failing before the code that makes it
  pass; record red and green counts in the package README's *Red / green* section per task.
- Commits: `theia-shell: <what>` plus the trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  `npx -y @biomejs/biome@2.5.11 check apps/theia-shell` (from the sandbox root) is clean before
  every commit.
- E2E: app port 3100; tests start with `start(page, "?storage=memory")` (no vault; seeded tree:
  `/browser/{welcome.md, notes/ideas.md, docs/cheatsheet.md, docs/sample.pdf, media/logo.svg,
  media/gradient.png}`; the main mount is labelled "Browser Storage"; the single workspace root
  `file:///` is labelled "Files").

## Decisions made while planning (written into the spec in Task 0)

1. **Clashes between sources never overwrite.** Two dropped items with the same name: under
   *Overwrite* the second gets a free name (overwriting something this batch just wrote would lose
   data); under *Skip* it is skipped; under *Keep both* it gets a free name.
2. **Plurals** use one literal key per CLDR category (see Global Constraints).
3. **Size units** come from `Intl.NumberFormat` `style: "unit"` (`byte`, `kilobyte`, `megabyte`,
   `gigabyte`, `terabyte`), so they are localized by the platform and need no message keys.
4. **Go Up / Refresh** are tab-bar toolbar items of the active panel (Theia's
   `TabBarToolbarContribution`), not buttons inside the panel.
5. **"Open"** in the panel context menu is the panel's own command (the navigator's `OPEN` acts on
   the navigator widget). Open With, Rename, Delete, New File, New Folder, Duplicate, Copy Path and
   Reveal in Explorer are Theia's commands, which act on the global selection.
6. A new panel opens **split to the right** of the current widget when that is a panel, otherwise
   as a tab in the main area.
7. Reading a `DataTransfer` after an `await` returns nothing (the browser clears it when the drop
   event ends). Drop handlers read every payload **synchronously** before their first `await`.

## Review Focus

1. **Names with spaces, `#`, `%`, and non-Latin scripts** (`my #1 100%.txt`, `заметки.md`) → a
   copy/move/rename lands on exactly that name; nothing is double-encoded (Task 3 planner test with
   `URI.resolve`; Task 9 e2e drags `my #1 100%.txt`).
2. **A selection that contains the drop target** (drag folder `notes` and `welcome.md` onto
   `notes`) → the whole drop is refused with "Cannot put “notes” inside itself", nothing moves
   (Task 3 `invalidDrop` test; Task 9 e2e).
3. **A case-only rename** (`ideas.md` → `Ideas.md`) → one move, no overwrite, no clash warning
   (Task 3 planner test).
4. **An empty folder** → the panel says "This folder is empty", not a blank area (Task 6 e2e).
5. **A failing step in the middle of a batch** (e.g. writing into the read-only top level `/`) →
   the other steps still run, and one notification lists the failures (Task 5 `runPlan` test; Task 9
   e2e drops onto the "Files" root).

---

### Task 0: Setup, baseline, spec alignment

**Files:**
- Modify: `docs/specs/2026-09-26-file-panels-design.md` (append *Decisions made while planning*)

- [ ] **Step 1: Install and build**

Run (in `apps/theia-shell`):
```bash
pnpm install
pnpm --filter @theia-shell/app build
```
Expected: install resolves from the store; the build ends with the Theia bundle written to
`app/lib/frontend`.

- [ ] **Step 2: Baseline tests**

Run:
```bash
pnpm test
cd app && pnpm exec playwright test tests/files.spec.ts && cd ..
```
Expected: all unit tests pass; `files.spec.ts` passes. Write the counts down — they are the
baseline for Task 13.

- [ ] **Step 3: Record the planning decisions in the spec**

Append to `docs/specs/2026-09-26-file-panels-design.md`:

```markdown
## Decisions made while planning

1. Clashes between dropped sources never overwrite: under *Overwrite* the later source gets a free
   name; *Skip* skips it; *Keep both* gives it a free name.
2. Plural messages have one literal key per CLDR category; the English default of every category
   other than `one` is the `other` text.
3. Size units are formatted by `Intl.NumberFormat` (`style: "unit"`), not by message keys.
4. Go Up and Refresh are tab-bar toolbar items of the active panel.
5. The panel's "Open" is its own command; the other context-menu entries are Theia's commands on
   the global selection.
6. A new panel opens split to the right of the current panel, else as a main-area tab.
7. Drop handlers read the `DataTransfer` synchronously, before their first `await`.
```

- [ ] **Step 4: Commit**

```bash
git add apps/theia-shell/docs/specs/2026-09-26-file-panels-design.md
git commit -m "theia-shell: file panels — decisions made while planning

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 1: Package skeleton, messages and formatting

**Files:**
- Create: `packages/theia-file-panels/package.json`
- Create: `packages/theia-file-panels/tsconfig.json`
- Create: `packages/theia-file-panels/vitest.config.ts`
- Create: `packages/theia-file-panels/README.md`
- Create: `packages/theia-file-panels/src/common/index.ts`
- Create: `packages/theia-file-panels/src/common/locale.ts`
- Create: `packages/theia-file-panels/src/common/format.ts`
- Create: `packages/theia-file-panels/src/common/file-panels-nls.ts`
- Create: `packages/theia-file-panels/src/browser/file-panels-frontend-module.ts`
- Create: `packages/theia-file-panels/src/browser/style/file-panels.css`
- Modify: `app/package.json` (dependency + both `--filter` lists)
- Test: `packages/theia-file-panels/tests/format.test.ts`
- Test: `packages/theia-file-panels/tests/file-panels-nls.test.ts`

**Interfaces:**
- Produces:
  - `currentLocale(): string`
  - `formatSize(bytes: number, locale?: string): string`
  - `formatDate(mtime: number, locale?: string): string`
  - `pluralCategory(count: number, locale?: string): Intl.LDMLPluralRule`
  - `Messages` — an object of message functions (full list in Step 5); every later task takes its
    strings from it.

- [ ] **Step 1: Package files**

`packages/theia-file-panels/package.json`:
```json
{
  "name": "@theia-shell/theia-file-panels",
  "version": "0.0.0",
  "private": true,
  "description": "Theia extension: Midnight-Commander-style file panels with sibling-folder breadcrumbs and a copy/move dialog.",
  "main": "lib/common/index.js",
  "types": "lib/common/index.d.ts",
  "files": ["lib", "src"],
  "theiaExtensions": [
    {
      "frontend": "lib/browser/file-panels-frontend-module",
      "frontendOnly": "lib/browser/file-panels-frontend-module"
    }
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@theia/core": "1.76.0",
    "@theia/filesystem": "1.76.0",
    "@theia/navigator": "1.76.0",
    "@theia/workspace": "1.76.0"
  }
}
```

`packages/theia-file-panels/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.theia.json",
  "compilerOptions": { "rootDir": "src", "outDir": "lib", "jsx": "react" },
  "include": ["src"]
}
```

`packages/theia-file-panels/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], environment: "node" },
});
```

`packages/theia-file-panels/src/browser/file-panels-frontend-module.ts` (filled in by later
tasks):
```ts
import "../../src/browser/style/file-panels.css";
import { ContainerModule } from "@theia/core/shared/inversify";

export default new ContainerModule(() => {});
```

`packages/theia-file-panels/src/browser/style/file-panels.css`:
```css
/* File panels. Logical properties only, so right-to-left layouts mirror. */
```

`packages/theia-file-panels/README.md`:
```markdown
# @theia-shell/theia-file-panels

Midnight-Commander-style file panels for the theia-shell app: one-folder views in the main area,
a breadcrumb whose segments list their sibling folders, the explorer's file commands, and
copy/move by drag and drop and by menu commands. Design:
[`docs/specs/2026-09-26-file-panels-design.md`](../../docs/specs/2026-09-26-file-panels-design.md).

## Red / green

| Task | Red | Green |
|---|---|---|
```

In `app/package.json`: add `"@theia-shell/theia-file-panels": "workspace:*"` to `dependencies`
(alphabetical order), and `--filter @theia-shell/theia-file-panels` right after
`--filter @theia-shell/theia-files-s3` in **both** `build` and `build:prod`.

Run: `pnpm install`
Expected: the new workspace package is linked.

- [ ] **Step 2: Write the failing formatting tests**

`packages/theia-file-panels/tests/format.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { formatDate, formatSize, pluralCategory } from "../src/common/format";
import { currentLocale } from "../src/common/locale";

describe("currentLocale", () => {
  it("falls back to en outside a browser", () => {
    expect(currentLocale()).toBe("en");
  });
});

describe("formatSize", () => {
  it("picks the largest unit below 1024 and localizes number and unit", () => {
    expect(formatSize(0, "en")).toBe("0 byte");
    expect(formatSize(512, "en")).toBe("512 byte");
    expect(formatSize(1536, "en")).toBe("1.5 kB");
    expect(formatSize(1536, "de")).toBe("1,5 kB");
    expect(formatSize(5 * 1024 ** 2, "en")).toBe("5 MB");
    expect(formatSize(3.25 * 1024 ** 3, "en")).toBe("3.3 GB");
  });
});

describe("formatDate", () => {
  it("formats in the given locale", () => {
    const t = Date.UTC(2026, 8, 26, 12, 0);
    expect(formatDate(t, "en")).toMatch(/2026/);
    expect(formatDate(t, "de")).toMatch(/26\.09\.26|26\.9\.26|26\.09\.2026/);
  });
});

describe("pluralCategory", () => {
  it("follows CLDR rules per locale", () => {
    expect(pluralCategory(1, "en")).toBe("one");
    expect(pluralCategory(2, "en")).toBe("other");
    expect(pluralCategory(3, "ru")).toBe("few");
    expect(pluralCategory(5, "ru")).toBe("many");
    expect(pluralCategory(21, "ru")).toBe("one");
  });
});
```

Note on `"0 byte"`: `Intl` renders `unit: "byte"` with `unitDisplay: "short"` as `byte` in
English. If the Node ICU version renders it differently, change the expectation to what
`new Intl.NumberFormat("en", { style: "unit", unit: "byte", unitDisplay: "short" }).format(0)`
prints — the point of the test is that the platform, not a key, produces the unit.

- [ ] **Step 3: Run to see it fail**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: FAIL — cannot resolve `../src/common/format`.

- [ ] **Step 4: Implement locale and formatting**

`packages/theia-file-panels/src/common/locale.ts`:
```ts
import { nls } from "@theia/core/lib/common/nls";

/** The UI locale Theia runs in; "en" when none is set (and outside a browser). */
export function currentLocale(): string {
  try {
    return nls.locale ?? "en";
  } catch {
    return "en";
  }
}
```

`packages/theia-file-panels/src/common/format.ts`:
```ts
import { currentLocale } from "./locale";

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

/** A file size in the largest unit below 1024, number and unit localized by Intl. */
export function formatSize(bytes: number, locale = currentLocale()): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

/** A modification time (ms since the epoch), short date and time. */
export function formatDate(mtime: number, locale = currentLocale()): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(mtime);
}

/** The CLDR plural category of `count` in `locale`. */
export function pluralCategory(count: number, locale = currentLocale()): Intl.LDMLPluralRule {
  return new Intl.PluralRules(locale).select(count);
}
```

- [ ] **Step 5: Write the failing catalog tests**

`packages/theia-file-panels/tests/file-panels-nls.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Messages } from "../src/common/file-panels-nls";

const source = readFileSync(new URL("../src/common/file-panels-nls.ts", import.meta.url), "utf8");
const calls = [...source.matchAll(/nls\.localize\(\s*"([^"]+)",\s*"((?:[^"\\]|\\.)*)"/g)];

describe("the message catalog", () => {
  it("uses literal, prefixed, unique keys", () => {
    expect(calls.length).toBeGreaterThan(20);
    const keys = calls.map((c) => c[1]);
    for (const key of keys) expect(key).toMatch(/^theia-shell\/file-panels\/[a-zA-Z.]+$/);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("renders every argument and leaves no placeholder", () => {
    for (const [name, fn] of Object.entries(Messages)) {
      const args = Array.from({ length: fn.length }, (_, i) => (i === 0 ? 7 : `‹${i}›`));
      const text = (fn as (...a: unknown[]) => string)(...args);
      expect(text, name).not.toMatch(/\{\d\}/);
      for (const arg of args.slice(1)) expect(text, name).toContain(String(arg));
      expect(text.length, name).toBeGreaterThan(0);
    }
  });

  it("gives plural messages a text for every Russian category", () => {
    for (const count of [1, 3, 5, 21]) {
      expect(Messages.transferTitle(count, "‹x›", "ru")).not.toBe("");
      expect(Messages.clashCount(count, "ru")).toContain(String(count));
    }
  });

  it("builds copy suffixes", () => {
    expect(Messages.copySuffix(1)).toBe(" copy");
    expect(Messages.copySuffix(2)).toBe(" copy 2");
  });
});
```

The first-argument convention: a message whose first parameter is a count receives `7` in the
generic test; every other argument is a string sentinel that must appear in the output.

- [ ] **Step 6: Run to see it fail**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: FAIL — cannot resolve `../src/common/file-panels-nls`.

- [ ] **Step 7: Implement the catalog**

`packages/theia-file-panels/src/common/file-panels-nls.ts`:
```ts
import { nls } from "@theia/core/lib/common/nls";
import { pluralCategory } from "./format";
import { currentLocale } from "./locale";

/*
 * Every user-visible string of the extension. Keys and defaults are string literals at each
 * call so that `theia nls-extract` can collect them. Plural messages have one key per CLDR
 * category; categories English does not use default to the English "other" text.
 */
export const Messages = {
  category: () => nls.localize("theia-shell/file-panels/category", "Files Panel"),
  openFilesPanel: () => nls.localize("theia-shell/file-panels/openFilesPanel", "Open Files Panel"),
  openInFilesPanel: () =>
    nls.localize("theia-shell/file-panels/openInFilesPanel", "Open in Files Panel"),
  goUp: () => nls.localize("theia-shell/file-panels/goUp", "Go Up"),
  refresh: () => nls.localize("theia-shell/file-panels/refresh", "Refresh"),
  open: () => nls.localize("theia-shell/file-panels/open", "Open"),
  copyToOtherPanel: () =>
    nls.localize("theia-shell/file-panels/copyToOtherPanel", "Copy to Other Panel…"),
  moveToOtherPanel: () =>
    nls.localize("theia-shell/file-panels/moveToOtherPanel", "Move to Other Panel…"),
  pickOtherPanel: () =>
    nls.localize("theia-shell/file-panels/pickOtherPanel", "Choose the target panel"),

  columnName: () => nls.localize("theia-shell/file-panels/columnName", "Name"),
  columnSize: () => nls.localize("theia-shell/file-panels/columnSize", "Size"),
  columnModified: () => nls.localize("theia-shell/file-panels/columnModified", "Modified"),
  emptyFolder: () => nls.localize("theia-shell/file-panels/emptyFolder", "This folder is empty"),
  siblingsOf: (name: string) =>
    nls.localize("theia-shell/file-panels/siblingsOf", "Folders next to “{0}”", name),
  hiddenFolders: () => nls.localize("theia-shell/file-panels/hiddenFolders", "More folders"),
  folderGone: (gone: string, shown: string) =>
    nls.localize(
      "theia-shell/file-panels/folderGone",
      "“{0}” no longer exists — showing “{1}”",
      gone,
      shown,
    ),
  notAvailable: (name: string, reason: string) =>
    nls.localize("theia-shell/file-panels/notAvailable", "“{0}” is not available: {1}", name, reason),
  retry: () => nls.localize("theia-shell/file-panels/retry", "Retry"),

  transferTitle: (count: number, name: string, locale = currentLocale()) => {
    switch (pluralCategory(count, locale)) {
      case "one":
        return nls.localize("theia-shell/file-panels/transferTitle.one", "Copy or move “{1}”", count, name);
      case "zero":
        return nls.localize("theia-shell/file-panels/transferTitle.zero", "Copy or move {0} items", count, name);
      case "two":
        return nls.localize("theia-shell/file-panels/transferTitle.two", "Copy or move {0} items", count, name);
      case "few":
        return nls.localize("theia-shell/file-panels/transferTitle.few", "Copy or move {0} items", count, name);
      case "many":
        return nls.localize("theia-shell/file-panels/transferTitle.many", "Copy or move {0} items", count, name);
      default:
        return nls.localize("theia-shell/file-panels/transferTitle.other", "Copy or move {0} items", count, name);
    }
  },
  sameFolderTitle: (count: number, name: string, locale = currentLocale()) => {
    switch (pluralCategory(count, locale)) {
      case "one":
        return nls.localize("theia-shell/file-panels/sameFolderTitle.one", "Copy or rename “{1}”", count, name);
      case "zero":
        return nls.localize("theia-shell/file-panels/sameFolderTitle.zero", "Copy {0} items", count, name);
      case "two":
        return nls.localize("theia-shell/file-panels/sameFolderTitle.two", "Copy {0} items", count, name);
      case "few":
        return nls.localize("theia-shell/file-panels/sameFolderTitle.few", "Copy {0} items", count, name);
      case "many":
        return nls.localize("theia-shell/file-panels/sameFolderTitle.many", "Copy {0} items", count, name);
      default:
        return nls.localize("theia-shell/file-panels/sameFolderTitle.other", "Copy {0} items", count, name);
    }
  },
  clashCount: (count: number, locale = currentLocale()) => {
    switch (pluralCategory(count, locale)) {
      case "one":
        return nls.localize("theia-shell/file-panels/clashCount.one", "{0} item already exists in the target:", count);
      case "zero":
        return nls.localize("theia-shell/file-panels/clashCount.zero", "{0} items already exist in the target:", count);
      case "two":
        return nls.localize("theia-shell/file-panels/clashCount.two", "{0} items already exist in the target:", count);
      case "few":
        return nls.localize("theia-shell/file-panels/clashCount.few", "{0} items already exist in the target:", count);
      case "many":
        return nls.localize("theia-shell/file-panels/clashCount.many", "{0} items already exist in the target:", count);
      default:
        return nls.localize("theia-shell/file-panels/clashCount.other", "{0} items already exist in the target:", count);
    }
  },
  targetFolder: (name: string) => nls.localize("theia-shell/file-panels/targetFolder", "To: {0}", name),
  opCopy: () => nls.localize("theia-shell/file-panels/opCopy", "Copy"),
  opMove: () => nls.localize("theia-shell/file-panels/opMove", "Move"),
  opRename: () => nls.localize("theia-shell/file-panels/opRename", "Rename"),
  nameLabel: () => nls.localize("theia-shell/file-panels/nameLabel", "Name"),
  nameExists: (name: string) =>
    nls.localize("theia-shell/file-panels/nameExists", "“{0}” already exists — it will be replaced", name),
  clashOverwrite: () => nls.localize("theia-shell/file-panels/clashOverwrite", "Overwrite"),
  clashKeepBoth: () => nls.localize("theia-shell/file-panels/clashKeepBoth", "Keep both"),
  clashSkip: () => nls.localize("theia-shell/file-panels/clashSkip", "Skip"),
  nameEmpty: () => nls.localize("theia-shell/file-panels/nameEmpty", "A name is required"),
  nameDots: () => nls.localize("theia-shell/file-panels/nameDots", "“.” and “..” are not allowed"),
  nameSlash: () => nls.localize("theia-shell/file-panels/nameSlash", "A name cannot contain “/”"),
  nameUnchanged: () => nls.localize("theia-shell/file-panels/nameUnchanged", "Choose a new name"),
  copySuffix: (n: number) =>
    n === 1
      ? nls.localize("theia-shell/file-panels/copySuffix.first", " copy")
      : nls.localize("theia-shell/file-panels/copySuffix.nth", " copy {0}", n),
  intoItself: (name: string) =>
    nls.localize("theia-shell/file-panels/intoItself", "Cannot put “{0}” inside itself", name),
  transferring: () => nls.localize("theia-shell/file-panels/transferring", "Copying and moving files"),
  progressStep: (done: number, total: string) =>
    nls.localize("theia-shell/file-panels/progressStep", "{0} of {1}", done, total),
  itemsFailed: (failed: number, total: string) =>
    nls.localize("theia-shell/file-panels/itemsFailed", "{0} of {1} items failed", failed, total),
} as const;
```

Two signature details the generic test relies on: `progressStep` and `itemsFailed` take their
second number as a string (callers pass `String(total)`), so the sentinel check covers it; and the
plural messages' trailing `locale` parameter has a default, so `fn.length` counts only the
required parameters.

`packages/theia-file-panels/src/common/index.ts`:
```ts
export * from "./file-panels-nls";
export * from "./format";
export * from "./locale";
```

- [ ] **Step 8: Run to see it pass; build the app**

Run:
```bash
pnpm --filter @theia-shell/theia-file-panels test
pnpm --filter @theia-shell/app build
```
Expected: all tests PASS; the app builds with the (empty) extension included.

- [ ] **Step 9: Record red/green, check, commit**

Add a row `| 1 messages, formatting | <n> failing | <n> passing |` to the README table.

```bash
npx -y @biomejs/biome@2.5.11 check apps/theia-shell
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/package.json apps/theia-shell/pnpm-lock.yaml
git commit -m "theia-shell: file panels — package, message catalog and Intl formatting

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Sorting

**Files:**
- Create: `packages/theia-file-panels/src/common/panel-sorting.ts`
- Modify: `packages/theia-file-panels/src/common/index.ts`
- Test: `packages/theia-file-panels/tests/panel-sorting.test.ts`

**Interfaces:**
- Produces:
  - `type SortColumn = "name" | "size" | "modified"`
  - `interface SortState { column: SortColumn; direction: "asc" | "desc" }`
  - `const DEFAULT_SORT: SortState` (`{ column: "name", direction: "asc" }`)
  - `interface SortEntry { name: string; isDirectory: boolean; size?: number; mtime?: number }`
  - `compareEntries(state: SortState, locale?: string): (a: SortEntry, b: SortEntry) => number`
  - `toggleSort(state: SortState, column: SortColumn): SortState`

- [ ] **Step 1: Write the failing tests**

`packages/theia-file-panels/tests/panel-sorting.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  compareEntries,
  DEFAULT_SORT,
  type SortEntry,
  toggleSort,
} from "../src/common/panel-sorting";

const f = (name: string, size = 0, mtime = 0): SortEntry => ({ name, isDirectory: false, size, mtime });
const d = (name: string): SortEntry => ({ name, isDirectory: true });
const names = (entries: SortEntry[]) => entries.map((e) => e.name);

describe("compareEntries", () => {
  it("puts folders first, then orders names numerically", () => {
    const list = [f("file10"), d("b"), f("file2"), d("a")];
    expect(names(list.sort(compareEntries(DEFAULT_SORT, "en")))).toEqual(["a", "b", "file2", "file10"]);
  });

  it("keeps folders first when descending", () => {
    const list = [f("a"), d("x"), f("b"), d("y")];
    const sorted = list.sort(compareEntries({ column: "name", direction: "desc" }, "en"));
    expect(names(sorted)).toEqual(["y", "x", "b", "a"]);
  });

  it("orders accented names with the locale's collator", () => {
    const list = [f("Zebra"), f("Äpfel"), f("apfel")];
    expect(names(list.sort(compareEntries(DEFAULT_SORT, "de")))).toEqual(["Äpfel", "apfel", "Zebra"]);
  });

  it("sorts by size and by date, ties broken by name", () => {
    const list = [f("c", 5, 3), f("a", 9, 1), f("b", 5, 2)];
    expect(names(list.sort(compareEntries({ column: "size", direction: "asc" }, "en")))).toEqual(["b", "c", "a"]);
    expect(names(list.sort(compareEntries({ column: "modified", direction: "desc" }, "en")))).toEqual(["c", "b", "a"]);
  });

  it("treats missing size or date as zero", () => {
    const list = [f("a", 3), { name: "b", isDirectory: false }];
    expect(names(list.sort(compareEntries({ column: "size", direction: "asc" }, "en")))).toEqual(["b", "a"]);
  });
});

describe("toggleSort", () => {
  it("reverses the active column and starts a new one ascending", () => {
    expect(toggleSort(DEFAULT_SORT, "name")).toEqual({ column: "name", direction: "desc" });
    expect(toggleSort({ column: "name", direction: "desc" }, "size")).toEqual({ column: "size", direction: "asc" });
  });
});
```

Note on the `de` case: with `sensitivity: "base"`, `Äpfel` and `apfel` compare equal, so the
ordering between them comes from the tie-breaker. The tie-breaker is a second collator comparison
with `sensitivity: "variant"`, which in German orders `Äpfel` before `apfel`? If ICU orders them the
other way, flip the two in the expectation — what the test pins is that both sort before `Zebra`
(accent-insensitive) and that the order between them is stable.

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: FAIL — cannot resolve `../src/common/panel-sorting`.

- [ ] **Step 3: Implement**

`packages/theia-file-panels/src/common/panel-sorting.ts`:
```ts
import { currentLocale } from "./locale";

export type SortColumn = "name" | "size" | "modified";
export interface SortState {
  column: SortColumn;
  direction: "asc" | "desc";
}
export const DEFAULT_SORT: SortState = { column: "name", direction: "asc" };

export interface SortEntry {
  name: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
}

/** Folders first (in both directions), then the column; ties broken by name. */
export function compareEntries(
  state: SortState,
  locale = currentLocale(),
): (a: SortEntry, b: SortEntry) => number {
  const loose = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  const strict = new Intl.Collator(locale, { numeric: true, sensitivity: "variant" });
  const byName = (a: SortEntry, b: SortEntry) =>
    loose.compare(a.name, b.name) || strict.compare(a.name, b.name);
  const sign = state.direction === "asc" ? 1 : -1;
  return (a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let order = 0;
    if (state.column === "size") order = (a.size ?? 0) - (b.size ?? 0);
    else if (state.column === "modified") order = (a.mtime ?? 0) - (b.mtime ?? 0);
    return sign * (order || byName(a, b));
  };
}

/** Clicking a column header: the active column reverses, another column starts ascending. */
export function toggleSort(state: SortState, column: SortColumn): SortState {
  if (state.column === column) {
    return { column, direction: state.direction === "asc" ? "desc" : "asc" };
  }
  return { column, direction: "asc" };
}
```

Add `export * from "./panel-sorting";` to `src/common/index.ts`.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: PASS.

- [ ] **Step 5: Record, check, commit**

README row `| 2 sorting | … | … |`; biome check; then:
```bash
git add apps/theia-shell/packages/theia-file-panels
git commit -m "theia-shell: file panels — folders-first, locale-aware sorting

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Transfer planning

**Files:**
- Create: `packages/theia-file-panels/src/common/transfer-planner.ts`
- Modify: `packages/theia-file-panels/src/common/index.ts`
- Test: `packages/theia-file-panels/tests/transfer-planner.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the copy suffix is injected).
- Produces:
  ```ts
  interface TransferSource { uri: URI; isDirectory: boolean }        // name = uri.path.base
  type TransferOp = "copy" | "move" | "rename";
  type ClashPolicy = "overwrite" | "keepBoth" | "skip";
  interface TransferRequest {
    sources: TransferSource[]; target: URI; existing: ReadonlySet<string>;
    op: TransferOp; name?: string; clash: ClashPolicy; copySuffix: (n: number) => string;
  }
  interface TransferStep { op: "copy" | "move"; from: URI; to: URI; overwrite: boolean }
  interface SkippedSource { uri: URI; reason: "clash" | "alreadyThere" }
  interface TransferPlan { steps: TransferStep[]; skipped: SkippedSource[] }
  interface DropOptions { ops: TransferOp[]; allInTarget: boolean; clashing: string[] }
  function dropOptions(sources: TransferSource[], target: URI, existing: ReadonlySet<string>): DropOptions
  function invalidDrop(sources: TransferSource[], target: URI): TransferSource | undefined
  function freeName(name: string, isDirectory: boolean, taken: ReadonlySet<string>, copySuffix: (n: number) => string): string
  type NameProblem = "empty" | "dots" | "slash";
  function validateName(name: string): NameProblem | undefined
  function planTransfer(request: TransferRequest): TransferPlan
  ```
  `URI` is `@theia/core/lib/common/uri`'s default export.

- [ ] **Step 1: Write the failing tests**

`packages/theia-file-panels/tests/transfer-planner.test.ts`:
```ts
import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import {
  dropOptions,
  freeName,
  invalidDrop,
  planTransfer,
  type TransferRequest,
  type TransferSource,
  validateName,
} from "../src/common/transfer-planner";

const suffix = (n: number) => (n === 1 ? " copy" : ` copy ${n}`);
const u = (path: string) => new URI(`file://${path}`);
const file = (path: string): TransferSource => ({ uri: u(path), isDirectory: false });
const dir = (path: string): TransferSource => ({ uri: u(path), isDirectory: true });
const req = (over: Partial<TransferRequest>): TransferRequest => ({
  sources: [],
  target: u("/b/docs"),
  existing: new Set(),
  op: "copy",
  clash: "keepBoth",
  copySuffix: suffix,
  ...over,
});
const paths = (plan: ReturnType<typeof planTransfer>) =>
  plan.steps.map((s) => `${s.op} ${s.from.path} -> ${s.to.path}${s.overwrite ? " !" : ""}`);

describe("freeName", () => {
  it("inserts the suffix before the first dot of the extension", () => {
    expect(freeName("notes.md", false, new Set(["notes.md"]), suffix)).toBe("notes copy.md");
    expect(freeName("a.tar.gz", false, new Set(["a.tar.gz"]), suffix)).toBe("a copy.tar.gz");
  });
  it("appends to dotfiles and folders", () => {
    expect(freeName(".env", false, new Set([".env"]), suffix)).toBe(".env copy");
    expect(freeName("my.folder", true, new Set(["my.folder"]), suffix)).toBe("my.folder copy");
  });
  it("counts on while the name is taken", () => {
    const taken = new Set(["x.md", "x copy.md", "x copy 2.md"]);
    expect(freeName("x.md", false, taken, suffix)).toBe("x copy 3.md");
  });
  it("uses the injected (localized) suffix", () => {
    expect(freeName("x.md", false, new Set(["x.md"]), (n) => ` Kopie${n > 1 ? ` ${n}` : ""}`)).toBe("x Kopie.md");
  });
});

describe("validateName", () => {
  it("refuses empty, dot names and slashes", () => {
    expect(validateName("")).toBe("empty");
    expect(validateName("   ")).toBe("empty");
    expect(validateName(".")).toBe("dots");
    expect(validateName("..")).toBe("dots");
    expect(validateName("a/b")).toBe("slash");
    expect(validateName("ok.md")).toBeUndefined();
  });
});

describe("invalidDrop", () => {
  it("refuses a folder dropped into itself or a descendant, even in a mixed selection", () => {
    expect(invalidDrop([dir("/b/notes"), file("/b/welcome.md")], u("/b/notes"))?.uri.path.base).toBe("notes");
    expect(invalidDrop([dir("/b/notes")], u("/b/notes/deep"))?.uri.path.base).toBe("notes");
    expect(invalidDrop([dir("/b/notes")], u("/b/notes-2"))).toBeUndefined();
    expect(invalidDrop([file("/b/welcome.md")], u("/b"))).toBeUndefined();
  });
});

describe("dropOptions", () => {
  it("offers copy or rename for one item in its own folder", () => {
    expect(dropOptions([file("/b/docs/a.md")], u("/b/docs"), new Set(["a.md"]))).toEqual({
      ops: ["copy", "rename"], allInTarget: true, clashing: [],
    });
  });
  it("offers only copy for several items in their own folder", () => {
    expect(dropOptions([file("/b/docs/a.md"), file("/b/docs/b.md")], u("/b/docs"), new Set(["a.md", "b.md"])).ops).toEqual(["copy"]);
  });
  it("offers copy or move elsewhere, and lists clashes", () => {
    const o = dropOptions([file("/b/a.md"), file("/b/c.md")], u("/b/docs"), new Set(["a.md"]));
    expect(o).toEqual({ ops: ["copy", "move"], allInTarget: false, clashing: ["a.md"] });
  });
  it("does not count sources already in the target as clashes", () => {
    const o = dropOptions([file("/b/docs/a.md"), file("/b/x.md")], u("/b/docs"), new Set(["a.md"]));
    expect(o.clashing).toEqual([]);
  });
});

describe("planTransfer", () => {
  it("copies into its own folder under a free name", () => {
    const plan = planTransfer(req({ sources: [file("/b/docs/a.md")], existing: new Set(["a.md"]) }));
    expect(paths(plan)).toEqual(["copy /b/docs/a.md -> /b/docs/a copy.md"]);
  });

  it("renames with the given name, and a case-only rename is a plain move", () => {
    const rename = (name: string) =>
      paths(planTransfer(req({ sources: [file("/b/docs/ideas.md")], op: "rename", name, existing: new Set(["ideas.md"]) })));
    expect(rename("plans.md")).toEqual(["move /b/docs/ideas.md -> /b/docs/plans.md"]);
    expect(rename("Ideas.md")).toEqual(["move /b/docs/ideas.md -> /b/docs/Ideas.md"]);
  });

  it("drops a rename to the same name", () => {
    expect(planTransfer(req({ sources: [file("/b/docs/a.md")], op: "rename", name: "a.md" })).steps).toEqual([]);
  });

  it("moves one item under a typed name, overwriting an existing one", () => {
    const plan = planTransfer(req({ sources: [file("/b/a.md")], op: "move", name: "b.md", existing: new Set(["b.md"]) }));
    expect(paths(plan)).toEqual(["move /b/a.md -> /b/docs/b.md !"]);
  });

  it("applies the clash policy to several items", () => {
    const sources = [file("/b/a.md"), file("/b/c.md")];
    const existing = new Set(["a.md"]);
    expect(paths(planTransfer(req({ sources, existing, op: "move", clash: "overwrite" })))).toEqual([
      "move /b/a.md -> /b/docs/a.md !", "move /b/c.md -> /b/docs/c.md",
    ]);
    expect(paths(planTransfer(req({ sources, existing, op: "move", clash: "keepBoth" })))).toEqual([
      "move /b/a.md -> /b/docs/a copy.md", "move /b/c.md -> /b/docs/c.md",
    ]);
    const skip = planTransfer(req({ sources, existing, op: "move", clash: "skip" }));
    expect(paths(skip)).toEqual(["move /b/c.md -> /b/docs/c.md"]);
    expect(skip.skipped.map((s) => [s.uri.path.base, s.reason])).toEqual([["a.md", "clash"]]);
  });

  it("never lets one source overwrite another from the same batch", () => {
    const sources = [file("/b/x/README.md"), file("/b/y/README.md")];
    expect(paths(planTransfer(req({ sources, op: "copy", clash: "overwrite" })))).toEqual([
      "copy /b/x/README.md -> /b/docs/README.md", "copy /b/y/README.md -> /b/docs/README copy.md",
    ]);
    const skip = planTransfer(req({ sources, op: "copy", clash: "skip" }));
    expect(paths(skip)).toEqual(["copy /b/x/README.md -> /b/docs/README.md"]);
  });

  it("in a mixed selection, skips moves already in place and gives copies free names", () => {
    const sources = [file("/b/docs/a.md"), file("/b/c.md")];
    const existing = new Set(["a.md"]);
    const move = planTransfer(req({ sources, existing, op: "move" }));
    expect(paths(move)).toEqual(["move /b/c.md -> /b/docs/c.md"]);
    expect(move.skipped.map((s) => s.reason)).toEqual(["alreadyThere"]);
    expect(paths(planTransfer(req({ sources, existing, op: "copy" })))).toEqual([
      "copy /b/docs/a.md -> /b/docs/a copy.md", "copy /b/c.md -> /b/docs/c.md",
    ]);
  });

  it("keeps names with spaces, # and % intact", () => {
    const plan = planTransfer(req({ sources: [file("/b/my #1 100%.txt"), file("/b/заметки.md")], op: "copy" }));
    expect(plan.steps.map((s) => s.to.path.base)).toEqual(["my #1 100%.txt", "заметки.md"]);
    expect(plan.steps[0].to.toString()).toBe(u("/b/docs").resolve("my #1 100%.txt").toString());
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: FAIL — cannot resolve `../src/common/transfer-planner`.

- [ ] **Step 3: Implement**

`packages/theia-file-panels/src/common/transfer-planner.ts`:
```ts
import URI from "@theia/core/lib/common/uri";

export interface TransferSource {
  uri: URI;
  isDirectory: boolean;
}
export type TransferOp = "copy" | "move" | "rename";
export type ClashPolicy = "overwrite" | "keepBoth" | "skip";
export interface TransferRequest {
  sources: TransferSource[];
  target: URI;
  /** Names already in the target folder. */
  existing: ReadonlySet<string>;
  op: TransferOp;
  /** The typed name; only for a single source. */
  name?: string;
  clash: ClashPolicy;
  /** " copy" for 1, " copy 2" for 2, …: localized by the caller. */
  copySuffix: (n: number) => string;
}
export interface TransferStep {
  op: "copy" | "move";
  from: URI;
  to: URI;
  overwrite: boolean;
}
export interface SkippedSource {
  uri: URI;
  reason: "clash" | "alreadyThere";
}
export interface TransferPlan {
  steps: TransferStep[];
  skipped: SkippedSource[];
}
export interface DropOptions {
  ops: TransferOp[];
  allInTarget: boolean;
  /** Names of sources from elsewhere that already exist in the target. */
  clashing: string[];
}
export type NameProblem = "empty" | "dots" | "slash";

const nameOf = (source: TransferSource) => source.uri.path.base;
const isIn = (source: TransferSource, folder: URI) => source.uri.parent.isEqual(folder);

/** A source that is the target or one of its ancestors: the drop is impossible. */
export function invalidDrop(sources: TransferSource[], target: URI): TransferSource | undefined {
  return sources.find((source) => source.uri.isEqualOrParent(target));
}

export function dropOptions(
  sources: TransferSource[],
  target: URI,
  existing: ReadonlySet<string>,
): DropOptions {
  const allInTarget = sources.length > 0 && sources.every((s) => isIn(s, target));
  const ops: TransferOp[] = allInTarget
    ? sources.length === 1
      ? ["copy", "rename"]
      : ["copy"]
    : ["copy", "move"];
  const clashing = sources
    .filter((s) => !isIn(s, target) && existing.has(nameOf(s)))
    .map(nameOf);
  return { ops, allInTarget, clashing };
}

export function validateName(name: string): NameProblem | undefined {
  if (name.trim() === "") return "empty";
  if (name === "." || name === "..") return "dots";
  if (name.includes("/")) return "slash";
  return undefined;
}

/** `name` with the copy suffix before its extension (none for folders and dotfiles), counting on. */
export function freeName(
  name: string,
  isDirectory: boolean,
  taken: ReadonlySet<string>,
  copySuffix: (n: number) => string,
): string {
  const dot = isDirectory ? -1 : name.indexOf(".", 1);
  const stem = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let n = 1; ; n++) {
    const candidate = `${stem}${copySuffix(n)}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function planTransfer(request: TransferRequest): TransferPlan {
  const { sources, target, existing, op, clash, copySuffix } = request;
  const steps: TransferStep[] = [];
  const skipped: SkippedSource[] = [];
  /** Names in the target after the steps planned so far. */
  const taken = new Set(existing);
  /** Names this batch writes: never overwritten by a later source. */
  const written = new Set<string>();

  const add = (source: TransferSource, stepOp: "copy" | "move", name: string, overwrite: boolean) => {
    const to = target.resolve(name);
    if (to.isEqual(source.uri)) return;
    steps.push({ op: stepOp, from: source.uri, to, overwrite });
    taken.add(name);
    written.add(name);
  };

  if (op === "rename") {
    const [source] = sources;
    if (source && request.name !== undefined) {
      add(source, "move", request.name, request.name !== nameOf(source) && existing.has(request.name));
    }
    return { steps, skipped };
  }

  if (sources.length === 1 && request.name !== undefined) {
    const [source] = sources;
    add(source, op, request.name, existing.has(request.name) && !isIn(source, target));
    return { steps, skipped };
  }

  for (const source of sources) {
    const name = nameOf(source);
    if (isIn(source, target)) {
      if (op === "move") skipped.push({ uri: source.uri, reason: "alreadyThere" });
      else add(source, "copy", freeName(name, source.isDirectory, taken, copySuffix), false);
      continue;
    }
    if (!taken.has(name)) {
      add(source, op, name, false);
      continue;
    }
    const fromThisBatch = written.has(name);
    if (clash === "skip") skipped.push({ uri: source.uri, reason: "clash" });
    else if (clash === "overwrite" && !fromThisBatch) add(source, op, name, true);
    else add(source, op, freeName(name, source.isDirectory, taken, copySuffix), false);
  }
  return { steps, skipped };
}
```

Add `export * from "./transfer-planner";` to `src/common/index.ts`.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: PASS. If the `#`/`%` test fails, the bug is a string join somewhere — every target URI
must come from `target.resolve(name)`, never from string concatenation.

- [ ] **Step 5: Record, check, commit**

README row `| 3 transfer planning | … | … |`; biome check; then:
```bash
git add apps/theia-shell/packages/theia-file-panels
git commit -m "theia-shell: file panels — transfer planning: free names, clash policies, invalid drops

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Breadcrumb model

**Files:**
- Create: `packages/theia-file-panels/src/common/breadcrumb-model.ts`
- Modify: `packages/theia-file-panels/src/common/index.ts`
- Test: `packages/theia-file-panels/tests/breadcrumb-model.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Crumb { uri: URI; isRoot: boolean }
  type CrumbItem = { kind: "crumb"; crumb: Crumb } | { kind: "more"; hidden: Crumb[] };
  function crumbsOf(current: URI, roots: URI[]): Crumb[]
  function containingRoot(uri: URI, roots: URI[]): URI | undefined
  function collapseCrumbs(crumbs: Crumb[], max: number): CrumbItem[]
  type SiblingSource = { kind: "roots"; roots: URI[] } | { kind: "folder"; parent: URI };
  function siblingSource(crumb: Crumb, roots: URI[]): SiblingSource | undefined
  ```

- [ ] **Step 1: Write the failing tests**

`packages/theia-file-panels/tests/breadcrumb-model.test.ts`:
```ts
import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import {
  collapseCrumbs,
  containingRoot,
  crumbsOf,
  siblingSource,
} from "../src/common/breadcrumb-model";

const u = (path: string) => new URI(`file://${path}`);
const show = (crumbs: { uri: URI; isRoot: boolean }[]) =>
  crumbs.map((c) => `${c.uri.path}${c.isRoot ? "*" : ""}`);

describe("crumbsOf", () => {
  it("starts at the single root file:///", () => {
    expect(show(crumbsOf(u("/browser/notes"), [u("/")]))).toEqual(["/*", "/browser", "/browser/notes"]);
    expect(show(crumbsOf(u("/"), [u("/")]))).toEqual(["/*"]);
  });

  it("starts at the deepest root that contains the folder (mounts as roots)", () => {
    const roots = [u("/browser"), u("/tmp"), u("/browser/inner")];
    expect(show(crumbsOf(u("/browser/inner/x"), roots))).toEqual(["/browser/inner*", "/browser/inner/x"]);
    expect(containingRoot(u("/tmp/a"), roots)?.path.toString()).toBe("/tmp");
  });

  it("falls back to the path root when no root contains the folder", () => {
    expect(show(crumbsOf(u("/elsewhere/a"), [u("/browser")]))).toEqual(["/*", "/elsewhere", "/elsewhere/a"]);
  });
});

describe("collapseCrumbs", () => {
  const crumbs = crumbsOf(u("/a/b/c/d/e"), [u("/")]);
  it("keeps everything that fits", () => {
    expect(collapseCrumbs(crumbs, 6).every((i) => i.kind === "crumb")).toBe(true);
  });
  it("keeps the root and the last ones, hiding the middle behind one item", () => {
    const items = collapseCrumbs(crumbs, 4);
    expect(items.map((i) => (i.kind === "crumb" ? i.crumb.uri.path.toString() : `…${i.hidden.length}`))).toEqual([
      "/", "…3", "/a/b/c/d", "/a/b/c/d/e",
    ]);
  });
});

describe("siblingSource", () => {
  it("lists the other roots for a root crumb and the parent's folders otherwise", () => {
    const roots = [u("/browser"), u("/tmp")];
    const [root, child] = crumbsOf(u("/browser/notes"), roots);
    expect(siblingSource(root, roots)).toEqual({ kind: "roots", roots });
    const source = siblingSource(child, roots);
    expect(source?.kind === "folder" && source.parent.path.toString()).toBe("/browser");
  });

  it("has nothing for the path root when it is not a workspace root", () => {
    const [root] = crumbsOf(u("/elsewhere"), [u("/browser")]);
    expect(siblingSource(root, [u("/browser")])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: FAIL — cannot resolve `../src/common/breadcrumb-model`.

- [ ] **Step 3: Implement**

`packages/theia-file-panels/src/common/breadcrumb-model.ts`:
```ts
import URI from "@theia/core/lib/common/uri";

export interface Crumb {
  uri: URI;
  /** The first crumb: a workspace root, or the path root when no root contains the folder. */
  isRoot: boolean;
}
export type CrumbItem = { kind: "crumb"; crumb: Crumb } | { kind: "more"; hidden: Crumb[] };
export type SiblingSource = { kind: "roots"; roots: URI[] } | { kind: "folder"; parent: URI };

/** The deepest workspace root that is `uri` or one of its ancestors. */
export function containingRoot(uri: URI, roots: URI[]): URI | undefined {
  return roots
    .filter((root) => root.isEqualOrParent(uri))
    .sort((a, b) => b.path.toString().length - a.path.toString().length)[0];
}

export function crumbsOf(current: URI, roots: URI[]): Crumb[] {
  const start = containingRoot(current, roots) ?? current.withPath("/");
  const chain: URI[] = [];
  for (let uri = current; ; uri = uri.parent) {
    chain.unshift(uri);
    if (uri.isEqual(start) || uri.path.isRoot) break;
  }
  return chain.map((uri, i) => ({ uri, isRoot: i === 0 }));
}

/** At most `max` items: the root, a "more" item with the hidden middle, and the last crumbs. */
export function collapseCrumbs(crumbs: Crumb[], max: number): CrumbItem[] {
  if (crumbs.length <= max) return crumbs.map((crumb) => ({ kind: "crumb", crumb }));
  const tail = crumbs.slice(crumbs.length - (max - 2));
  return [
    { kind: "crumb", crumb: crumbs[0] },
    { kind: "more", hidden: crumbs.slice(1, crumbs.length - tail.length) },
    ...tail.map((crumb): CrumbItem => ({ kind: "crumb", crumb })),
  ];
}

/** Where the ▾ of a crumb takes its list from; undefined when it has no siblings to show. */
export function siblingSource(crumb: Crumb, roots: URI[]): SiblingSource | undefined {
  if (crumb.isRoot) {
    return roots.some((root) => root.isEqual(crumb.uri)) ? { kind: "roots", roots } : undefined;
  }
  return { kind: "folder", parent: crumb.uri.parent };
}
```

Add `export * from "./breadcrumb-model";` to `src/common/index.ts`.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: PASS.

- [ ] **Step 5: Record, check, commit**

README row; biome; then:
```bash
git add apps/theia-shell/packages/theia-file-panels
git commit -m "theia-shell: file panels — breadcrumb segments, collapsing and sibling sources

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Running a plan

**Files:**
- Create: `packages/theia-file-panels/src/common/transfer-runner.ts`
- Modify: `packages/theia-file-panels/src/common/index.ts`
- Test: `packages/theia-file-panels/tests/transfer-runner.test.ts`

**Interfaces:**
- Consumes: `TransferPlan`, `TransferStep` (Task 3).
- Produces:
  ```ts
  interface TransferOps {
    copy(from: URI, to: URI, overwrite: boolean): Promise<unknown>;
    move(from: URI, to: URI, overwrite: boolean): Promise<unknown>;
  }
  interface StepFailure { step: TransferStep; message: string }
  interface TransferOutcome { done: URI[]; failures: StepFailure[]; cancelled: boolean }
  function runPlan(plan: TransferPlan, ops: TransferOps, options?: {
    isCancelled?: () => boolean; onStep?: (index: number, total: number) => void;
  }): Promise<TransferOutcome>
  ```

- [ ] **Step 1: Write the failing tests**

`packages/theia-file-panels/tests/transfer-runner.test.ts`:
```ts
import URI from "@theia/core/lib/common/uri";
import { describe, expect, it } from "vitest";
import type { TransferPlan } from "../src/common/transfer-planner";
import { runPlan, type TransferOps } from "../src/common/transfer-runner";

const u = (p: string) => new URI(`file://${p}`);
const plan: TransferPlan = {
  steps: [
    { op: "copy", from: u("/a/1"), to: u("/b/1"), overwrite: false },
    { op: "move", from: u("/a/2"), to: u("/"), overwrite: false },
    { op: "move", from: u("/a/3"), to: u("/b/3"), overwrite: true },
  ],
  skipped: [],
};

function recorder(failOn?: string): { ops: TransferOps; log: string[] } {
  const log: string[] = [];
  const run = (op: string) => async (from: URI, to: URI, overwrite: boolean) => {
    if (to.path.toString() === failOn) throw new Error(`read-only: ${to.path}`);
    log.push(`${op} ${from.path} ${to.path} ${overwrite}`);
  };
  return { ops: { copy: run("copy"), move: run("move") }, log };
}

describe("runPlan", () => {
  it("runs every step in order with its overwrite flag", async () => {
    const { ops, log } = recorder();
    const outcome = await runPlan(plan, ops);
    expect(log).toEqual(["copy /a/1 /b/1 false", "move /a/2 / false", "move /a/3 /b/3 true"]);
    expect(outcome.done.map((d) => d.path.toString())).toEqual(["/b/1", "/", "/b/3"]);
    expect(outcome.failures).toEqual([]);
  });

  it("keeps going after a failing step and reports it", async () => {
    const { ops, log } = recorder("/");
    const outcome = await runPlan(plan, ops);
    expect(log).toHaveLength(2);
    expect(outcome.failures.map((f) => f.message)).toEqual(["read-only: /"]);
    expect(outcome.done).toHaveLength(2);
  });

  it("stops between steps when cancelled, and reports progress", async () => {
    const { ops, log } = recorder();
    const seen: string[] = [];
    let calls = 0;
    const outcome = await runPlan(plan, ops, {
      isCancelled: () => ++calls > 1,
      onStep: (i, total) => seen.push(`${i}/${total}`),
    });
    expect(log).toHaveLength(1);
    expect(outcome.cancelled).toBe(true);
    expect(seen).toEqual(["0/3"]);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: FAIL — cannot resolve `../src/common/transfer-runner`.

- [ ] **Step 3: Implement**

`packages/theia-file-panels/src/common/transfer-runner.ts`:
```ts
import type URI from "@theia/core/lib/common/uri";
import type { TransferPlan, TransferStep } from "./transfer-planner";

export interface TransferOps {
  copy(from: URI, to: URI, overwrite: boolean): Promise<unknown>;
  move(from: URI, to: URI, overwrite: boolean): Promise<unknown>;
}
export interface StepFailure {
  step: TransferStep;
  message: string;
}
export interface TransferOutcome {
  done: URI[];
  failures: StepFailure[];
  cancelled: boolean;
}

/** Runs the steps in order; a failing step is recorded and the rest still run. No rollback. */
export async function runPlan(
  plan: TransferPlan,
  ops: TransferOps,
  options: { isCancelled?: () => boolean; onStep?: (index: number, total: number) => void } = {},
): Promise<TransferOutcome> {
  const outcome: TransferOutcome = { done: [], failures: [], cancelled: false };
  const total = plan.steps.length;
  for (const [index, step] of plan.steps.entries()) {
    if (options.isCancelled?.()) {
      outcome.cancelled = true;
      break;
    }
    options.onStep?.(index, total);
    try {
      await ops[step.op](step.from, step.to, step.overwrite);
      outcome.done.push(step.to);
    } catch (error) {
      outcome.failures.push({ step, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}
```

Add `export * from "./transfer-runner";` to `src/common/index.ts`.

- [ ] **Step 4: Run to see it pass**

Run: `pnpm --filter @theia-shell/theia-file-panels test`
Expected: PASS.

- [ ] **Step 5: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels
git commit -m "theia-shell: file panels — run a transfer plan, failures collected, cancellable

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The panel — listing, columns, navigation, opening files

**Files:**
- Create: `packages/theia-file-panels/src/browser/file-panel-tree.ts` (tree + model)
- Create: `packages/theia-file-panels/src/browser/file-panel-tree-widget.tsx`
- Create: `packages/theia-file-panels/src/browser/file-panel-header.tsx`
- Create: `packages/theia-file-panels/src/browser/file-panel-widget.ts`
- Create: `packages/theia-file-panels/src/browser/file-panels-contribution.ts`
- Modify: `packages/theia-file-panels/src/browser/file-panels-frontend-module.ts`
- Modify: `packages/theia-file-panels/src/browser/style/file-panels.css`
- Test: `app/tests/file-panels.spec.ts`

**Interfaces:**
- Consumes: `Messages`, `formatSize`, `formatDate`, `currentLocale` (Task 1); `SortState`,
  `DEFAULT_SORT`, `compareEntries`, `toggleSort` (Task 2).
- Produces:
  - `FilePanelTree extends FileTree` — `sort: SortState`; `listingError: string | undefined`;
    `onDidChangeListingError: Event<void>`.
  - `FilePanelModel extends FileTreeModel` — `navigateToFolder(uri: URI): Promise<void>`;
    `onDidNavigate: Event<URI>`; `location` (inherited getter) is the current folder.
  - `FilePanelTreeWidget extends FileTreeWidget` — `readonly model: FilePanelModel`;
    `onGoUp: Emitter<void>` (fired on Backspace).
  - `FilePanelWidget extends BaseWidget` — `static FACTORY_ID = "file-panel"`;
    `readonly tree: FilePanelTreeWidget`; `get folder(): URI | undefined`;
    `navigateTo(uri: URI): Promise<void>`; `goUp(): Promise<void>`; `refresh(): Promise<void>`;
    `setSort(state: SortState): void`; `sort: SortState`.
  - `FilePanelOptions { id: string; folder?: string }` (DI symbol `FilePanelOptions`).
  - `createFilePanelWidget(parent: interfaces.Container, options: FilePanelOptions): FilePanelWidget`.
  - `FilePanelsContribution` — commands `FilePanelsCommands.OPEN`, `GO_UP`, `REFRESH`;
    `openPanel(folder?: URI): Promise<FilePanelWidget>`; `get panels(): FilePanelWidget[]`.
  - `FILE_PANEL_CONTEXT_MENU: MenuPath = ["file-panel-context-menu"]`.
  - E2E helpers in `app/tests/file-panels.spec.ts`: `panels(page)`, `openPanel(page)`,
    `row(panel, name)`.

Signature notes (Theia 1.76, all public or protected): `FileTreeWidget(props, model,
contextMenuRenderer)`; `FileTree.resolveFileStat(node)` and `toNodes(fileStat, parent)` are
protected; `TreeModelImpl.doOpenNode(node)` is protected; `TreeWidget.renderExpansionToggle`,
`renderTailDecorations`, `getPaddingLeft`, `handleRight` are protected; `BaseWidget.addKeyListener`
is protected; `FileTreeModel.fileService` is protected; `DirNode.createRoot(stat)` is public. If
the compiler disagrees with a signature written here, adapt to the `.d.ts` and note it in the
README.

- [ ] **Step 1: Write the failing e2e test**

`app/tests/file-panels.spec.ts`:
```ts
import { expect, type Locator, type Page, test } from "@playwright/test";
import { runFromPalette, start } from "./helpers";

export const panels = (page: Page) => page.locator(".file-panel");
export const row = (panel: Locator, name: string) =>
  panel.locator(".theia-TreeNode").filter({ has: panel.page().getByText(name, { exact: true }) });

export async function openPanel(page: Page) {
  const before = await panels(page).count();
  await runFromPalette(page, "Open Files Panel");
  await expect(panels(page)).toHaveCount(before + 1);
  return panels(page).last();
}

test("a panel lists a folder flat, navigates into folders and back up", async ({ page }) => {
  const errors = await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await expect(row(panel, "Browser Storage")).toBeVisible();
  await row(panel, "Browser Storage").dblclick();
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(row(panel, "notes")).toBeVisible();
  await row(panel, "notes").dblclick();
  await expect(row(panel, "ideas.md")).toBeVisible();
  await expect(row(panel, "welcome.md")).toHaveCount(0);
  // Backspace goes up (tree-local key, not a keybinding).
  await row(panel, "ideas.md").click();
  await page.keyboard.press("Backspace");
  await expect(row(panel, "welcome.md")).toBeVisible();
  // Folders never expand in place.
  await expect(panel.locator(".theia-ExpansionToggle")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the panel shows size and date columns and sorts by clicking a header", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "docs").dblclick();
  await expect(row(panel, "sample.pdf").locator(".file-panel-size")).not.toHaveText("");
  const order = () => panel.locator(".theia-TreeNode .theia-TreeNodeSegmentGrow").allTextContents();
  await expect.poll(order).toEqual(["cheatsheet.md", "sample.pdf"]);
  await panel.locator(".file-panel-column", { hasText: "Name" }).click();
  await expect.poll(order).toEqual(["sample.pdf", "cheatsheet.md"]);
});

test("a file opens from the panel, and an empty folder says so", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "welcome.md").dblclick();
  await expect(page.locator(".theia-editor .monaco-editor").last()).toBeVisible();
  await page.evaluate(async () => {
    const files = (window as unknown as { theiaShell: { filesApi: { mkdir(p: string): Promise<void> } } }).theiaShell.filesApi;
    await files.mkdir("/browser/empty");
  });
  await panel.click();
  await runFromPalette(page, "Refresh");
  await row(panel, "empty").dblclick();
  await expect(panel.getByText("This folder is empty")).toBeVisible();
});
```

If `FilesApi.mkdir` is not the method name in `@statewalker/webrun-files` 0.10.0, use the one it
has (check `node_modules/@statewalker/webrun-files/dist/*.d.ts`); the test needs an empty folder,
created outside the panel.

- [ ] **Step 2: Build and run to see it fail**

Run:
```bash
pnpm --filter @theia-shell/app build
cd app && pnpm exec playwright test tests/file-panels.spec.ts; cd ..
```
Expected: FAIL — "Open Files Panel" is not in the command palette.

- [ ] **Step 3: Tree and model**

`packages/theia-file-panels/src/browser/file-panel-tree.ts`:
```ts
import { open, OpenerService } from "@theia/core/lib/browser/opener-service";
import type { CompositeTreeNode, TreeNode } from "@theia/core/lib/browser/tree/tree";
import { Emitter } from "@theia/core/lib/common/event";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { DirNode, FileNode, FileStatNode, FileTree, FileTreeModel } from "@theia/filesystem/lib/browser/file-tree";
import type { FileStat } from "@theia/filesystem/lib/common/files";
import { DEFAULT_SORT, compareEntries, type SortState } from "../common/panel-sorting";

/** One folder, flat: children carry size and date, and are sorted by the panel's sort. */
@injectable()
export class FilePanelTree extends FileTree {
  sort: SortState = DEFAULT_SORT;
  listingError: string | undefined;
  protected readonly onDidChangeListingErrorEmitter = new Emitter<void>();
  readonly onDidChangeListingError = this.onDidChangeListingErrorEmitter.event;

  protected override async resolveFileStat(node: FileStatNode): Promise<FileStat | undefined> {
    try {
      const stat = await this.fileService.resolve(node.uri, { resolveMetadata: true });
      node.fileStat = stat;
      this.setListingError(undefined);
      return stat;
    } catch (error) {
      this.setListingError(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  protected override async toNodes(fileStat: FileStat, parent: CompositeTreeNode): Promise<TreeNode[]> {
    const nodes = await super.toNodes(fileStat, parent);
    const compare = compareEntries(this.sort);
    const entry = (node: TreeNode) => {
      const stat = (node as FileStatNode).fileStat;
      return { name: stat.name, isDirectory: stat.isDirectory, size: stat.size, mtime: stat.mtime };
    };
    return nodes.sort((a, b) => compare(entry(a), entry(b)));
  }

  protected setListingError(message: string | undefined): void {
    if (message === this.listingError) return;
    this.listingError = message;
    this.onDidChangeListingErrorEmitter.fire();
  }
}

/** Opening a folder navigates the panel into it; opening a file opens it like the explorer does. */
@injectable()
export class FilePanelModel extends FileTreeModel {
  @inject(OpenerService) protected readonly openerService!: OpenerService;
  protected readonly onDidNavigateEmitter = new Emitter<URI>();
  readonly onDidNavigate = this.onDidNavigateEmitter.event;
  /** Bumped by every navigation, so a slower, older listing never replaces a newer one. */
  protected navigations = 0;

  async navigateToFolder(uri: URI): Promise<void> {
    const ticket = ++this.navigations;
    const stat = await this.fileService.resolve(uri);
    if (ticket !== this.navigations) return;
    await this.navigateTo({ ...DirNode.createRoot(stat), visible: false });
    this.onDidNavigateEmitter.fire(uri);
  }

  protected override doOpenNode(node: TreeNode): void {
    if (DirNode.is(node)) void this.navigateToFolder(node.uri);
    else if (FileNode.is(node)) void open(this.openerService, node.uri);
    else super.doOpenNode(node);
  }
}
```

- [ ] **Step 4: The tree widget (flat rows, columns, Backspace)**

`packages/theia-file-panels/src/browser/file-panel-tree-widget.tsx`:
```tsx
import { ContextMenuRenderer } from "@theia/core/lib/browser/context-menu-renderer";
import { Key } from "@theia/core/lib/browser/keyboard/keys";
import type { NodeProps, TreeNode } from "@theia/core/lib/browser/tree/tree";
import { TreeModel } from "@theia/core/lib/browser/tree/tree-model";
import { TreeProps } from "@theia/core/lib/browser/tree/tree-widget";
import { Emitter } from "@theia/core/lib/common/event";
import * as React from "@theia/core/shared/react";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileStatNode, FileTreeWidget } from "@theia/filesystem/lib/browser/file-tree";
import { formatDate, formatSize } from "../common/format";
import { FilePanelModel } from "./file-panel-tree";

@injectable()
export class FilePanelTreeWidget extends FileTreeWidget {
  readonly onGoUp = new Emitter<void>();

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) override readonly model: FilePanelModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer);
    this.addClass("file-panel-tree");
    this.toDispose.push(this.onGoUp);
  }

  protected override init(): void {
    super.init();
    this.addKeyListener(this.node, Key.BACKSPACE, () => this.onGoUp.fire());
  }

  /** Folders never expand: opening one navigates (FilePanelModel.doOpenNode). */
  protected override renderExpansionToggle(): React.ReactNode {
    return null;
  }

  protected override async handleRight(): Promise<void> {}

  protected override getPaddingLeft(): number {
    return 4;
  }

  protected override renderTailDecorations(node: TreeNode, props: NodeProps): React.ReactNode {
    const decorations = super.renderTailDecorations(node, props);
    if (!FileStatNode.is(node)) return decorations;
    const { fileStat } = node;
    return (
      <>
        {decorations}
        <span className="file-panel-cell file-panel-size">
          {fileStat.isDirectory || fileStat.size === undefined ? "" : formatSize(fileStat.size)}
        </span>
        <span className="file-panel-cell file-panel-modified">
          {fileStat.mtime ? formatDate(fileStat.mtime) : ""}
        </span>
      </>
    );
  }
}
```

If `init` is not overridable here (it is `@postConstruct` in `TreeWidget`), add the key listener in
an `onAfterAttach` override instead — `addKeyListener` registers into `toDisposeOnDetach`, so
`onAfterAttach` is the right place in that case.

- [ ] **Step 5: The header (column headings, status line)**

`packages/theia-file-panels/src/browser/file-panel-header.tsx`:
```tsx
import { ReactWidget } from "@theia/core/lib/browser/widgets/react-widget";
import * as React from "@theia/core/shared/react";
import { Messages } from "../common/file-panels-nls";
import type { SortColumn, SortState } from "../common/panel-sorting";

export interface FilePanelHeaderState {
  sort: SortState;
  /** A short notice (folder gone, …) or an error, shown under the headings. */
  status?: { text: string; retry?: () => void };
  /** Rendered above the headings; the breadcrumb (Task 7). */
  breadcrumb?: React.ReactNode;
}

export class FilePanelHeader extends ReactWidget {
  state: FilePanelHeaderState;

  constructor(
    initial: FilePanelHeaderState,
    protected readonly onSort: (column: SortColumn) => void,
  ) {
    super();
    this.state = initial;
    this.addClass("file-panel-header");
  }

  setState(patch: Partial<FilePanelHeaderState>): void {
    this.state = { ...this.state, ...patch };
    this.update();
  }

  protected render(): React.ReactNode {
    const { sort, status, breadcrumb } = this.state;
    const column = (id: SortColumn, label: string, className: string) => (
      <button
        type="button"
        className={`file-panel-column ${className}`}
        aria-sort={sort.column === id ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
        onClick={() => this.onSort(id)}
      >
        {label}
        {sort.column === id && <span className={`file-panel-sort-mark ${sort.direction}`} />}
      </button>
    );
    return (
      <>
        {breadcrumb}
        <div className="file-panel-columns">
          {column("name", Messages.columnName(), "file-panel-name")}
          {column("size", Messages.columnSize(), "file-panel-size")}
          {column("modified", Messages.columnModified(), "file-panel-modified")}
        </div>
        {status && (
          <div className="file-panel-status" role="status">
            {status.text}
            {status.retry && (
              <button type="button" className="theia-button secondary" onClick={status.retry}>
                {Messages.retry()}
              </button>
            )}
          </div>
        )}
      </>
    );
  }
}
```

- [ ] **Step 6: The panel widget and its container**

`packages/theia-file-panels/src/browser/file-panel-widget.ts`:
```ts
import { BaseWidget, type Message } from "@theia/core/lib/browser/widgets/widget";
import { LabelProvider } from "@theia/core/lib/browser/label-provider";
import { Widget } from "@theia/core/shared/@lumino/widgets";
import URI from "@theia/core/lib/common/uri";
import { type interfaces, inject, injectable } from "@theia/core/shared/inversify";
import { PanelLayout } from "@theia/core/shared/@lumino/widgets";
import { createFileTreeContainer } from "@theia/filesystem/lib/browser/file-tree";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";
import { Messages } from "../common/file-panels-nls";
import { DEFAULT_SORT, type SortState, toggleSort } from "../common/panel-sorting";
import { FilePanelHeader } from "./file-panel-header";
import { FilePanelModel, FilePanelTree } from "./file-panel-tree";
import { FilePanelTreeWidget } from "./file-panel-tree-widget";

export const FILE_PANEL_CONTEXT_MENU = ["file-panel-context-menu"];

export const FilePanelOptions = Symbol("FilePanelOptions");
export interface FilePanelOptions {
  id: string;
  folder?: string;
}

/** One file panel: header (breadcrumb, column headings, status) over a flat file tree. */
@injectable()
export class FilePanelWidget extends BaseWidget {
  static readonly FACTORY_ID = "file-panel";

  @inject(FilePanelOptions) protected readonly options!: FilePanelOptions;
  @inject(FilePanelTreeWidget) readonly tree!: FilePanelTreeWidget;
  @inject(FilePanelTree) protected readonly fileTree!: FilePanelTree;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(LabelProvider) protected readonly labels!: LabelProvider;

  protected header!: FilePanelHeader;

  get model(): FilePanelModel {
    return this.tree.model;
  }

  get folder(): URI | undefined {
    return this.model.location;
  }

  get sort(): SortState {
    return this.fileTree.sort;
  }

  async initialize(): Promise<void> {
    this.id = this.options.id;
    this.title.closable = true;
    this.title.iconClass = "codicon codicon-folder";
    this.addClass("file-panel");
    this.header = new FilePanelHeader({ sort: this.sort }, (column) =>
      this.setSort(toggleSort(this.sort, column)),
    );
    const layout = new PanelLayout();
    layout.addWidget(this.header);
    layout.addWidget(this.tree);
    this.layout = layout;

    this.toDispose.pushAll([
      this.header,
      this.tree,
      this.tree.onGoUp.event(() => void this.goUp()),
      this.model.onDidNavigate((uri) => this.onNavigated(uri)),
      this.model.onChanged(() => this.updateEmptyState()),
      this.fileTree.onDidChangeListingError(() => this.updateEmptyState()),
    ]);
    const start = this.options.folder ? new URI(this.options.folder) : await this.defaultFolder();
    await this.navigateTo(start);
  }

  async navigateTo(uri: URI): Promise<void> {
    await this.model.navigateToFolder(uri);
  }

  async goUp(): Promise<void> {
    const folder = this.folder;
    if (folder && !folder.path.isRoot) await this.navigateTo(folder.parent);
  }

  async refresh(): Promise<void> {
    await this.model.refresh();
  }

  setSort(state: SortState): void {
    this.fileTree.sort = state;
    this.header.setState({ sort: state });
    void this.model.refresh();
  }

  protected async defaultFolder(): Promise<URI> {
    const [first] = await this.workspace.roots;
    return first ? first.resource : new URI("file:///");
  }

  protected onNavigated(uri: URI): void {
    this.title.label = this.labels.getName(uri);
    this.title.caption = this.labels.getLongName(uri);
    this.updateEmptyState();
  }

  protected updateEmptyState(): void {
    const error = this.fileTree.listingError;
    const root = this.model.root;
    const empty = !error && root && "children" in root && (root.children as unknown[]).length === 0;
    this.header.setState({
      status: error
        ? { text: Messages.notAvailable(this.title.label, error), retry: () => void this.refresh() }
        : empty
          ? { text: Messages.emptyFolder() }
          : undefined,
    });
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.tree.activate();
  }

  protected override onResize(msg: Widget.ResizeMessage): void {
    super.onResize(msg);
    this.tree.update();
  }
}

/** A child container per panel: Theia's file-tree container with the panel's classes. */
export function createFilePanelWidget(
  parent: interfaces.Container,
  options: FilePanelOptions,
): FilePanelWidget {
  const child = createFileTreeContainer(parent, {
    tree: FilePanelTree,
    model: FilePanelModel,
    widget: FilePanelTreeWidget,
    props: {
      contextMenuPath: FILE_PANEL_CONTEXT_MENU,
      multiSelect: true,
      search: true,
      globalSelection: true,
      expandOnlyOnExpansionToggleClick: true,
      virtualized: true,
    },
  });
  child.bind(FilePanelOptions).toConstantValue(options);
  child.bind(FilePanelWidget).toSelf();
  return child.get(FilePanelWidget);
}
```

- [ ] **Step 7: The contribution (open, go up, refresh) and the module**

`packages/theia-file-panels/src/browser/file-panels-contribution.ts`:
```ts
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import type { TabBarToolbarContribution, TabBarToolbarRegistry } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetManager } from "@theia/core/lib/browser/widget-manager";
import { CommonMenus } from "@theia/core/lib/browser";
import type { Command, CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import type { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import type URI from "@theia/core/lib/common/uri";
import { generateUuid } from "@theia/core/lib/common/uuid";
import { inject, injectable } from "@theia/core/shared/inversify";
import { Messages } from "../common/file-panels-nls";
import { type FilePanelOptions, FilePanelWidget } from "./file-panel-widget";

export namespace FilePanelsCommands {
  export const OPEN: Command = { id: "file-panels.open" };
  export const GO_UP: Command = { id: "file-panels.goUp" };
  export const REFRESH: Command = { id: "file-panels.refresh" };
}

@injectable()
export class FilePanelsContribution
  implements CommandContribution, MenuContribution, TabBarToolbarContribution
{
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(WidgetManager) protected readonly widgets!: WidgetManager;

  get panels(): FilePanelWidget[] {
    return this.widgets.getWidgets(FilePanelWidget.FACTORY_ID) as FilePanelWidget[];
  }

  /** The panel the user is in: the current widget when it is a panel. */
  get currentPanel(): FilePanelWidget | undefined {
    const current = this.shell.currentWidget;
    return current instanceof FilePanelWidget ? current : undefined;
  }

  async openPanel(folder?: URI): Promise<FilePanelWidget> {
    const beside = this.currentPanel;
    const options: FilePanelOptions = { id: `file-panel:${generateUuid()}`, folder: folder?.toString() };
    const panel = await this.widgets.getOrCreateWidget<FilePanelWidget>(FilePanelWidget.FACTORY_ID, options);
    await this.shell.addWidget(panel, beside ? { area: "main", ref: beside, mode: "split-right" } : { area: "main" });
    await this.shell.activateWidget(panel.id);
    return panel;
  }

  registerCommands(registry: CommandRegistry): void {
    const category = Messages.category();
    registry.registerCommand(
      { ...FilePanelsCommands.OPEN, label: Messages.openFilesPanel(), category },
      { execute: () => this.openPanel() },
    );
    registry.registerCommand(
      { ...FilePanelsCommands.GO_UP, label: Messages.goUp(), category, iconClass: "codicon codicon-arrow-up" },
      {
        execute: () => this.currentPanel?.goUp(),
        isEnabled: () => !!this.currentPanel?.folder && !this.currentPanel.folder.path.isRoot,
        isVisible: (widget?: unknown) => widget instanceof FilePanelWidget || !!this.currentPanel,
      },
    );
    registry.registerCommand(
      { ...FilePanelsCommands.REFRESH, label: Messages.refresh(), category, iconClass: "codicon codicon-refresh" },
      {
        execute: () => this.currentPanel?.refresh(),
        isEnabled: () => !!this.currentPanel,
        isVisible: (widget?: unknown) => widget instanceof FilePanelWidget || !!this.currentPanel,
      },
    );
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
      commandId: FilePanelsCommands.OPEN.id,
      label: Messages.openFilesPanel(),
    });
  }

  registerToolbarItems(toolbar: TabBarToolbarRegistry): void {
    toolbar.registerItem({
      id: FilePanelsCommands.GO_UP.id,
      command: FilePanelsCommands.GO_UP.id,
      tooltip: Messages.goUp(),
      isVisible: (widget) => widget instanceof FilePanelWidget,
    });
    toolbar.registerItem({
      id: FilePanelsCommands.REFRESH.id,
      command: FilePanelsCommands.REFRESH.id,
      tooltip: Messages.refresh(),
      isVisible: (widget) => widget instanceof FilePanelWidget,
    });
  }
}
```

`packages/theia-file-panels/src/browser/file-panels-frontend-module.ts`:
```ts
import "../../src/browser/style/file-panels.css";
import { TabBarToolbarContribution } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { WidgetFactory } from "@theia/core/lib/browser/widget-manager";
import { CommandContribution } from "@theia/core/lib/common/command";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { FilePanelsContribution } from "./file-panels-contribution";
import { createFilePanelWidget, type FilePanelOptions, FilePanelWidget } from "./file-panel-widget";

export default new ContainerModule((bind) => {
  bind(FilePanelsContribution).toSelf().inSingletonScope();
  for (const service of [CommandContribution, MenuContribution, TabBarToolbarContribution]) {
    bind(service).toService(FilePanelsContribution);
  }
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: FilePanelWidget.FACTORY_ID,
      createWidget: async (options: FilePanelOptions) => {
        const widget = createFilePanelWidget(container, options);
        await widget.initialize();
        return widget;
      },
    }))
    .inSingletonScope();
});
```

- [ ] **Step 8: Styles**

`packages/theia-file-panels/src/browser/style/file-panels.css`:
```css
/* File panels. Logical properties only, so right-to-left layouts mirror. */
.file-panel {
  display: flex;
  flex-direction: column;
  background: var(--theia-editor-background);
}
.file-panel > .file-panel-tree {
  flex: 1 1 auto;
  min-block-size: 0;
}
.file-panel-header {
  flex: none;
  border-block-end: 1px solid var(--theia-panel-border);
}
.file-panel-columns,
.file-panel-tree .theia-TreeNodeContent {
  display: flex;
  align-items: center;
}
.file-panel-columns {
  padding-inline: 4px;
  font-size: var(--theia-ui-font-size0);
  color: var(--theia-descriptionForeground);
}
.file-panel-column {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  text-align: start;
  padding-block: 2px;
  padding-inline: 4px;
}
.file-panel-column.file-panel-name {
  flex: 1 1 auto;
}
.file-panel-size,
.file-panel-modified {
  flex: none;
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.file-panel-size {
  inline-size: 7em;
}
.file-panel-modified {
  inline-size: 11em;
  padding-inline-start: 8px;
}
.file-panel-cell {
  color: var(--theia-descriptionForeground);
}
.file-panel-sort-mark::after {
  content: "";
  display: inline-block;
  margin-inline-start: 4px;
  border-inline: 4px solid transparent;
}
.file-panel-sort-mark.asc::after {
  border-block-end: 5px solid currentColor;
}
.file-panel-sort-mark.desc::after {
  border-block-start: 5px solid currentColor;
}
.file-panel-status {
  padding-block: 4px;
  padding-inline: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
```

- [ ] **Step 9: Build and run to see it pass**

Run:
```bash
pnpm --filter @theia-shell/app build
cd app && pnpm exec playwright test tests/file-panels.spec.ts; cd ..
```
Expected: 3 passed. If the size column is misaligned with its heading, adjust only
`.file-panel-size` / `.file-panel-modified` widths — the heading and the cells share them.

- [ ] **Step 10: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — a flat, sortable folder view with size and date columns

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Breadcrumb with sibling-folder dropdowns

**Files:**
- Create: `packages/theia-file-panels/src/browser/folder-breadcrumb.tsx`
- Modify: `packages/theia-file-panels/src/browser/file-panel-widget.ts`
- Modify: `packages/theia-file-panels/src/browser/style/file-panels.css`
- Test: `app/tests/file-panels.spec.ts` (append)

**Interfaces:**
- Consumes: `crumbsOf`, `collapseCrumbs`, `siblingSource`, `Crumb` (Task 4); `compareEntries`
  (Task 2); `Messages` (Task 1); `FilePanelWidget.navigateTo`, `.folder` (Task 6).
- Produces:
  - `interface FolderBreadcrumbProps { current: URI; roots: URI[]; labels: LabelProvider;
    navigate(uri: URI): void; openSiblings(crumb: Crumb, anchor: HTMLElement): void;
    onDropOnCrumb?(uri: URI, event: React.DragEvent): void }`
  - `function FolderBreadcrumb(props): JSX.Element`
  - `FilePanelWidget.openSiblings(crumb: Crumb, anchor: HTMLElement): Promise<void>`
  - DOM hooks for tests: `.file-panel-crumb` (with `data-uri`), `.file-panel-crumb-toggle`,
    `.file-panel-more`, `.file-panel-siblings` (list), `.file-panel-sibling` (item, `.current`).

- [ ] **Step 1: Write the failing e2e tests**

Append to `app/tests/file-panels.spec.ts`:
```ts
const crumb = (panel: Locator, label: string) => panel.locator(".file-panel-crumb", { hasText: label });

test("the breadcrumb navigates to an ancestor", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await expect(crumb(panel, "notes")).toBeVisible();
  await crumb(panel, "Browser Storage").locator(".file-panel-crumb-label").click();
  await expect(row(panel, "welcome.md")).toBeVisible();
});

test("a crumb's dropdown lists its sibling folders and jumps to one", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await crumb(panel, "notes").locator(".file-panel-crumb-toggle").click();
  const list = page.locator(".file-panel-siblings");
  await expect(list.locator(".file-panel-sibling")).toHaveText(["docs", "media", "notes"]);
  await expect(list.locator(".file-panel-sibling.current")).toHaveText("notes");
  await list.locator(".file-panel-sibling", { hasText: "docs" }).click();
  await expect(row(panel, "cheatsheet.md")).toBeVisible();
  await expect(list).toHaveCount(0);
});

test("the first crumb's dropdown lists the workspace roots", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await panel.locator(".file-panel-crumb").first().locator(".file-panel-crumb-toggle").click();
  await expect(page.locator(".file-panel-siblings .file-panel-sibling")).toHaveText(["Files"]);
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-panel-siblings")).toHaveCount(0);
});
```

The last test asserts one root today. When `feat/theia-shell-mount-roots` lands, it lists every
mount; update the expectation then (Risks in the spec).

- [ ] **Step 2: Build and run to see them fail**

Run: `pnpm --filter @theia-shell/app build && (cd app && pnpm exec playwright test tests/file-panels.spec.ts)`
Expected: the three new tests FAIL (no `.file-panel-crumb`); the earlier three pass.

- [ ] **Step 3: The breadcrumb component**

`packages/theia-file-panels/src/browser/folder-breadcrumb.tsx`:
```tsx
import type { LabelProvider } from "@theia/core/lib/browser/label-provider";
import type URI from "@theia/core/lib/common/uri";
import * as React from "@theia/core/shared/react";
import { type Crumb, collapseCrumbs, crumbsOf, siblingSource } from "../common/breadcrumb-model";
import { Messages } from "../common/file-panels-nls";

export interface FolderBreadcrumbProps {
  current: URI;
  roots: URI[];
  labels: LabelProvider;
  navigate(uri: URI): void;
  openSiblings(crumb: Crumb, anchor: HTMLElement): void;
  openHidden(hidden: Crumb[], anchor: HTMLElement): void;
  onDropOnCrumb?(uri: URI, event: React.DragEvent): void;
}

const MAX_CRUMBS = 5;

export function FolderBreadcrumb(props: FolderBreadcrumbProps): React.ReactElement {
  const { current, roots, labels } = props;
  const items = collapseCrumbs(crumbsOf(current, roots), MAX_CRUMBS);
  return (
    <nav className="file-panel-breadcrumb">
      {items.map((item) => {
        if (item.kind === "more") {
          return (
            <button
              key="more"
              type="button"
              className="file-panel-more"
              title={Messages.hiddenFolders()}
              onClick={(e) => props.openHidden(item.hidden, e.currentTarget)}
            >
              …
            </button>
          );
        }
        const { crumb } = item;
        const name = labels.getName(crumb.uri);
        const hasSiblings = siblingSource(crumb, roots) !== undefined;
        return (
          <span
            key={crumb.uri.toString()}
            className="file-panel-crumb"
            data-uri={crumb.uri.toString()}
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => props.onDropOnCrumb?.(crumb.uri, e)}
          >
            <button type="button" className="file-panel-crumb-label" onClick={() => props.navigate(crumb.uri)}>
              {name}
            </button>
            {hasSiblings && (
              <button
                type="button"
                className="file-panel-crumb-toggle codicon codicon-chevron-down"
                title={Messages.siblingsOf(name)}
                onClick={(e) => props.openSiblings(crumb, e.currentTarget)}
              />
            )}
          </span>
        );
      })}
    </nav>
  );
}

export interface FolderListProps {
  folders: { uri: URI; name: string }[];
  current?: URI;
  choose(uri: URI): void;
}

/** The dropdown's content: a keyboard-navigable list of folders. */
export function FolderList({ folders, current, choose }: FolderListProps): React.ReactElement {
  const [focus, setFocus] = React.useState(() =>
    Math.max(0, folders.findIndex((f) => current && f.uri.isEqual(current))),
  );
  const listRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => listRef.current?.focus(), []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setFocus((i) => Math.min(folders.length - 1, i + 1));
    else if (e.key === "ArrowUp") setFocus((i) => Math.max(0, i - 1));
    else if (e.key === "Enter" && folders[focus]) choose(folders[focus].uri);
    else return;
    e.preventDefault();
  };
  return (
    <ul className="file-panel-siblings" tabIndex={0} ref={listRef} onKeyDown={onKeyDown} role="listbox">
      {folders.map((folder, i) => (
        <li
          key={folder.uri.toString()}
          role="option"
          aria-selected={i === focus}
          className={[
            "file-panel-sibling",
            current && folder.uri.isEqual(current) ? "current" : "",
            i === focus ? "focused" : "",
          ].join(" ")}
          onClick={() => choose(folder.uri)}
          onMouseEnter={() => setFocus(i)}
        >
          <span className="codicon codicon-folder" /> {folder.name}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Wire it into the panel**

In `file-panel-widget.ts`:
- add imports:
  ```ts
  import { BreadcrumbPopupContainerFactory } from "@theia/core/lib/browser/breadcrumbs/breadcrumb-popup-container";
  import { FileService } from "@theia/filesystem/lib/browser/file-service";
  import { createRoot } from "@theia/core/shared/react-dom/client";
  import * as React from "@theia/core/shared/react";
  import { type Crumb, siblingSource } from "../common/breadcrumb-model";
  import { compareEntries } from "../common/panel-sorting";
  import { FolderBreadcrumb, FolderList } from "./folder-breadcrumb";
  ```
- add injections:
  ```ts
  @inject(BreadcrumbPopupContainerFactory) protected readonly popups!: BreadcrumbPopupContainerFactory;
  @inject(FileService) protected readonly files!: FileService;
  ```
- in `initialize()`, push `this.workspace.onWorkspaceChanged(() => this.renderBreadcrumb())` to
  `toDispose`;
- in `onNavigated(uri)`, call `this.renderBreadcrumb()`;
- add:
  ```ts
  protected roots(): URI[] {
    return this.workspace.tryGetRoots().map((root) => root.resource);
  }

  protected renderBreadcrumb(): void {
    const current = this.folder;
    if (!current) return;
    this.header.setState({
      breadcrumb: React.createElement(FolderBreadcrumb, {
        current,
        roots: this.roots(),
        labels: this.labels,
        navigate: (uri) => void this.navigateTo(uri),
        openSiblings: (crumb, anchor) => void this.openSiblings(crumb, anchor),
        openHidden: (hidden, anchor) =>
          this.showFolderList(
            hidden.map((c) => ({ uri: c.uri, name: this.labels.getName(c.uri) })),
            undefined,
            anchor,
          ),
      }),
    });
  }

  async openSiblings(crumb: Crumb, anchor: HTMLElement): Promise<void> {
    const source = siblingSource(crumb, this.roots());
    if (!source) return;
    let uris: URI[];
    if (source.kind === "roots") {
      uris = source.roots;
    } else {
      const parent = await this.files.resolve(source.parent);
      uris = (parent.children ?? []).filter((c) => c.isDirectory).map((c) => c.resource);
    }
    const compare = compareEntries({ column: "name", direction: "asc" });
    const folders = uris
      .map((uri) => ({ uri, name: this.labels.getName(uri) }))
      .sort((a, b) => compare({ name: a.name, isDirectory: true }, { name: b.name, isDirectory: true }));
    this.showFolderList(folders, crumb.uri, anchor);
  }

  protected showFolderList(folders: { uri: URI; name: string }[], current: URI | undefined, anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    const popup = this.popups(this.node, `file-panel-siblings:${this.id}`, { x: box.left, y: box.bottom });
    const root = createRoot(popup.container);
    popup.onDidDispose(() => root.unmount());
    root.render(
      React.createElement(FolderList, {
        folders,
        current,
        choose: (uri) => {
          popup.dispose();
          void this.navigateTo(uri);
        },
      }),
    );
  }
  ```
  `BreadcrumbPopupContainer` closes itself on Escape, on focus leaving it, and on click outside.
  In right-to-left layouts `box.left` still anchors the popup under the crumb; if it overflows the
  window's inline end, that is Theia's popup behaviour and is accepted.

- [ ] **Step 5: Styles**

Append to `file-panels.css`:
```css
.file-panel-breadcrumb {
  display: flex;
  flex-wrap: nowrap;
  overflow: hidden;
  align-items: center;
  padding-block: 2px;
  padding-inline: 4px;
}
.file-panel-crumb {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
.file-panel-crumb + .file-panel-crumb::before,
.file-panel-more + .file-panel-crumb::before {
  content: "";
  inline-size: 5px;
  block-size: 5px;
  margin-inline: 4px;
  border-block-start: 1px solid currentColor;
  border-inline-end: 1px solid currentColor;
  transform: rotate(45deg);
}
[dir="rtl"] .file-panel-crumb + .file-panel-crumb::before,
[dir="rtl"] .file-panel-more + .file-panel-crumb::before {
  transform: rotate(-135deg);
}
.file-panel-crumb-label,
.file-panel-crumb-toggle,
.file-panel-more {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  padding-inline: 2px;
}
.file-panel-crumb:last-child .file-panel-crumb-label {
  font-weight: 600;
}
.file-panel-siblings {
  list-style: none;
  margin: 0;
  padding-block: 4px;
  padding-inline: 0;
  max-block-size: 300px;
  overflow-y: auto;
  outline: none;
}
.file-panel-sibling {
  padding-block: 2px;
  padding-inline: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.file-panel-sibling.focused {
  background: var(--theia-list-hoverBackground);
}
.file-panel-sibling.current {
  font-weight: 600;
}
```

- [ ] **Step 6: Build and run to see them pass**

Run: `pnpm --filter @theia-shell/app build && (cd app && pnpm exec playwright test tests/file-panels.spec.ts)`
Expected: 6 passed.

- [ ] **Step 7: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — breadcrumb whose segments list their sibling folders

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The panel's context menu and "Open in Files Panel"

**Files:**
- Modify: `packages/theia-file-panels/src/browser/file-panels-contribution.ts`
- Test: `app/tests/file-panels.spec.ts` (append)

**Interfaces:**
- Consumes: `FILE_PANEL_CONTEXT_MENU`, `FilePanelWidget`, `openPanel` (Task 6).
- Produces: commands `FilePanelsCommands.OPEN_SELECTION` (`file-panels.openSelection`) and
  `FilePanelsCommands.OPEN_AT` (`file-panels.openAt`); the context menu groups
  `FilePanelMenus.OPEN = [...FILE_PANEL_CONTEXT_MENU, "1_open"]`, `EDIT = [..., "2_edit"]`,
  `NEW = [..., "3_new"]`, `TRANSFER = [..., "4_transfer"]`, `PATH = [..., "5_path"]`.

- [ ] **Step 1: Write the failing e2e tests**

Add `explorer` to the file's existing `./helpers` import (`import { explorer, runFromPalette, start } from "./helpers";`), then append:
```ts
async function contextMenu(panel: Locator, name: string, item: string) {
  await row(panel, name).click({ button: "right" });
  await panel.page().locator(".lm-Menu-item", { hasText: item }).first().click();
}

test("rename and delete from the panel's context menu reach the explorer", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
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

test("the panel's Open opens a file; the explorer's Open in Files Panel opens a folder", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await contextMenu(panel, "welcome.md", "Open");
  await expect(page.locator(".theia-editor .monaco-editor").last()).toBeVisible();

  await explorer(page).getByText("docs", { exact: true }).click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Open in Files Panel" }).click();
  await expect(row(panels(page).last(), "cheatsheet.md")).toBeVisible();
});
```

Theia's rename dialog and delete confirmation are its own; if their selectors differ in 1.76
(`.dialogContent input`, `.dialogBlock .theia-button.main`), use the ones the running app shows
(`tools/probe.mjs` prints the DOM) — the behaviour under test is unchanged.

- [ ] **Step 2: Build and run to see them fail**

Expected: the two new tests FAIL (no context-menu items).

- [ ] **Step 3: Register the menu and commands**

In `file-panels-contribution.ts`, add imports:
```ts
import { CommonCommands } from "@theia/core/lib/browser";
import { SelectionService } from "@theia/core/lib/common/selection-service";
import { UriAwareCommandHandler } from "@theia/core/lib/common/uri-command-handler";
import { FileNavigatorCommands } from "@theia/navigator/lib/browser/file-navigator-commands";
import { NAVIGATOR_CONTEXT_MENU, NavigatorContextMenu } from "@theia/navigator/lib/browser/navigator-contribution";
import { WorkspaceCommands } from "@theia/workspace/lib/browser/workspace-commands";
import { FileStatNode } from "@theia/filesystem/lib/browser/file-tree";
import { FILE_PANEL_CONTEXT_MENU } from "./file-panel-widget";
```
Add to the namespace:
```ts
  export const OPEN_SELECTION: Command = { id: "file-panels.openSelection" };
  export const OPEN_AT: Command = { id: "file-panels.openAt" };
```
Add:
```ts
export namespace FilePanelMenus {
  export const OPEN = [...FILE_PANEL_CONTEXT_MENU, "1_open"];
  export const EDIT = [...FILE_PANEL_CONTEXT_MENU, "2_edit"];
  export const NEW = [...FILE_PANEL_CONTEXT_MENU, "3_new"];
  export const TRANSFER = [...FILE_PANEL_CONTEXT_MENU, "4_transfer"];
  export const PATH = [...FILE_PANEL_CONTEXT_MENU, "5_path"];
}
```
Inject `@inject(SelectionService) protected readonly selection!: SelectionService;` and add to
`registerCommands`:
```ts
    registry.registerCommand(
      { ...FilePanelsCommands.OPEN_SELECTION, label: Messages.open() },
      {
        execute: () => {
          const panel = this.currentPanel;
          for (const node of panel?.model.selectedNodes ?? []) {
            if (FileStatNode.is(node)) panel?.model.openNode(node);
          }
        },
        isEnabled: () => !!this.currentPanel?.model.selectedNodes.length,
      },
    );
    registry.registerCommand(
      { ...FilePanelsCommands.OPEN_AT, label: Messages.openInFilesPanel(), category: Messages.category() },
      UriAwareCommandHandler.MonoSelect(this.selection, {
        execute: async (uri) => {
          const stat = await this.files.resolve(uri);
          await this.openPanel(stat.isDirectory ? uri : uri.parent);
        },
      }),
    );
```
with `@inject(FileService) protected readonly files!: FileService;` (import from
`@theia/filesystem/lib/browser/file-service`). Add to `registerMenus`:
```ts
    menus.registerMenuAction(FilePanelMenus.OPEN, { commandId: FilePanelsCommands.OPEN_SELECTION.id, order: "a" });
    menus.registerMenuAction(FilePanelMenus.OPEN, { commandId: FileNavigatorCommands.OPEN_WITH.id, order: "b" });
    menus.registerMenuAction(FilePanelMenus.EDIT, { commandId: WorkspaceCommands.FILE_RENAME.id, order: "a" });
    menus.registerMenuAction(FilePanelMenus.EDIT, { commandId: WorkspaceCommands.FILE_DUPLICATE.id, order: "b" });
    menus.registerMenuAction(FilePanelMenus.EDIT, { commandId: WorkspaceCommands.FILE_DELETE.id, order: "c" });
    menus.registerMenuAction(FilePanelMenus.NEW, { commandId: WorkspaceCommands.NEW_FILE.id, order: "a" });
    menus.registerMenuAction(FilePanelMenus.NEW, { commandId: WorkspaceCommands.NEW_FOLDER.id, order: "b" });
    menus.registerMenuAction(FilePanelMenus.PATH, { commandId: CommonCommands.COPY_PATH.id, order: "a" });
    menus.registerMenuAction(FilePanelMenus.PATH, { commandId: FileNavigatorCommands.REVEAL_IN_NAVIGATOR.id, order: "b" });
    menus.registerMenuAction(NavigatorContextMenu.NAVIGATION, { commandId: FilePanelsCommands.OPEN_AT.id });
```
`NAVIGATOR_CONTEXT_MENU` is imported for reference only if `NavigatorContextMenu.NAVIGATION` needs
it — drop the unused import to keep biome clean. Theia's commands read the global selection, which
the panel publishes (`globalSelection: true`, Task 6).

- [ ] **Step 4: Build and run to see them pass**

Expected: 8 passed. If Rename is disabled in the panel, check that the selection published is the
tree's (`TreeWidgetSelection`) — `WorkspaceCommands` handlers use `UriSelection`, which reads a
`FileStatNode`'s `uri`; no extra code should be needed.

- [ ] **Step 5: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — Theia's file commands in the panel menu; Open in Files Panel

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Drops into panels — dialog, service, drag source, uploads

**Files:**
- Create: `packages/theia-file-panels/src/browser/panel-drag.ts`
- Create: `packages/theia-file-panels/src/browser/transfer-dialog.ts`
- Create: `packages/theia-file-panels/src/browser/transfer-service.ts`
- Create: `packages/theia-file-panels/src/browser/file-drop-handler.ts`
- Modify: `packages/theia-file-panels/src/browser/file-panel-tree-widget.tsx`
- Modify: `packages/theia-file-panels/src/browser/file-panel-widget.ts` (crumb drops, select results)
- Modify: `packages/theia-file-panels/src/browser/file-panels-frontend-module.ts`
- Modify: `packages/theia-file-panels/src/browser/style/file-panels.css`
- Test: `app/tests/file-panels.spec.ts` (append)

**Interfaces:**
- Consumes: `planTransfer`, `dropOptions`, `invalidDrop`, `validateName`, `freeName` (Task 3);
  `runPlan` (Task 5); `Messages` (Task 1); `FilePanelTreeWidget` (Task 6).
- Produces:
  - `PANEL_DRAG_TYPE = "theia-file-panels/uris"`; `writePanelDrag(data: DataTransfer, uris: URI[])`;
    `readPanelDrag(data: DataTransfer): URI[]`.
  - `interface TransferChoice { op: TransferOp; name?: string; clash: ClashPolicy }`
  - `class TransferDialog extends AbstractDialog<TransferChoice>` with
    `TransferDialogProps { title; sources: TransferSource[]; target: URI; targetName: string;
    existing: ReadonlySet<string>; preferCopy: boolean }`.
  - `TransferService.run(plan: TransferPlan): Promise<TransferOutcome>`.
  - `FileDropHandler.drop(target: URI, data: DataTransfer, preferCopy: boolean): Promise<URI[]>`
    (returns the URIs written).

- [ ] **Step 1: Write the failing e2e tests**

Append to `app/tests/file-panels.spec.ts`:
```ts
const dialog = (page: Page) => page.locator(".file-panels-transfer-dialog");
const readText = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const files = (window as unknown as { theiaShell: { filesApi: { exists(p: string): Promise<boolean> } } }).theiaShell.filesApi;
    return files.exists(p);
  }, path);

async function twoPanels(page: Page, left: string[], right: string[]) {
  const a = await openPanel(page);
  for (const name of left) await row(a, name).dblclick();
  const b = await openPanel(page);
  for (const name of right) await row(b, name).dblclick();
  return [a, b] as const;
}

test("dragging between panels asks, and Copy copies", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, ["Browser Storage"], ["Browser Storage", "docs"]);
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
  const [a, b] = await twoPanels(page, ["Browser Storage"], ["Browser Storage", "docs"]);
  await row(a, "welcome.md").dragTo(b.locator(".file-panel-tree"));
  await dialog(page).locator("input[name=file-panels-op][value=move]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "welcome.md")).toBeVisible();
  await expect(row(a, "welcome.md")).toHaveCount(0);
});

test("a drop into the same folder offers only Copy or Rename; Copy makes a free name", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await row(panel, "ideas.md").dragTo(panel.locator(".file-panel-tree"), { targetPosition: { x: 20, y: 200 } });
  const ops = dialog(page).locator("input[name=file-panels-op]");
  await expect(ops).toHaveCount(2);
  await expect(dialog(page).locator("input[name=file-panels-op][value=rename]")).toHaveCount(1);
  await expect(dialog(page).locator(".file-panels-name")).toHaveValue("ideas copy.md");
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(panel, "ideas copy.md")).toBeVisible();
});

test("several items with a clash: Keep both, then Skip", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, ["Browser Storage", "docs"], ["Browser Storage", "notes"]);
  // Put a cheatsheet.md into notes first, so the second drop clashes.
  await row(a, "cheatsheet.md").dragTo(b.locator(".file-panel-tree"));
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "cheatsheet.md")).toBeVisible();

  await row(a, "cheatsheet.md").click();
  await row(a, "sample.pdf").click({ modifiers: ["Control"] });
  await row(a, "sample.pdf").dragTo(b.locator(".file-panel-tree"));
  await expect(dialog(page).getByText("1 item already exists in the target:")).toBeVisible();
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator("input[name=file-panels-clash][value=keepBoth]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "cheatsheet copy.md")).toBeVisible();
  await expect(row(b, "sample.pdf")).toBeVisible();
});

test("dropping a folder into itself is refused", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").click();
  await row(panel, "welcome.md").click({ modifiers: ["Control"] });
  await row(panel, "welcome.md").dragTo(row(panel, "notes"));
  await expect(page.getByText("Cannot put “notes” inside itself")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
  expect(await readText(page, "/browser/welcome.md")).toBe(true);
});

test("names with spaces, # and % survive a copy", async ({ page }) => {
  await start(page, "?storage=memory");
  await page.evaluate(async () => {
    const files = (window as unknown as { theiaShell: { filesApi: { write(p: string, c: AsyncIterable<Uint8Array>): Promise<void> } } }).theiaShell.filesApi;
    await files.write("/browser/my #1 100%.txt", (async function* () { yield new TextEncoder().encode("x"); })());
  });
  const [a, b] = await twoPanels(page, ["Browser Storage"], ["Browser Storage", "docs"]);
  await row(a, "my #1 100%.txt").dragTo(b.locator(".file-panel-tree"));
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect.poll(() => readText(page, "/browser/docs/my #1 100%.txt")).toBe(true);
});

test("the explorer drags into a panel with the dialog; failures are reported", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page); // at the "Files" root, which is read-only
  await explorer(page).getByText("welcome.md", { exact: true }).dragTo(panel.locator(".file-panel-tree"));
  await dialog(page).locator("input[name=file-panels-op][value=copy]").check();
  await dialog(page).locator(".theia-button.main").click();
  await expect(page.getByText("1 of 1 items failed")).toBeVisible();
});

test("an operating-system file dropped on a panel is uploaded", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await panel.locator(".file-panel-tree").evaluate((el) => {
    const data = new DataTransfer();
    data.items.add(new File(["hello"], "dropped.txt", { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  });
  await expect(row(panel, "dropped.txt")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});
```

- [ ] **Step 2: Build and run to see them fail**

Expected: the 8 new tests FAIL (no dialog appears; the drop does nothing or uploads).

- [ ] **Step 3: The drag payload**

`packages/theia-file-panels/src/browser/panel-drag.ts`:
```ts
import URI from "@theia/core/lib/common/uri";

/** Marks a drag that started in a file panel; the explorer recognises panel drags by it. */
export const PANEL_DRAG_TYPE = "theia-file-panels/uris";

export function writePanelDrag(data: DataTransfer, uris: URI[]): void {
  data.setData(PANEL_DRAG_TYPE, uris.map((uri) => uri.toString()).join("\n"));
}

/** Must be called synchronously inside the drop event: the browser clears the data afterwards. */
export function readPanelDrag(data: DataTransfer): URI[] {
  const text = data.getData(PANEL_DRAG_TYPE);
  return text ? text.split("\n").map((line) => new URI(line)) : [];
}
```

- [ ] **Step 4: The dialog**

`packages/theia-file-panels/src/browser/transfer-dialog.ts`:
```ts
import { AbstractDialog, DialogError, DialogProps } from "@theia/core/lib/browser/dialogs";
import type URI from "@theia/core/lib/common/uri";
import { Messages } from "../common/file-panels-nls";
import {
  type ClashPolicy,
  dropOptions,
  freeName,
  type TransferOp,
  type TransferSource,
  validateName,
} from "../common/transfer-planner";

export interface TransferChoice {
  op: TransferOp;
  name?: string;
  clash: ClashPolicy;
}

export class TransferDialogProps extends DialogProps {
  sources!: TransferSource[];
  target!: URI;
  targetName!: string;
  existing!: ReadonlySet<string>;
  preferCopy!: boolean;
}

export class TransferDialog extends AbstractDialog<TransferChoice> {
  protected op: TransferOp;
  protected clash: ClashPolicy = "keepBoth";
  protected readonly nameInput?: HTMLInputElement;
  protected readonly warning = document.createElement("div");
  protected readonly options: ReturnType<typeof dropOptions>;

  constructor(protected override readonly props: TransferDialogProps) {
    super(props);
    this.addClass("file-panels-transfer-dialog");
    const { sources, target, existing, preferCopy } = props;
    this.options = dropOptions(sources, target, existing);
    this.op = this.options.allInTarget ? "copy" : preferCopy ? "copy" : "move";

    const to = document.createElement("div");
    to.className = "file-panels-target";
    to.textContent = Messages.targetFolder(props.targetName);
    this.contentNode.appendChild(to);

    this.contentNode.appendChild(
      this.radios("file-panels-op", this.options.ops.map((op) => [op, this.opLabel(op)]), this.op, (op) => {
        this.op = op as TransferOp;
        this.prefillName();
        void this.validate();
      }),
    );

    if (sources.length === 1) {
      const label = document.createElement("label");
      label.className = "file-panels-name-label";
      label.textContent = Messages.nameLabel();
      const input = document.createElement("input");
      input.className = "theia-input file-panels-name";
      input.spellcheck = false;
      label.appendChild(input);
      this.contentNode.appendChild(label);
      this.nameInput = input;
      this.addUpdateListener(input, "input");
      this.prefillName();
    } else if (this.options.clashing.length > 0) {
      const count = document.createElement("div");
      count.textContent = Messages.clashCount(this.options.clashing.length);
      this.contentNode.appendChild(count);
      this.contentNode.appendChild(
        this.radios(
          "file-panels-clash",
          [
            ["overwrite", Messages.clashOverwrite()],
            ["keepBoth", Messages.clashKeepBoth()],
            ["skip", Messages.clashSkip()],
          ],
          this.clash,
          (clash) => {
            this.clash = clash as ClashPolicy;
          },
        ),
      );
    }

    this.warning.className = "file-panels-warning";
    this.contentNode.appendChild(this.warning);
    this.appendCloseButton();
    this.appendAcceptButton();
  }

  get value(): TransferChoice {
    return { op: this.op, name: this.nameInput?.value, clash: this.clash };
  }

  protected override isValid(value: TransferChoice): DialogError {
    this.warning.textContent = "";
    if (value.name === undefined) return "";
    const problem = validateName(value.name);
    if (problem === "empty") return Messages.nameEmpty();
    if (problem === "dots") return Messages.nameDots();
    if (problem === "slash") return Messages.nameSlash();
    const [source] = this.props.sources;
    const sameFolder = source.uri.parent.isEqual(this.props.target);
    if (sameFolder && value.name === source.uri.path.base) return Messages.nameUnchanged();
    if (this.props.existing.has(value.name)) this.warning.textContent = Messages.nameExists(value.name);
    return "";
  }

  protected override onAfterAttach(msg: import("@theia/core/shared/@lumino/messaging").Message): void {
    super.onAfterAttach(msg);
    void this.validate();
  }

  protected override onActivateRequest(): void {
    if (this.nameInput) {
      this.nameInput.focus();
      const dot = this.nameInput.value.indexOf(".", 1);
      this.nameInput.setSelectionRange(0, dot > 0 ? dot : this.nameInput.value.length);
    } else {
      this.controlPanel.querySelector<HTMLButtonElement>(".theia-button.main")?.focus();
    }
  }

  protected prefillName(): void {
    if (!this.nameInput) return;
    const [source] = this.props.sources;
    const name = source.uri.path.base;
    const sameFolder = source.uri.parent.isEqual(this.props.target);
    this.nameInput.value =
      sameFolder && this.op === "copy"
        ? freeName(name, source.isDirectory, this.props.existing, Messages.copySuffix)
        : name;
  }

  protected opLabel(op: TransferOp): string {
    return op === "copy" ? Messages.opCopy() : op === "move" ? Messages.opMove() : Messages.opRename();
  }

  protected radios(
    name: string,
    items: [string, string][],
    checked: string,
    onChange: (value: string) => void,
  ): HTMLElement {
    const group = document.createElement("div");
    group.className = `file-panels-radios ${name}`;
    group.setAttribute("role", "radiogroup");
    for (const [value, text] of items) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = name;
      input.value = value;
      input.checked = value === checked;
      input.addEventListener("change", () => input.checked && onChange(value));
      label.append(input, ` ${text}`);
      group.appendChild(label);
    }
    return group;
  }
}
```

The title is set by the caller (`Messages.transferTitle` or `Messages.sameFolderTitle`). A
same-folder rename with a name that exists warns (`nameExists`) but is allowed — it replaces, as
the warning says.

- [ ] **Step 5: The service**

`packages/theia-file-panels/src/browser/transfer-service.ts`:
```ts
import { MessageService } from "@theia/core/lib/common/message-service";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { Messages } from "../common/file-panels-nls";
import type { TransferPlan } from "../common/transfer-planner";
import { runPlan, type TransferOutcome } from "../common/transfer-runner";

/** Runs a plan through Theia's FileService, with progress and one report of the failures. */
@injectable()
export class TransferService {
  @inject(FileService) protected readonly files!: FileService;
  @inject(MessageService) protected readonly messages!: MessageService;

  async run(plan: TransferPlan): Promise<TransferOutcome> {
    if (plan.steps.length === 0) return { done: [], failures: [], cancelled: false };
    let cancelled = false;
    const progress = await this.messages.showProgress(
      { text: Messages.transferring(), options: { cancelable: true } },
      () => {
        cancelled = true;
      },
    );
    try {
      const outcome = await runPlan(
        plan,
        {
          copy: (from: URI, to: URI, overwrite: boolean) => this.files.copy(from, to, { overwrite }),
          move: (from: URI, to: URI, overwrite: boolean) => this.files.move(from, to, { overwrite }),
        },
        {
          isCancelled: () => cancelled,
          onStep: (i, total) =>
            progress.report({ message: Messages.progressStep(i + 1, String(total)), work: { done: i, total } }),
        },
      );
      if (outcome.failures.length > 0) {
        const detail = outcome.failures.map((f) => `${f.step.from.path.base}: ${f.message}`).join("\n");
        void this.messages.error(
          `${Messages.itemsFailed(outcome.failures.length, String(plan.steps.length))}\n${detail}`,
        );
      }
      return outcome;
    } finally {
      progress.cancel();
    }
  }
}
```

- [ ] **Step 6: The drop handler**

`packages/theia-file-panels/src/browser/file-drop-handler.ts`:
```ts
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { LabelProvider } from "@theia/core/lib/browser/label-provider";
import { MessageService } from "@theia/core/lib/common/message-service";
import type URI from "@theia/core/lib/common/uri";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import { FileUploadService } from "@theia/filesystem/lib/common/upload/file-upload";
import { Messages } from "../common/file-panels-nls";
import { invalidDrop, planTransfer, type TransferSource } from "../common/transfer-planner";
import { TransferDialog } from "./transfer-dialog";
import { TransferService } from "./transfer-service";

/** Every drop into a panel: read the payload, refuse the impossible, ask, plan, run. */
@injectable()
export class FileDropHandler {
  @inject(FileService) protected readonly files!: FileService;
  @inject(FileUploadService) protected readonly upload!: FileUploadService;
  @inject(TransferService) protected readonly transfers!: TransferService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(LabelProvider) protected readonly labels!: LabelProvider;

  /** Returns the URIs written. Must be called synchronously from the drop event. */
  async drop(target: URI, data: DataTransfer, preferCopy: boolean): Promise<URI[]> {
    // Read everything before the first await: the browser clears the DataTransfer afterwards.
    const uris = ApplicationShell.getDraggedEditorUris(data);
    if (uris.length === 0) {
      if (data.files.length === 0) return [];
      const result = await this.upload.upload(target, { source: data });
      return result.uploaded.map((uri) => target.withPath(uri)).filter(Boolean);
    }

    const stats = await this.files.resolveAll(uris.map((resource) => ({ resource })));
    const sources: TransferSource[] = stats
      .filter((result) => result.success && result.stat)
      .map((result) => ({ uri: result.stat!.resource, isDirectory: result.stat!.isDirectory }));
    if (sources.length === 0) return [];

    const invalid = invalidDrop(sources, target);
    if (invalid) {
      void this.messages.warn(Messages.intoItself(invalid.uri.path.base));
      return [];
    }

    const folder = await this.files.resolve(target);
    const existing = new Set((folder.children ?? []).map((child) => child.name));
    const allInTarget = sources.every((s) => s.uri.parent.isEqual(target));
    const firstName = sources[0].uri.path.base;
    const dialog = new TransferDialog({
      title: allInTarget
        ? Messages.sameFolderTitle(sources.length, firstName)
        : Messages.transferTitle(sources.length, firstName),
      sources,
      target,
      targetName: this.labels.getName(target),
      existing,
      preferCopy,
    });
    const choice = await dialog.open();
    if (!choice) return [];

    const plan = planTransfer({ ...choice, sources, target, existing, copySuffix: Messages.copySuffix });
    const outcome = await this.transfers.run(plan);
    return outcome.done;
  }
}
```

`FileUploadService.UploadResult.uploaded` is a list of URI strings; if it is, map with
`new URI(s)` instead of `target.withPath(s)` — check the `.d.ts`. The result only feeds selection.

- [ ] **Step 7: The tree widget as drag source and drop target**

In `file-panel-tree-widget.tsx`, inject the handler and override the protected drag methods:
```tsx
import { ApplicationShell } from "@theia/core/lib/browser/shell/application-shell";
import { isCancelled } from "@theia/core/lib/common/cancellation";
import type URI from "@theia/core/lib/common/uri";
import { FileDropHandler } from "./file-drop-handler";
import { writePanelDrag } from "./panel-drag";

  @inject(FileDropHandler) protected readonly drops!: FileDropHandler;
  /** Fired with the URIs a drop wrote, so the panel can select them. */
  readonly onDidDrop = new Emitter<URI[]>();

  protected override handleDragStartEvent(node: TreeNode, event: React.DragEvent): void {
    super.handleDragStartEvent(node, event);
    const uris = ApplicationShell.getDraggedEditorUris(event.dataTransfer);
    writePanelDrag(event.dataTransfer, uris);
    event.dataTransfer.effectAllowed = "copyMove";
  }

  /** No auto-expansion while hovering a folder: the list is flat. */
  protected override handleDragOverEvent(_node: TreeNode | undefined, event: React.DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = this.getDropEffect(event);
  }

  protected override async handleDropEvent(node: TreeNode | undefined, event: React.DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const target = this.getDropTargetDirNode(node)?.uri ?? this.model.location;
    if (!target) return;
    try {
      const written = await this.drops.drop(target, event.dataTransfer, this.getDropEffect(event) === "copy");
      if (written.length > 0) this.onDidDrop.fire(written);
    } catch (error) {
      if (!isCancelled(error)) this.logger.error(error);
    }
  }
```
(add `this.toDispose.push(this.onDidDrop);` in the constructor). `drop()` reads the
`DataTransfer` before its first `await`, and this method calls it before its own first `await` —
keep it that way.

In `file-panel-widget.ts`:
- pass `onDropOnCrumb: (uri, event) => { event.preventDefault(); void this.tree.dropOnFolder(uri, event); }`
  in `renderBreadcrumb()`, and add to `FilePanelTreeWidget`:
  ```tsx
  /** A drop on a breadcrumb segment: the same path as a drop on a folder row. */
  async dropOnFolder(target: URI, event: React.DragEvent): Promise<void> {
    const written = await this.drops.drop(target, event.dataTransfer, this.getDropEffect(event) === "copy");
    if (written.length > 0) this.onDidDrop.fire(written);
  }
  ```
- select what a drop wrote into this folder, in `initialize()`:
  ```ts
  this.tree.onDidDrop.event(async (uris) => {
    await this.model.refresh();
    const nodes = uris
      .filter((uri) => this.folder && uri.parent.isEqual(this.folder))
      .map((uri) => this.model.getNode(uri.path.toString()))
      .filter((node): node is SelectableTreeNode => SelectableTreeNode.is(node));
    nodes.forEach((node, i) => (i === 0 ? this.model.selectNode(node) : this.model.addSelection(node)));
  }),
  ```
  with `import { SelectableTreeNode } from "@theia/core/lib/browser/tree/tree-selection";`. If
  `addSelection` is not on the 1.76 model, select only the first node.

- [ ] **Step 8: Bind, style**

In `file-panels-frontend-module.ts` add:
```ts
import { FileDropHandler } from "./file-drop-handler";
import { TransferService } from "./transfer-service";
  bind(TransferService).toSelf().inSingletonScope();
  bind(FileDropHandler).toSelf().inSingletonScope();
```
Append to `file-panels.css`:
```css
.file-panels-transfer-dialog .dialogContent {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-inline-size: 360px;
}
.file-panels-radios {
  display: flex;
  gap: 16px;
}
.file-panels-name-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.file-panels-warning {
  color: var(--theia-editorWarning-foreground);
  min-block-size: 1.2em;
}
```

- [ ] **Step 9: Build and run to see them pass**

Expected: 16 passed. Two things to check if a test fails:
- `dragTo` between widgets needs both visible; `openPanel` opens the second split-right, so both
  are. If Playwright's synthetic drag carries no `DataTransfer`, switch that test to the same
  `dispatchEvent` technique as the upload test, building the `DataTransfer` with
  `setData("theia-editor-dnd", uri)` and `setData("theia-file-panels/uris", uri)`.
- The explorer → panel test relies on the explorer writing `theia-editor-dnd` (it does, via
  `ApplicationShell.setDraggedEditorUris` in `FileTreeWidget.handleDragStartEvent`).

- [ ] **Step 10: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — drops into a panel ask Copy/Move/Rename; uploads; drag source

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The explorer accepts panel drags (its own behaviour unchanged)

**Files:**
- Create: `packages/theia-file-panels/src/browser/panel-aware-navigator-widget.ts`
- Modify: `packages/theia-file-panels/src/browser/file-panels-frontend-module.ts`
- Test: `app/tests/file-panels.spec.ts` (append)

**Interfaces:**
- Consumes: `readPanelDrag` (Task 9).
- Produces: `PanelAwareNavigatorWidget extends FileNavigatorWidget` and its rebinding.

Theia members used, with visibility: `FileTreeWidget.handleDropEvent` (protected, overridden),
`getDropTargetDirNode` (protected), `getDropEffect` (protected), `logger` (protected);
`FileTreeModel.copy(uri, target)` and `move(source, target)` (public); `FileNavigatorWidget`
constructor `(props, model: FileNavigatorModel, contextMenuRenderer)`;
`createFileNavigatorContainer` (exported from `navigator-container`).

- [ ] **Step 1: Write the failing e2e tests**

Append to `app/tests/file-panels.spec.ts`:
```ts
test("panel → explorer: a plain drop moves, Ctrl copies, no dialog", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
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
  await explorer(page).getByText("welcome.md", { exact: true }).dragTo(explorer(page).getByText("docs", { exact: true }));
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => readText(page, "/browser/docs/welcome.md")).toBe(true);
});
```

- [ ] **Step 2: Build and run to see them fail**

Expected: the panel → explorer test FAILS (nothing moves); explorer → explorer PASSES already —
it is the regression guard for "unchanged", and must stay green after Step 4.

- [ ] **Step 3: The subclass**

`packages/theia-file-panels/src/browser/panel-aware-navigator-widget.ts`:
```ts
import { ContextMenuRenderer } from "@theia/core/lib/browser/context-menu-renderer";
import type { TreeNode } from "@theia/core/lib/browser/tree/tree";
import { TreeModel } from "@theia/core/lib/browser/tree/tree-model";
import { TreeProps } from "@theia/core/lib/browser/tree/tree-widget";
import { isCancelled } from "@theia/core/lib/common/cancellation";
import type * as React from "@theia/core/shared/react";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileService } from "@theia/filesystem/lib/browser/file-service";
import type { FileStatNode } from "@theia/filesystem/lib/browser/file-tree";
import { FileNavigatorModel } from "@theia/navigator/lib/browser/navigator-model";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { readPanelDrag } from "./panel-drag";

/**
 * The explorer, plus one case: a drag from a file panel is copied or moved with the explorer's
 * own rule (Ctrl/⌥ copies) through its model's public copy/move — no dialog. Every other drop
 * goes to Theia's handler untouched.
 */
@injectable()
export class PanelAwareNavigatorWidget extends FileNavigatorWidget {
  @inject(FileService) protected readonly files!: FileService;

  constructor(
    @inject(TreeProps) props: TreeProps,
    @inject(TreeModel) model: FileNavigatorModel,
    @inject(ContextMenuRenderer) contextMenuRenderer: ContextMenuRenderer,
  ) {
    super(props, model, contextMenuRenderer);
  }

  protected override async handleDropEvent(node: TreeNode | undefined, event: React.DragEvent): Promise<void> {
    const uris = readPanelDrag(event.dataTransfer);
    if (uris.length === 0) return super.handleDropEvent(node, event);
    event.preventDefault();
    event.stopPropagation();
    const effect = this.getDropEffect(event);
    event.dataTransfer.dropEffect = effect;
    const target = this.getDropTargetDirNode(node);
    if (!target) return;
    for (const uri of uris) {
      try {
        if (effect === "copy") {
          await this.model.copy(uri, target);
        } else {
          const stat = await this.files.resolve(uri);
          const source: FileStatNode = {
            id: stat.resource.toString(),
            name: stat.name,
            uri: stat.resource,
            fileStat: stat,
            parent: undefined,
            selected: false,
          } as FileStatNode;
          await this.model.move(source, target);
        }
      } catch (error) {
        if (!isCancelled(error)) this.logger.error(error);
      }
    }
  }
}
```

The constructor mirrors `FileNavigatorWidget`'s injected parameters (inversify needs the derived
class to declare them). If the 1.76 `.d.ts` lists more parameters, mirror them all.

- [ ] **Step 4: Rebind inside Theia's own container**

In `file-panels-frontend-module.ts` (the module callback now takes `(bind, _unbind, _isBound, rebind)`):
```ts
import { createFileNavigatorContainer } from "@theia/navigator/lib/browser/navigator-container";
import { FileNavigatorWidget } from "@theia/navigator/lib/browser/navigator-widget";
import { PanelAwareNavigatorWidget } from "./panel-aware-navigator-widget";

  rebind(FileNavigatorWidget).toDynamicValue(({ container }) => {
    const child = createFileNavigatorContainer(container);
    child.rebind(FileNavigatorWidget).to(PanelAwareNavigatorWidget).inSingletonScope();
    return child.get(FileNavigatorWidget);
  });
```
The navigator's `WidgetFactory` calls `container.get(FileNavigatorWidget)`, so it now receives the
subclass; tree, model, decorators and props stay Theia's. This module loads after
`@theia/navigator`'s (it depends on it), so `rebind` finds the binding.

- [ ] **Step 5: Build and run to see them pass**

Expected: 18 passed, and the explorer → explorer test still passes. Also run the app's other
suites that touch the explorer:
```bash
cd app && pnpm exec playwright test tests/files.spec.ts tests/mounts.spec.ts; cd ..
```
Expected: pass, unchanged.

- [ ] **Step 6: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — the explorer accepts panel drags; its own drops unchanged

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Copy / Move to Other Panel

**Files:**
- Modify: `packages/theia-file-panels/src/browser/file-drop-handler.ts` (extract `transfer`)
- Modify: `packages/theia-file-panels/src/browser/file-panels-contribution.ts`
- Test: `app/tests/file-panels.spec.ts` (append)

**Interfaces:**
- Consumes: `FileDropHandler` (Task 9), `FilePanelMenus.TRANSFER` (Task 8), `panels` (Task 6).
- Produces:
  - `FileDropHandler.transfer(sources: URI[], target: URI, preset: { preferCopy: boolean; op?: "copy" | "move" }): Promise<URI[]>`
    — the dialog-and-run half of `drop()`, which `drop()` now calls.
  - Commands `FilePanelsCommands.COPY_TO_OTHER` (`file-panels.copyToOther`),
    `MOVE_TO_OTHER` (`file-panels.moveToOther`).

- [ ] **Step 1: Write the failing e2e test**

```ts
test("Copy to Other Panel copies the selection into the other panel's folder", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a, b] = await twoPanels(page, ["Browser Storage"], ["Browser Storage", "media"]);
  await row(a, "welcome.md").click({ button: "right" });
  await page.locator(".lm-Menu-item", { hasText: "Copy to Other Panel…" }).click();
  await expect(dialog(page).locator("input[name=file-panels-op][value=copy]")).toBeChecked();
  await dialog(page).locator(".theia-button.main").click();
  await expect(row(b, "welcome.md")).toBeVisible();
});
```

- [ ] **Step 2: Build and run to see it fail**

Expected: FAIL — no such menu item.

- [ ] **Step 3: Split `drop()` and add the commands**

Replace `drop()` in `file-drop-handler.ts` with the two methods below (`drop()` keeps its
synchronous read, then delegates):
```ts
  /** Returns the URIs written. Must be called synchronously from the drop event. */
  async drop(target: URI, data: DataTransfer, preferCopy: boolean): Promise<URI[]> {
    // Read everything before the first await: the browser clears the DataTransfer afterwards.
    const uris = ApplicationShell.getDraggedEditorUris(data);
    if (uris.length === 0) {
      if (data.files.length === 0) return [];
      const result = await this.upload.upload(target, { source: data });
      return result.uploaded.map((uri) => target.withPath(uri)).filter(Boolean);
    }
    return this.transfer(uris, target, { preferCopy });
  }

  /** Ask Copy / Move / Rename for `uris` into `target`, then run the plan. */
  async transfer(
    uris: URI[],
    target: URI,
    preset: { preferCopy: boolean; op?: "copy" | "move" },
  ): Promise<URI[]> {
    const stats = await this.files.resolveAll(uris.map((resource) => ({ resource })));
    const sources: TransferSource[] = stats
      .filter((result) => result.success && result.stat)
      .map((result) => ({ uri: result.stat!.resource, isDirectory: result.stat!.isDirectory }));
    if (sources.length === 0) return [];

    const invalid = invalidDrop(sources, target);
    if (invalid) {
      void this.messages.warn(Messages.intoItself(invalid.uri.path.base));
      return [];
    }

    const folder = await this.files.resolve(target);
    const existing = new Set((folder.children ?? []).map((child) => child.name));
    const allInTarget = sources.every((s) => s.uri.parent.isEqual(target));
    const firstName = sources[0].uri.path.base;
    const dialog = new TransferDialog({
      title: allInTarget
        ? Messages.sameFolderTitle(sources.length, firstName)
        : Messages.transferTitle(sources.length, firstName),
      sources,
      target,
      targetName: this.labels.getName(target),
      existing,
      preferCopy: preset.op ? preset.op === "copy" : preset.preferCopy,
    });
    const choice = await dialog.open();
    if (!choice) return [];

    const plan = planTransfer({ ...choice, sources, target, existing, copySuffix: Messages.copySuffix });
    const outcome = await this.transfers.run(plan);
    return outcome.done;
  }
```

In `file-panels-contribution.ts`, inject `FileDropHandler` and `QuickInputService`
(`import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";`), then:
```ts
  export const COPY_TO_OTHER: Command = { id: "file-panels.copyToOther" };
  export const MOVE_TO_OTHER: Command = { id: "file-panels.moveToOther" };

  protected async otherPanel(from: FilePanelWidget): Promise<FilePanelWidget | undefined> {
    const others = this.panels.filter((p) => p !== from && p.folder);
    if (others.length <= 1) return others[0];
    const picked = await this.quickInput.showQuickPick(
      others.map((panel) => ({ label: panel.title.label, description: panel.title.caption, panel })),
      { placeholder: Messages.pickOtherPanel() },
    );
    return picked?.panel;
  }

  protected async toOther(op: "copy" | "move"): Promise<void> {
    const from = this.currentPanel;
    if (!from) return;
    const uris = from.model.selectedNodes.filter(FileStatNode.is).map((node) => node.uri);
    const to = await this.otherPanel(from);
    if (!to?.folder || uris.length === 0) return;
    await this.drops.transfer(uris, to.folder, { preferCopy: op === "copy", op });
  }
```
Register (in `registerCommands`):
```ts
    const enabled = () => !!this.currentPanel?.model.selectedNodes.length && this.panels.length > 1;
    registry.registerCommand(
      { ...FilePanelsCommands.COPY_TO_OTHER, label: Messages.copyToOtherPanel() },
      { execute: () => this.toOther("copy"), isEnabled: enabled },
    );
    registry.registerCommand(
      { ...FilePanelsCommands.MOVE_TO_OTHER, label: Messages.moveToOtherPanel() },
      { execute: () => this.toOther("move"), isEnabled: enabled },
    );
```
and (in `registerMenus`):
```ts
    menus.registerMenuAction(FilePanelMenus.TRANSFER, { commandId: FilePanelsCommands.COPY_TO_OTHER.id, order: "a" });
    menus.registerMenuAction(FilePanelMenus.TRANSFER, { commandId: FilePanelsCommands.MOVE_TO_OTHER.id, order: "b" });
```
The dialog preselects Move unless `preferCopy`; `op: "move"` passes `preferCopy: false`, so Move
is preselected for Move to Other Panel.

- [ ] **Step 4: Build and run to see it pass**

Expected: 19 passed.

- [ ] **Step 5: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — Copy / Move to Other Panel through the same dialog

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Restore after reload; vanished folders

**Files:**
- Modify: `packages/theia-file-panels/src/browser/file-panel-widget.ts`
- Test: `app/tests/file-panels.spec.ts` (append)

**Interfaces:**
- Consumes: `FilePanelWidget` (Tasks 6–9).
- Produces: `FilePanelWidget implements StatefulWidget` —
  `storeState(): { folder?: string; sort: SortState }`;
  `restoreState(state: { folder?: string; sort?: SortState }): void`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
test("panels come back after a reload, at their folders and sort", async ({ page }) => {
  await start(page, "?storage=memory");
  const [a] = await twoPanels(page, ["Browser Storage", "docs"], ["Browser Storage", "notes"]);
  await a.locator(".file-panel-column", { hasText: "Name" }).click();
  // Theia stores the layout on unload.
  await page.reload();
  await start(page, "?storage=memory");
  await expect(panels(page)).toHaveCount(2);
  await expect(row(panels(page).first(), "cheatsheet.md")).toBeVisible();
  await expect(row(panels(page).last(), "ideas.md")).toBeVisible();
  await expect(panels(page).first().locator(".file-panel-column[aria-sort=descending]")).toHaveText(/Name/);
});

test("a panel whose folder is deleted moves up and says so", async ({ page }) => {
  await start(page, "?storage=memory");
  const panel = await openPanel(page);
  await row(panel, "Browser Storage").dblclick();
  await row(panel, "notes").dblclick();
  await explorer(page).getByText("notes", { exact: true }).click();
  await page.keyboard.press("Delete");
  await page.locator(".dialogBlock .theia-button.main").click();
  await expect(row(panel, "welcome.md")).toBeVisible();
  await expect(panel.getByText("“notes” no longer exists — showing “Browser Storage”")).toBeVisible();
});
```

`start()` navigates again; the second call after `reload()` only re-runs the readiness checks. If
`start` re-navigates and so drops the stored layout, replace it after `reload()` with
`await openMain(page)`.

- [ ] **Step 2: Build and run to see them fail**

Expected: FAIL — no panels after reload; the deleted-folder panel stays empty.

- [ ] **Step 3: State, fallback, and the gone-folder notice**

In `file-panel-widget.ts`:
- `implements StatefulWidget` (import from `@theia/core/lib/browser/shell/shell-layout-restorer`);
- add:
  ```ts
  storeState(): object {
    return { folder: this.folder?.toString(), sort: this.sort };
  }

  restoreState(state: { folder?: string; sort?: SortState }): void {
    if (state.sort) this.setSort(state.sort);
    if (state.folder) void this.navigateToExisting(new URI(state.folder));
  }

  /** `uri`, or its nearest existing ancestor, or the first workspace root. */
  protected async navigateToExisting(uri: URI): Promise<void> {
    for (let candidate = uri; ; candidate = candidate.parent) {
      if (await this.files.exists(candidate)) {
        await this.navigateTo(candidate);
        if (!candidate.isEqual(uri)) {
          this.header.setState({
            status: { text: Messages.folderGone(uri.path.base, this.labels.getName(candidate)) },
          });
        }
        return;
      }
      if (candidate.path.isRoot) break;
    }
    await this.navigateTo(await this.defaultFolder());
  }
  ```
- in `initialize()`, watch for the current folder or an ancestor disappearing:
  ```ts
  this.files.onDidFilesChange((event) => {
    const folder = this.folder;
    if (folder && event.changes.some((change) => change.resource.isEqualOrParent(folder))) {
      void this.files.exists(folder).then((exists) => {
        if (!exists) void this.navigateToExisting(folder);
      });
    }
  }),
  ```
- keep the `folderGone` notice until the user navigates again. Add a field and let the status
  fall back to it; `navigateToExisting` sets it *after* its `navigateTo`, and `navigateTo` clears it:
  ```ts
  /** A notice shown until the next navigation (a folder that disappeared). */
  protected notice: string | undefined;

  async navigateTo(uri: URI): Promise<void> {
    this.notice = undefined;
    await this.model.navigateToFolder(uri);
  }

  protected updateEmptyState(): void {
    const error = this.fileTree.listingError;
    const root = this.model.root;
    const empty = !error && root && "children" in root && (root.children as unknown[]).length === 0;
    this.header.setState({
      status: error
        ? { text: Messages.notAvailable(this.title.label, error), retry: () => void this.refresh() }
        : this.notice
          ? { text: this.notice }
          : empty
            ? { text: Messages.emptyFolder() }
            : undefined,
    });
  }
  ```
  and in `navigateToExisting`, replace the `this.header.setState({ status: … })` call with
  `this.notice = Messages.folderGone(uri.path.base, this.labels.getName(candidate)); this.updateEmptyState();`.

The widget's factory options (`{ id, folder }`) are stored by Theia's layout restorer, which calls
the factory and then `restoreState`, so a restored panel first opens at its creation folder, then
moves to the stored one.

- [ ] **Step 4: Build and run to see them pass**

Expected: 21 passed.

- [ ] **Step 5: Record, check, commit**

```bash
git add apps/theia-shell/packages/theia-file-panels apps/theia-shell/app/tests/file-panels.spec.ts
git commit -m "theia-shell: file panels — restored after reload; a deleted folder moves the panel up

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Documentation and the full check

**Files:**
- Modify: `packages/theia-file-panels/README.md`
- Modify: `README.md` (theia-shell layout table and extension list)
- Modify: `app/README.md` (what the app contains)

- [ ] **Step 1: Package README**

Complete `packages/theia-file-panels/README.md` with: what a panel is and how to open one; the
breadcrumb and its dropdowns; the drop matrix (into a panel → dialog; into the explorer →
Theia's rule, panel drags included); the context menu (own "Open", Theia's commands, Copy/Move to
Other Panel); i18n (the catalog, literal keys, plural categories, `Intl` formatting, no provider
yet); the extension rule and the three protected members used; the red/green table; known limits
(non-atomic cross-mount moves; other Theia file trees do not accept panel drags; the "Files" root
is read-only).

- [ ] **Step 2: Workspace and app READMEs**

Add `packages/theia-file-panels  Midnight-Commander-style file panels (extension)` to the layout
block in `README.md`, and one sentence about panels to `app/README.md`'s feature list.

- [ ] **Step 3: Audit docs against code**

Before merging (standing rule): read every doc comment in `packages/theia-file-panels/src` and the
spec's sections against the code; fix whichever is wrong. In particular check the spec's
*Explorer extension* and *Drops and transfers* sections against Tasks 9–11 as built.

- [ ] **Step 4: Full check**

Run (in `apps/theia-shell`):
```bash
pnpm test
pnpm --filter @theia-shell/app build
cd app && pnpm exec playwright test; cd ..
```
and from the sandbox root: `npx -y @biomejs/biome@2.5.11 check apps/theia-shell`.
Expected: unit tests = Task 0 baseline + the new ones; every e2e suite passes (baseline + 21).

- [ ] **Step 5: Commit**

```bash
git add apps/theia-shell
git commit -m "theia-shell: file panels — documentation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
