import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { buildFolderList } from "../src/common/folder-list";
import type { MountType } from "../src/common/mount-types";

const type = (id: string, label: string, available = true, newLabel?: string): MountType => ({
  id,
  label,
  newLabel,
  fields: [],
  isAvailable: () => available,
  create: async () => new MemFilesApi(),
});
const types = new Map([
  ["memory", type("memory", "In Memory", true, "New In-Memory Folder…")],
  ["opfs", type("opfs", "Browser Storage (OPFS)")],
  ["local-folder", type("local-folder", "Folder on this Computer", false)],
]);

describe("buildFolderList", () => {
  it("lists remembered folders, unreferenced browser-storage folders, then new ones", () => {
    const entries = [
      { key: "temp", name: "Temporary", type: "memory", config: {} },
      {
        key: "drafts",
        name: "Drafts",
        type: "opfs",
        config: { directory: "drafts" },
        mounted: false,
      },
      { key: "old", name: "Old", type: "opfs", config: { directory: "old" } },
    ];
    const items = buildFolderList(entries, types, ["old", "archive", "drafts", "zeta"]);
    expect(items.map((i) => [i.kind, i.label])).toEqual([
      ["remembered", "Drafts"],
      ["opfs", "archive"],
      ["opfs", "zeta"],
      ["new", "New In-Memory Folder…"],
      ["new", "New Browser Storage (OPFS)…"],
    ]);
    expect(items[0]).toMatchObject({ description: "Browser Storage (OPFS)" });
  });
});
