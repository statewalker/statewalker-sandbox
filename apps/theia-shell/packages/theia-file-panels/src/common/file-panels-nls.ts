import { nls } from "@theia/core/lib/common/nls";
import { formatCount, pluralCategory } from "./format";
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
    nls.localize(
      "theia-shell/file-panels/notAvailable",
      "“{0}” is not available: {1}",
      name,
      reason,
    ),
  retry: () => nls.localize("theia-shell/file-panels/retry", "Retry"),

  transferTitle: (count: number, name: string, locale = currentLocale()) => {
    const n = formatCount(count, locale);
    switch (pluralCategory(count, locale)) {
      case "one":
        return nls.localize(
          "theia-shell/file-panels/transferTitle.one",
          "Copy or move “{1}”",
          n,
          name,
        );
      case "zero":
        return nls.localize(
          "theia-shell/file-panels/transferTitle.zero",
          "Copy or move {0} items",
          n,
          name,
        );
      case "two":
        return nls.localize(
          "theia-shell/file-panels/transferTitle.two",
          "Copy or move {0} items",
          n,
          name,
        );
      case "few":
        return nls.localize(
          "theia-shell/file-panels/transferTitle.few",
          "Copy or move {0} items",
          n,
          name,
        );
      case "many":
        return nls.localize(
          "theia-shell/file-panels/transferTitle.many",
          "Copy or move {0} items",
          n,
          name,
        );
      default:
        return nls.localize(
          "theia-shell/file-panels/transferTitle.other",
          "Copy or move {0} items",
          n,
          name,
        );
    }
  },
  sameFolderTitle: (count: number, name: string, locale = currentLocale()) => {
    const n = formatCount(count, locale);
    switch (pluralCategory(count, locale)) {
      case "one":
        return nls.localize(
          "theia-shell/file-panels/sameFolderTitle.one",
          "Copy or rename “{1}”",
          n,
          name,
        );
      case "zero":
        return nls.localize(
          "theia-shell/file-panels/sameFolderTitle.zero",
          "Copy {0} items",
          n,
          name,
        );
      case "two":
        return nls.localize(
          "theia-shell/file-panels/sameFolderTitle.two",
          "Copy {0} items",
          n,
          name,
        );
      case "few":
        return nls.localize(
          "theia-shell/file-panels/sameFolderTitle.few",
          "Copy {0} items",
          n,
          name,
        );
      case "many":
        return nls.localize(
          "theia-shell/file-panels/sameFolderTitle.many",
          "Copy {0} items",
          n,
          name,
        );
      default:
        return nls.localize(
          "theia-shell/file-panels/sameFolderTitle.other",
          "Copy {0} items",
          n,
          name,
        );
    }
  },
  clashCount: (count: number, locale = currentLocale()) => {
    const n = formatCount(count, locale);
    switch (pluralCategory(count, locale)) {
      case "one":
        return nls.localize(
          "theia-shell/file-panels/clashCount.one",
          "{0} item already exists in the target:",
          n,
        );
      case "zero":
        return nls.localize(
          "theia-shell/file-panels/clashCount.zero",
          "{0} items already exist in the target:",
          n,
        );
      case "two":
        return nls.localize(
          "theia-shell/file-panels/clashCount.two",
          "{0} items already exist in the target:",
          n,
        );
      case "few":
        return nls.localize(
          "theia-shell/file-panels/clashCount.few",
          "{0} items already exist in the target:",
          n,
        );
      case "many":
        return nls.localize(
          "theia-shell/file-panels/clashCount.many",
          "{0} items already exist in the target:",
          n,
        );
      default:
        return nls.localize(
          "theia-shell/file-panels/clashCount.other",
          "{0} items already exist in the target:",
          n,
        );
    }
  },
  targetFolder: (name: string) =>
    nls.localize("theia-shell/file-panels/targetFolder", "To: {0}", name),
  opCopy: () => nls.localize("theia-shell/file-panels/opCopy", "Copy"),
  opMove: () => nls.localize("theia-shell/file-panels/opMove", "Move"),
  opRename: () => nls.localize("theia-shell/file-panels/opRename", "Rename"),
  nameLabel: () => nls.localize("theia-shell/file-panels/nameLabel", "Name"),
  nameExists: (name: string) =>
    nls.localize(
      "theia-shell/file-panels/nameExists",
      "“{0}” already exists — it will be replaced",
      name,
    ),
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
  transferring: () =>
    nls.localize("theia-shell/file-panels/transferring", "Copying and moving files"),
  progressStep: (done: number, total: number, locale = currentLocale()) =>
    nls.localize(
      "theia-shell/file-panels/progressStep",
      "{0} of {1}",
      formatCount(done, locale),
      formatCount(total, locale),
    ),
  /** Plural on `total`: "1 of 1 item failed", "1 of 7 items failed". */
  itemsFailed: (failed: number, total: number, locale = currentLocale()) => {
    const f = formatCount(failed, locale);
    const t = formatCount(total, locale);
    switch (pluralCategory(total, locale)) {
      case "one":
        return nls.localize(
          "theia-shell/file-panels/itemsFailed.one",
          "{0} of {1} item failed",
          f,
          t,
        );
      case "zero":
        return nls.localize(
          "theia-shell/file-panels/itemsFailed.zero",
          "{0} of {1} items failed",
          f,
          t,
        );
      case "two":
        return nls.localize(
          "theia-shell/file-panels/itemsFailed.two",
          "{0} of {1} items failed",
          f,
          t,
        );
      case "few":
        return nls.localize(
          "theia-shell/file-panels/itemsFailed.few",
          "{0} of {1} items failed",
          f,
          t,
        );
      case "many":
        return nls.localize(
          "theia-shell/file-panels/itemsFailed.many",
          "{0} of {1} items failed",
          f,
          t,
        );
      default:
        return nls.localize(
          "theia-shell/file-panels/itemsFailed.other",
          "{0} of {1} items failed",
          f,
          t,
        );
    }
  },
  /** One line of a failure report: the item's name and why it failed. */
  failureLine: (name: string, reason: string) =>
    nls.localize("theia-shell/file-panels/failureLine", "{0}: {1}", name, reason),
  /** A drop or transfer that failed as a whole (not one step of it). */
  transferFailed: (reason: string) =>
    nls.localize("theia-shell/file-panels/transferFailed", "Copy or move failed: {0}", reason),
} as const;
