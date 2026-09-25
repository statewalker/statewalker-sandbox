import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { seedIfEmpty } from "../src/seed-if-empty";

describe("seedIfEmpty", () => {
  it("writes the seed into an empty FilesApi", async () => {
    const files = new MemFilesApi();
    expect(await seedIfEmpty(files, { "/a.md": "# A", "/d/b.md": "# B" })).toBe(true);
    expect(await readText(files, "/a.md")).toBe("# A");
    expect(await readText(files, "/d/b.md")).toBe("# B");
  });

  it("leaves a FilesApi that has anything in it alone", async () => {
    const files = new MemFilesApi({ initialFiles: { "/mine.md": "mine" } });
    expect(await seedIfEmpty(files, { "/a.md": "# A" })).toBe(false);
    expect(await files.exists("/a.md")).toBe(false);
  });
});
