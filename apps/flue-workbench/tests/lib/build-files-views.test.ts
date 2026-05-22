import { readText, tryReadText, writeText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFilesViews } from "../../src/lib/build-files-views.js";

describe("buildFilesViews", () => {
  let rootFiles: MemFilesApi;

  beforeEach(async () => {
    rootFiles = new MemFilesApi();
    await writeText(rootFiles, "/notes.md", "user notes\n");
    await writeText(rootFiles, "/workspace/main.ts", "console.log('hi')\n");
    await writeText(rootFiles, "/.settings/secrets.json", '{"GEMINI_API_KEY":"AIza-test"}');
    await writeText(rootFiles, "/.settings/sessions/abc.json", "{}");
  });

  it("returns the system + user views", () => {
    const views = buildFilesViews(rootFiles);
    expect(views.systemFiles).toBeDefined();
    expect(views.userFiles).toBeDefined();
  });

  describe("Scenario: list does not show .settings on the user view", () => {
    it("userFiles.list('/') omits .settings", async () => {
      const { userFiles } = buildFilesViews(rootFiles);
      const names: string[] = [];
      for await (const entry of userFiles.list("/")) names.push(entry.name);
      expect(names).toContain("notes.md");
      expect(names).toContain("workspace");
      expect(names).not.toContain(".settings");
    });
  });

  describe("Scenario: read on hidden path fails through userFiles", () => {
    it("userFiles.exists('/.settings/secrets.json') is false", async () => {
      const { userFiles } = buildFilesViews(rootFiles);
      expect(await userFiles.exists("/.settings/secrets.json")).toBe(false);
    });

    it("readText through userFiles returns empty for a hidden secrets path", async () => {
      const { userFiles } = buildFilesViews(rootFiles);
      // FilteredFilesApi short-circuits hidden reads to empty iterable.
      // readText() returns "" in that case (matches FilesApi contract for missing files).
      const got = await tryReadText(userFiles, "/.settings/secrets.json");
      // tryReadText returns undefined when the file doesn't exist according to the view.
      expect(got).toBeUndefined();
    });
  });

  describe("Scenario: system view sees only .settings", () => {
    it("systemFiles can read /.settings/secrets.json", async () => {
      const { systemFiles } = buildFilesViews(rootFiles);
      expect(await systemFiles.exists("/.settings/secrets.json")).toBe(true);
      expect(await readText(systemFiles, "/.settings/secrets.json")).toContain("GEMINI_API_KEY");
    });

    it("systemFiles cannot read /notes.md", async () => {
      const { systemFiles } = buildFilesViews(rootFiles);
      expect(await systemFiles.exists("/notes.md")).toBe(false);
    });

    // Root is intentionally NOT visible through the system view — the predicate
    // matches only paths under /.settings/**. Production callers (SecretStore,
    // SessionStore) reach files by direct path, not by walking the root tree,
    // so this is fine. Listing `/` therefore yields nothing.
    it("systemFiles list at root yields nothing (predicate doesn't match `/`)", async () => {
      const { systemFiles } = buildFilesViews(rootFiles);
      const names: string[] = [];
      for await (const entry of systemFiles.list("/")) names.push(entry.name);
      expect(names).toEqual([]);
    });

    it("systemFiles list at /.settings yields its contents", async () => {
      const { systemFiles } = buildFilesViews(rootFiles);
      const names: string[] = [];
      for await (const entry of systemFiles.list("/.settings")) names.push(entry.name);
      expect(names).toContain("secrets.json");
      expect(names).toContain("sessions");
    });
  });
});
