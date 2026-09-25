import { readText } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import URI from "@theia/core/lib/common/uri";
import {
  type FileChange,
  FileSystemProviderErrorCode,
  FileType,
} from "@theia/filesystem/lib/common/files";
import { beforeEach, describe, expect, it } from "vitest";
import { Capabilities, ChangeType } from "../src/common/const-enums";
import { FilesApiFileSystemProvider } from "../src/common/files-api-fs-provider";

const enc = new TextEncoder();
const uri = (path: string) => new URI(`file://${path}`);

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? `no code: ${(e as Error).message}`;
  }
}

describe("FilesApiFileSystemProvider", () => {
  let files: MemFilesApi;
  let fs: FilesApiFileSystemProvider;
  // URIs cache derived fields lazily, so changes are compared as strings.
  let changes: { type: FileChange["type"]; resource: string }[];

  beforeEach(() => {
    files = new MemFilesApi({
      initialFiles: {
        "/README.md": "# Hello\n",
        "/docs/guide.md": "## Guide\n",
        "/docs/deep/note.txt": "note",
      },
    });
    fs = new FilesApiFileSystemProvider(files);
    changes = [];
    fs.onDidChangeFile((c) =>
      changes.push(...c.map(({ type, resource }) => ({ type, resource: resource.toString() }))),
    );
  });

  it("declares whole-file read/write and folder copy", () => {
    expect(fs.capabilities & Capabilities.FileReadWrite).toBeTruthy();
    expect(fs.capabilities & Capabilities.FileFolderCopy).toBeTruthy();
    expect(fs.capabilities & Capabilities.PathCaseSensitive).toBeTruthy();
    expect(fs.capabilities & Capabilities.Readonly).toBeFalsy();
  });

  describe("stat", () => {
    it("reports files with size and mtime", async () => {
      const stat = await fs.stat(uri("/README.md"));
      expect(stat.type).toBe(FileType.File);
      expect(stat.size).toBe(8);
      expect(stat.mtime).toBeGreaterThan(0);
    });

    it("reports directories, including the root", async () => {
      expect((await fs.stat(uri("/docs"))).type).toBe(FileType.Directory);
      expect((await fs.stat(uri("/"))).type).toBe(FileType.Directory);
    });

    it("throws FileNotFound for a missing path", async () => {
      expect(await codeOf(fs.stat(uri("/nope")))).toBe(FileSystemProviderErrorCode.FileNotFound);
    });
  });

  describe("readdir", () => {
    it("lists direct children with their types", async () => {
      expect(await fs.readdir(uri("/"))).toEqual([
        ["README.md", FileType.File],
        ["docs", FileType.Directory],
      ]);
      expect(await fs.readdir(uri("/docs"))).toEqual([
        ["deep", FileType.Directory],
        ["guide.md", FileType.File],
      ]);
    });

    it("throws FileNotFound / FileNotADirectory", async () => {
      expect(await codeOf(fs.readdir(uri("/nope")))).toBe(FileSystemProviderErrorCode.FileNotFound);
      expect(await codeOf(fs.readdir(uri("/README.md")))).toBe(
        FileSystemProviderErrorCode.FileNotADirectory,
      );
    });
  });

  describe("readFile", () => {
    it("returns the bytes", async () => {
      expect(new TextDecoder().decode(await fs.readFile(uri("/docs/guide.md")))).toBe("## Guide\n");
    });

    it("throws FileNotFound / FileIsADirectory", async () => {
      expect(await codeOf(fs.readFile(uri("/nope.md")))).toBe(
        FileSystemProviderErrorCode.FileNotFound,
      );
      expect(await codeOf(fs.readFile(uri("/docs")))).toBe(
        FileSystemProviderErrorCode.FileIsADirectory,
      );
    });
  });

  describe("writeFile", () => {
    it("overwrites an existing file and reports UPDATED", async () => {
      await fs.writeFile(uri("/README.md"), enc.encode("# Changed\n"), {
        create: false,
        overwrite: true,
      });
      expect(await readText(files, "/README.md")).toBe("# Changed\n");
      expect(changes).toEqual([{ type: ChangeType.UPDATED, resource: "file:///README.md" }]);
    });

    it("creates a new file and reports ADDED", async () => {
      await fs.writeFile(uri("/docs/new.md"), enc.encode("new"), {
        create: true,
        overwrite: false,
      });
      expect(await readText(files, "/docs/new.md")).toBe("new");
      expect(changes).toEqual([{ type: ChangeType.ADDED, resource: "file:///docs/new.md" }]);
    });

    it("refuses to create without `create`, to overwrite without `overwrite`, or into a missing folder", async () => {
      expect(
        await codeOf(
          fs.writeFile(uri("/x.md"), enc.encode(""), { create: false, overwrite: true }),
        ),
      ).toBe(FileSystemProviderErrorCode.FileNotFound);
      expect(
        await codeOf(
          fs.writeFile(uri("/README.md"), enc.encode(""), { create: true, overwrite: false }),
        ),
      ).toBe(FileSystemProviderErrorCode.FileExists);
      expect(
        await codeOf(
          fs.writeFile(uri("/missing/x.md"), enc.encode(""), { create: true, overwrite: false }),
        ),
      ).toBe(FileSystemProviderErrorCode.FileNotFound);
      expect(
        await codeOf(fs.writeFile(uri("/docs"), enc.encode(""), { create: true, overwrite: true })),
      ).toBe(FileSystemProviderErrorCode.FileIsADirectory);
      expect(await files.exists("/x.md")).toBe(false);
    });
  });

  describe("mkdir", () => {
    it("creates a folder and reports ADDED", async () => {
      await fs.mkdir(uri("/docs/sub"));
      expect((await files.stats("/docs/sub"))?.kind).toBe("directory");
      expect(changes).toEqual([{ type: ChangeType.ADDED, resource: "file:///docs/sub" }]);
    });

    it("throws FileExists for an existing path and FileNotFound for a missing parent", async () => {
      expect(await codeOf(fs.mkdir(uri("/docs")))).toBe(FileSystemProviderErrorCode.FileExists);
      expect(await codeOf(fs.mkdir(uri("/a/b")))).toBe(FileSystemProviderErrorCode.FileNotFound);
    });
  });

  describe("delete", () => {
    it("removes a file and reports DELETED", async () => {
      await fs.delete(uri("/README.md"), { recursive: false, useTrash: false });
      expect(await files.exists("/README.md")).toBe(false);
      expect(changes).toEqual([{ type: ChangeType.DELETED, resource: "file:///README.md" }]);
    });

    it("removes a non-empty folder only when recursive", async () => {
      expect(await codeOf(fs.delete(uri("/docs"), { recursive: false, useTrash: false }))).toBe(
        FileSystemProviderErrorCode.NoPermissions,
      );
      await fs.delete(uri("/docs"), { recursive: true, useTrash: false });
      expect(await files.exists("/docs/guide.md")).toBe(false);
    });

    it("throws FileNotFound for a missing path", async () => {
      expect(await codeOf(fs.delete(uri("/nope"), { recursive: true, useTrash: false }))).toBe(
        FileSystemProviderErrorCode.FileNotFound,
      );
    });
  });

  describe("rename and copy", () => {
    it("moves a file and reports DELETED + ADDED", async () => {
      await fs.rename(uri("/README.md"), uri("/docs/README.md"), { overwrite: false });
      expect(await files.exists("/README.md")).toBe(false);
      expect(await readText(files, "/docs/README.md")).toBe("# Hello\n");
      expect(changes).toEqual([
        { type: ChangeType.DELETED, resource: "file:///README.md" },
        { type: ChangeType.ADDED, resource: "file:///docs/README.md" },
      ]);
    });

    it("moves a folder with its content", async () => {
      await fs.rename(uri("/docs"), uri("/manual"), { overwrite: false });
      expect(await readText(files, "/manual/deep/note.txt")).toBe("note");
    });

    it("respects `overwrite` and a missing source", async () => {
      await files.write("/other.md", [enc.encode("other")]);
      expect(
        await codeOf(fs.rename(uri("/other.md"), uri("/README.md"), { overwrite: false })),
      ).toBe(FileSystemProviderErrorCode.FileExists);
      await fs.rename(uri("/other.md"), uri("/README.md"), { overwrite: true });
      expect(await readText(files, "/README.md")).toBe("other");
      expect(await codeOf(fs.rename(uri("/nope"), uri("/x"), { overwrite: true }))).toBe(
        FileSystemProviderErrorCode.FileNotFound,
      );
    });

    it("copies a folder and reports ADDED", async () => {
      await fs.copy(uri("/docs"), uri("/docs-copy"), { overwrite: false });
      expect(await readText(files, "/docs-copy/guide.md")).toBe("## Guide\n");
      expect(await readText(files, "/docs/guide.md")).toBe("## Guide\n");
      expect(changes).toEqual([{ type: ChangeType.ADDED, resource: "file:///docs-copy" }]);
    });
  });

  it("accepts a lazily provided FilesApi", async () => {
    const lazy = new FilesApiFileSystemProvider(async () => files);
    expect((await lazy.stat(uri("/README.md"))).type).toBe(FileType.File);
  });
});
