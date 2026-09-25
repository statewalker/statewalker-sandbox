import { writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import {
  applyLayers,
  type FilesApiLayer,
  hiddenPathsFilter,
  systemFolderFilter,
} from "../src/common/layers";

async function names(
  api: MemFilesApi | ReturnType<typeof applyLayers>,
  path: string,
): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of api.list(path)) found.push(entry.name);
  return found.sort();
}

describe("layers", () => {
  it("wraps in priority order, lowest closest to the root", () => {
    const order: string[] = [];
    const layer = (id: string, priority: number): FilesApiLayer => ({
      id,
      priority,
      wrap: (api) => {
        order.push(id);
        return api;
      },
    });
    applyLayers(new MemFilesApi(), [layer("outer", 10), layer("inner", 0)]);
    expect(order).toEqual(["inner", "outer"]);
  });

  it("hides globbed paths from listing, stats and reads, and refuses writes", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/m/.git/HEAD", "ref");
    await writeText(files, "/m/a.log", "log");
    await writeText(files, "/m/a.md", "# a");
    const view = hiddenPathsFilter(["**/.git", "**/.git/**", "**/*.log"])(files);
    expect(await names(view, "/m")).toEqual(["a.md"]);
    expect(await view.stats("/m/.git/HEAD")).toBeUndefined();
    await expect(writeText(view, "/m/b.log", "x")).rejects.toThrow();
    expect(hiddenPathsFilter([])(files)).toBe(files);
  });

  it("skips globs that cannot be compiled, reports them, and still applies the rest", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/m/a.log", "log");
    await writeText(files, "/m/a.md", "# a");
    const invalid: unknown[] = [];
    const view = hiddenPathsFilter(["[abc", "a{b", 1 as unknown as string, "**/*.log"], (glob) =>
      invalid.push(glob),
    )(files);
    expect(await names(view, "/m")).toEqual(["a.md"]);
    expect(invalid).toEqual(["[abc", "a{b", 1]);
  });

  it("hides the main storage's system folder", async () => {
    const files = new MemFilesApi();
    await writeText(files, "/browser/.shell/settings/settings.json", "{}");
    await writeText(files, "/browser/notes.md", "");
    const view = systemFolderFilter("/browser/.shell")(files);
    expect(await names(view, "/browser")).toEqual(["notes.md"]);
    expect(systemFolderFilter(undefined)(files)).toBe(files);
  });
});
