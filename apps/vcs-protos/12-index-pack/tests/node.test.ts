import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { applyDelta, DeltaError } from "../src/delta.js";
import { git, noise, packAll, repoWithHistory } from "../src/git-repo.js";
import { installPack, PackError } from "../src/index-pack.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6-"));
  dirs.push(d);
  return d;
};
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main", "."]);
  return d;
};
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
/** git's own .idx for `pack`. */
function gitIdx(pack: Uint8Array): Uint8Array {
  const d = tmp();
  writeFileSync(join(d, "p.pack"), pack);
  git(d, ["index-pack", "-o", join(d, "p.idx"), join(d, "p.pack")]);
  return new Uint8Array(readFileSync(join(d, "p.idx")));
}
/** offset → [oid, crc] from `git show-index`. */
function showIndex(idx: Uint8Array): Map<number, [string, number]> {
  const out = git(tmp(), ["show-index"], idx).toString().trim().split("\n");
  return new Map(
    out.map((l) => {
      const [off, oid, crc] = l.split(" ");
      return [Number(off), [oid as string, Number.parseInt((crc ?? "").replace(/[()]/g, ""), 16)]];
    }),
  );
}
const install = async (pack: Uint8Array, repo = emptyRepo()) => {
  const files = new StreamingNodeFilesApi(join(repo, ".git"));
  return { repo, result: await installPack(files, "/objects/pack", chunks(pack)) };
};
const packDirOf = (repo: string) => readdirSync(join(repo, ".git", "objects", "pack")).sort();

const history = repoWithHistory(60);
const withBig = repoWithHistory(3, { bigBlobBytes: 4 * 2 ** 20 });
const aggressive = (() => {
  const r = repoWithHistory(60);
  git(r, ["gc", "-q", "--aggressive"]);
  const p = readdirSync(join(r, ".git", "objects", "pack")).find((n) =>
    n.endsWith(".pack"),
  ) as string;
  return new Uint8Array(readFileSync(join(r, ".git", "objects", "pack", p)));
})();
const variants: [string, Uint8Array][] = [
  ["OFS_DELTA (--delta-base-offset)", packAll(history, true)],
  ["REF_DELTA", packAll(history, false)],
  ["gc --aggressive (deep chains)", aggressive],
  ["a 4 MiB incompressible blob and a delta against it", packAll(withBig, true)],
];

describe("R1 our .idx equals git index-pack's", () => {
  for (const [name, pack] of variants) {
    it(name, async () => {
      const { result } = await install(pack);
      const ref = gitIdx(pack);
      const byOffset = showIndex(ref);
      expect(result.entries.length).toBe(byOffset.size);
      expect(result.entries.length).toBeGreaterThan(name.startsWith("a 4") ? 10 : 300);
      for (const e of result.entries)
        expect([e.oid, e.crc32], `offset ${e.offset}`).toEqual(byOffset.get(e.offset));
      expect(Buffer.from(result.idx).equals(Buffer.from(ref))).toBe(true);
    }, 120_000);
  }
});

describe("R2 native git reads an installed pack", () => {
  it("verify-pack, fsck --full and cat-file of every object", async () => {
    const pack = variants[0]?.[1] as Uint8Array;
    const { repo, result } = await install(pack);
    expect(packDirOf(repo)).toEqual([`pack-${result.packId}.idx`, `pack-${result.packId}.pack`]);
    git(repo, ["verify-pack", join(repo, ".git", "objects", "pack", `pack-${result.packId}.idx`)]);
    git(repo, ["fsck", "--full", "--no-dangling"]);
    for (const e of result.entries) {
      expect(git(repo, ["cat-file", "-t", e.oid]).toString().trim()).toBe(e.type);
      expect(
        git(repo, ["cat-file", e.type, e.oid]).equals(git(history, ["cat-file", e.type, e.oid])),
      ).toBe(true);
    }
  }, 120_000);
});

describe("R2b install order (git's finish_tmp_packfile)", () => {
  it("the pack is renamed into place before the idx; temporaries never under final names", async () => {
    const repo = emptyRepo();
    const files = new StreamingNodeFilesApi(join(repo, ".git"));
    const moves: string[] = [];
    const move = files.move.bind(files);
    files.move = async (a, b) => {
      moves.push(
        `${a
          .split("/")
          .pop()
          ?.replace(/_[0-9a-f]+$/, "_*")} -> ${b
          .split("/")
          .pop()
          ?.replace(/[0-9a-f]{40}/, "<id>")}`,
      );
      return move(a, b);
    };
    await installPack(files, "/objects/pack", chunks(variants[0]?.[1] as Uint8Array));
    expect(moves).toEqual(["tmp_pack_* -> pack-<id>.pack", "tmp_idx_* -> pack-<id>.idx"]);
  });
});

describe("R3 corrupt packs are refused and leave nothing behind", () => {
  const good = variants[0]?.[1] as Uint8Array;
  const flip = (b: Uint8Array, at: number) => {
    const c = b.slice();
    c[at] = (c[at] as number) ^ 0x40;
    return c;
  };
  /** An OFS_DELTA entry whose base offset points before the pack start. */
  const badOfs = (() => {
    const c = good.slice();
    let pos = 12;
    // find the first OFS_DELTA header (type 6) by scanning entry headers via git's own idx offsets
    const offsets = [...showIndex(gitIdx(good)).keys()].sort((a, b) => a - b);
    for (const off of offsets) {
      pos = off;
      let b = c[pos] as number;
      if (((b >> 4) & 7) !== 6) continue;
      while (b & 0x80) b = c[++pos] as number;
      c[pos + 1] = 0x7f; // huge back-offset (single byte, continuation clear)
      return c;
    }
    throw new Error("no OFS_DELTA entry in the pack");
  })();
  const thin = (() => {
    // a pack of the last commit's objects only, with REF_DELTA bases outside it
    return new Uint8Array(
      git(history, ["pack-objects", "--stdout", "-q", "--thin", "--revs"], "HEAD\n^HEAD~1\n"),
    );
  })();
  /** The first entry's declared size + 1, with a recomputed trailer: only the size check can catch it. */
  const sizeLie = (() => {
    const c = good.slice();
    const b = c[12] as number;
    c[12] = (b & 0xf0) | (((b & 0x0f) + 1) & 0x0f);
    if ((b & 0x0f) === 0x0f) throw new Error("pick another entry");
    c.set(
      createHash("sha1")
        .update(c.subarray(0, c.length - 20))
        .digest(),
      c.length - 20,
    );
    return c;
  })();
  const cases: [string, Uint8Array][] = [
    ["truncated", good.subarray(0, good.length - 100)],
    ["an entry's declared size disagrees with its data (trailer recomputed)", sizeLie],
    ["trailer flipped", flip(good, good.length - 1)],
    ["a compressed byte flipped", flip(good, Math.floor(good.length / 2))],
    ["OFS_DELTA base outside the pack", badOfs],
    ["REF_DELTA base absent (thin pack)", thin],
    ["bytes after the trailer", Uint8Array.of(...good, 1, 2, 3)],
  ];
  for (const [name, bytes] of cases) {
    it(name, async () => {
      const repo = emptyRepo();
      await expect(install(bytes, repo)).rejects.toBeInstanceOf(PackError);
      expect(packDirOf(repo)).toEqual([]);
    });
  }
  it("errors are PackError", async () => {
    await expect(install(good.subarray(0, 40))).rejects.toBeInstanceOf(PackError);
  });
});

describe("R4 memory bounded by the delta chain, not the pack", () => {
  it("a 64 MiB pack of incompressible 1 MiB blobs is indexed with < 16 MiB live", async () => {
    const src = emptyRepo();
    const ids: string[] = [];
    for (let i = 0; i < 64; i++) {
      writeFileSync(join(src, "b"), noise(2 ** 20, 1000 + i));
      ids.push(git(src, ["hash-object", "-w", "b"]).toString().trim());
    }
    const pack = new Uint8Array(
      git(src, ["pack-objects", "--stdout", "-q"], `${ids.join("\n")}\n`),
    );
    const gc = (globalThis as { gc?: () => void }).gc;
    const mem = () => {
      const m = process.memoryUsage();
      return m.heapUsed + m.arrayBuffers;
    };
    const repo = emptyRepo();
    const files = new StreamingNodeFilesApi(join(repo, ".git"));
    // sample inside every read of the stored pack (node fs work is async, but sample in-loop to be sure)
    let peak = 0;
    let base = 0;
    let reads = 0;
    const read = files.read.bind(files);
    files.read = (p, o) =>
      (async function* () {
        for await (const c of read(p, o)) {
          if (++reads % 256 === 0) {
            gc?.();
            peak = Math.max(peak, mem() - base);
          }
          yield c;
        }
      })();
    gc?.();
    await new Promise((r) => setTimeout(r, 50));
    gc?.();
    base = mem();
    const r = await installPack(files, "/objects/pack", chunks(pack));
    gc?.();
    peak = Math.max(peak, mem() - base);
    console.log(
      `R4 ${pack.length >> 20} MiB pack: peak +${(peak / 2 ** 20).toFixed(1)} MiB live, ${reads} reads`,
    );
    expect(r.entries.length).toBe(64);
    expect(peak).toBeLessThan(16 * 2 ** 20);
    expect(Buffer.from(r.idx).equals(Buffer.from(gitIdx(pack)))).toBe(true);
  }, 300_000);
});

describe("R6 delta application refuses malformed deltas", () => {
  const varint = (n: number) => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  };
  const base = new TextEncoder().encode("0123456789");
  const copy = (off: number, len: number) => [0x80 | 0x01 | 0x10, off, len]; // offset byte 0, size byte 0
  it("applies a valid delta (copy + insert)", () => {
    const d = Uint8Array.from([...varint(10), ...varint(7), ...copy(2, 4), 3, 120, 121, 122]);
    expect(new TextDecoder().decode(applyDelta(base, d))).toBe("2345xyz");
  });
  const bad: [string, number[]][] = [
    ["base size mismatch", [...varint(11), ...varint(4), ...copy(0, 4)]],
    ["copy beyond the base", [...varint(10), ...varint(4), ...copy(8, 4)]],
    ["result longer than declared", [...varint(10), ...varint(3), ...copy(0, 4)]],
    ["result shorter than declared", [...varint(10), ...varint(5), ...copy(0, 4)]],
    ["truncated insert", [...varint(10), ...varint(3), 3, 120]],
    ["truncated copy operands", [...varint(10), ...varint(4), 0x80 | 0x01 | 0x10, 0]],
    ["instruction 0", [...varint(10), ...varint(1), 0]],
  ];
  for (const [name, bytes] of bad) {
    it(name, () => {
      expect(() => applyDelta(base, Uint8Array.from(bytes))).toThrow(DeltaError);
    });
  }
});

describe("R5 inside a Durable Object (SqliteFilesApi)", () => {
  let mf: Miniflare;
  beforeAll(async () => {
    const out = await build({
      entryPoints: [fileURLToPath(new URL("../src/do-entry.ts", import.meta.url))],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      logLevel: "silent",
      loader: { ".pack": "binary", ".idx": "binary" },
    });
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { PACKS: { className: "PacksDo", useSQLite: true } },
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  it("the fixture pack is indexed byte-identically to git's .idx", async () => {
    const r = (await (await mf.dispatchFetch("http://x/index", { method: "POST" })).json()) as {
      same?: boolean;
      entries?: number;
      error?: string;
    };
    expect(r).toEqual({ same: true, entries: expect.any(Number) });
  }, 60_000);
});
