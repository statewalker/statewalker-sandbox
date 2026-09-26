import { describe, expect, it } from "vitest";
import {
  updateWorkspaceFile,
  WORKSPACE_FILE_URI,
  workspaceRoots,
} from "../src/common/workspace-file";

describe("updateWorkspaceFile", () => {
  it("lists one file:/// folder per mount, in order, with its name", () => {
    const text = updateWorkspaceFile(undefined, [
      { key: "browser", name: "Browser Storage" },
      { key: "temp", name: "Temporary" },
    ]) as string;
    expect(JSON.parse(text).folders).toEqual([
      { path: "file:///browser", name: "Browser Storage" },
      { path: "file:///temp", name: "Temporary" },
    ]);
  });

  it("changes when only a name changes (a rename must reach the explorer)", () => {
    const before = updateWorkspaceFile(undefined, [{ key: "a", name: "A" }]) as string;
    expect(updateWorkspaceFile(before, [{ key: "a", name: "Renamed" }])).toBeDefined();
  });

  it("keeps everything else in the file, and rewrites only folders", () => {
    const existing = JSON.stringify({
      folders: [{ path: "file:///stray" }],
      settings: { "editor.fontSize": 16 },
    });
    const next = JSON.parse(
      updateWorkspaceFile(existing, [{ key: "browser", name: "B" }]) as string,
    );
    expect(next.settings).toEqual({ "editor.fontSize": 16 });
    expect(next.folders).toEqual([{ path: "file:///browser", name: "B" }]);
  });

  it("returns undefined when nothing changes", () => {
    const text = updateWorkspaceFile(undefined, [{ key: "browser", name: "B" }]) as string;
    expect(updateWorkspaceFile(text, [{ key: "browser", name: "B" }])).toBeUndefined();
  });

  it("replaces a file that is not valid JSON", () => {
    expect(
      JSON.parse(updateWorkspaceFile("{ oops", [{ key: "browser", name: "B" }]) as string).folders,
    ).toHaveLength(1);
  });
});

describe("workspaceRoots", () => {
  it("leaves out system mounts (keys starting with a dot)", () => {
    const roots = workspaceRoots([
      { key: "browser", name: "B" },
      { key: ".workspace", name: "W" },
      { key: "temp", name: "T" },
    ]);
    expect(roots.map((r) => r.key)).toEqual(["browser", "temp"]);
  });

  it("puts the workspace file in the file: tree, under the system mount", () => {
    expect(WORKSPACE_FILE_URI).toBe("file:///.workspace/mounts.theia-workspace");
  });
});
