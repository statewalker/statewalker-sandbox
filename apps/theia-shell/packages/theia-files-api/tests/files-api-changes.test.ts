import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FileChange } from "@theia/filesystem/lib/common/files";
import { describe, expect, it } from "vitest";
import { ChangeType } from "../src/common/const-enums";
import { FilesApiFileSystemProvider, toFileChanges } from "../src/common/files-api-fs-provider";

describe("external changes", () => {
  it("maps FilesApi paths to URIs under the root", () => {
    const changes = toFileChanges("file:///", [
      { type: "added", path: "/cloud" },
      { type: "deleted", path: "/old" },
      { type: "updated", path: "/" },
    ]);
    expect(changes.map((c) => [c.type, c.resource.toString()])).toEqual([
      [ChangeType.ADDED, "file:///cloud"],
      [ChangeType.DELETED, "file:///old"],
      [ChangeType.UPDATED, "file:///"],
    ]);
  });

  it("fires them through the provider's change event", () => {
    const provider = new FilesApiFileSystemProvider(new MemFilesApi());
    const seen: FileChange[] = [];
    provider.onDidChangeFile((changes) => seen.push(...changes));
    provider.notifyChanges(toFileChanges("file:///", [{ type: "added", path: "/cloud" }]));
    provider.notifyChanges([]);
    expect(seen).toHaveLength(1);
    expect(seen[0].resource.path.toString()).toBe("/cloud");
  });
});
