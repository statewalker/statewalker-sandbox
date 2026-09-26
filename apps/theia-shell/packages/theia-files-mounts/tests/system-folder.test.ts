import { readText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { describe, expect, it } from "vitest";
import { copySystemFolder, ensureSystemFolder, hasSystemFolder } from "../src/common/system-folder";

describe("system folder", () => {
  it("is created with its settings folder", async () => {
    const files = new MemFilesApi();
    expect(await hasSystemFolder(files)).toBe(false);
    await ensureSystemFolder(files);
    expect(await hasSystemFolder(files)).toBe(true);
    expect((await files.stats("/.shell/settings"))?.kind).toBe("directory");
    expect((await files.stats("/.shell/workspace"))?.kind).toBe("directory");
    await ensureSystemFolder(files); // idempotent
  });

  it("is copied whole to another storage, user files untouched", async () => {
    const from = new MemFilesApi();
    await writeText(from, "/.shell/settings/settings.json", '{"files.hidden":[]}');
    await writeText(from, "/.shell/vault.key.json", "{}");
    await writeText(from, "/.shell/secrets.json", "{}");
    await writeText(from, "/notes.md", "user file");
    const to = new MemFilesApi();
    await writeText(to, "/mine.md", "theirs");
    await copySystemFolder(from, to);
    expect(await readText(to, "/.shell/settings/settings.json")).toBe('{"files.hidden":[]}');
    expect(await readText(to, "/.shell/vault.key.json")).toBe("{}");
    expect(await to.exists("/notes.md")).toBe(false);
    expect(await readText(to, "/mine.md")).toBe("theirs");
  });
});
