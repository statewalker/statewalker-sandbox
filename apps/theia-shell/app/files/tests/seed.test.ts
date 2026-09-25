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

  it("counts a storage holding only the system folder .shell as empty", async () => {
    const files = new MemFilesApi({ initialFiles: { "/.shell/settings/settings.json": "{}" } });
    expect(await seedIfEmpty(files, { "/a.md": "# A" })).toBe(true);
    expect(await readText(files, "/a.md")).toBe("# A");
  });
});

describe("seedIfEmpty with binary files", () => {
  it("writes Uint8Array entries byte for byte", async () => {
    const files = new MemFilesApi();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await seedIfEmpty(files, { "/img/x.bin": bytes });
    const chunks: Uint8Array[] = [];
    for await (const chunk of files.read("/img/x.bin")) chunks.push(chunk);
    expect(Array.from(chunks.flatMap((c) => Array.from(c)))).toEqual([0, 1, 2, 250, 255]);
  });
});
