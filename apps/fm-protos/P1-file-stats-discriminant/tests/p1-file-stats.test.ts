import { describe, expect, it } from "vitest";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FilesApi, FileStats } from "@statewalker/webrun-files";
import { narrowStats, sizeCell, compareEntries, type Stats } from "@fm/core";

/**
 * P1 — the substrate must tell the truth.
 *
 * The optionality of `size` / `lastModified` was never expressing adapter
 * capability; it expressed a property of the entry KIND, collapsed into one
 * type because `kind` was a field rather than a discriminant.
 *
 * This is the conformance case that goes upstream into webrun-files-tests. It
 * runs FIRST, before the type flip: it is what surfaces any adapter currently
 * returning `size: undefined` on a file.
 */

/** An adapter that reports a file with no size — the bug the suite must catch. */
class LyingFilesApi extends MemFilesApi {
  async stats(path: string): Promise<FileStats | undefined> {
    const s = await super.stats(path);
    if (!s) return s;
    return s.kind === "file" ? { kind: "file" } : s;
  }
}

/** An adapter that reports a directory with a synthesised size — also a lie. */
class InventingFilesApi extends MemFilesApi {
  async stats(path: string): Promise<FileStats | undefined> {
    const s = await super.stats(path);
    if (!s) return s;
    return s.kind === "directory" ? { kind: "directory", size: 0, lastModified: 0 } : s;
  }
}

const seed = { "/dir/a.txt": "aaa", "/dir/empty.bin": "" };

function conformance(name: string, make: () => FilesApi) {
  describe(`discriminant conformance · ${name}`, () => {
    it("returns exactly the file variant for a file", async () => {
      const api = make();
      const stats = narrowStats((await api.stats("/dir/a.txt"))!);
      expect(stats.kind).toBe("file");
      expect(typeof (stats as Extract<Stats, { kind: "file" }>).size).toBe("number");
      expect(typeof (stats as Extract<Stats, { kind: "file" }>).lastModified).toBe("number");
    });

    it("narrows a directory to exactly the directory variant, dropping extras", async () => {
      const api = make();
      // MemFilesApi happens to report `lastModified` on directories; S3 cannot.
      // The union defines what a CONSUMER may rely on, so extras are dropped at
      // the boundary rather than treated as adapter non-conformance.
      const stats = narrowStats((await api.stats("/dir"))!);
      expect(stats).toEqual({ kind: "directory" });
    });

    it("treats a zero-byte file as the file variant with size 0", async () => {
      const api = make();
      const stats = narrowStats((await api.stats("/dir/empty.bin"))!);
      expect(stats).toEqual({ kind: "file", size: 0, lastModified: expect.any(Number) });
    });

    it("narrows every entry of a listing", async () => {
      const api = make();
      for await (const entry of api.list("/dir")) {
        expect(() => narrowStats(entry)).not.toThrow();
      }
    });
  });
}

conformance("MemFilesApi", () => new MemFilesApi({ initialFiles: seed }));

describe("the conformance suite has teeth", () => {
  it("fails an adapter that reports a file with no size", async () => {
    const api = new LyingFilesApi({ initialFiles: seed });
    await expect(async () => narrowStats((await api.stats("/dir/a.txt"))!)).rejects.toThrow(
      /file variant/i,
    );
  });

  it("stops a synthesised directory size from ever reaching a row", async () => {
    const api = new InventingFilesApi({ initialFiles: seed });
    const raw = (await api.stats("/dir"))!;
    expect((raw as { size?: number }).size).toBe(0); // the adapter invented it
    expect(sizeCell(narrowStats(raw))).toBe(""); // narrowing is the barrier
  });
});

describe("consequences for the panel row", () => {
  it("a directory renders a blank size cell rather than degrading the column", () => {
    expect(sizeCell({ kind: "directory" })).toBe("");
    expect(sizeCell({ kind: "file", size: 0, lastModified: 1 })).toBe("0");
    expect(sizeCell({ kind: "file", size: 1234, lastModified: 1 })).toBe("1234");
  });

  it("sorting orders directories separately instead of being disabled", () => {
    const rows = [
      { name: "b.txt", stats: { kind: "file", size: 10, lastModified: 1 } as Stats },
      { name: "zdir", stats: { kind: "directory" } as Stats },
      { name: "a.txt", stats: { kind: "file", size: 99, lastModified: 1 } as Stats },
      { name: "adir", stats: { kind: "directory" } as Stats },
    ];
    expect(rows.slice().sort(compareEntries("name")).map((r) => r.name)).toEqual([
      "adir", "zdir", "a.txt", "b.txt",
    ]);
    expect(rows.slice().sort(compareEntries("size")).map((r) => r.name)).toEqual([
      "adir", "zdir", "b.txt", "a.txt",
    ]);
  });
});
