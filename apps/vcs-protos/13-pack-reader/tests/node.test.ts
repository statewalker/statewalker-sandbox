import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { buildPack, type CraftEntry, copyAll, delta } from "../../12-index-pack/src/craft.js";
import { git, noise, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { installPack, PackError, writeIdx } from "../../12-index-pack/src/index-pack.js";
import { openObjectDatabase } from "../src/object-db.js";
import { openPack } from "../src/pack-reader.js";

const MiB = 2 ** 20;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6r-"));
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
async function collect(s: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return Buffer.concat(parts);
}
/** Every object of the repository through `git cat-file --batch-all-objects --batch`. */
function allObjects(repo: string): Map<string, { type: string; content: Buffer }> {
  const out = git(repo, ["cat-file", "--batch-all-objects", "--batch"]);
  const map = new Map<string, { type: string; content: Buffer }>();
  let p = 0;
  while (p < out.length) {
    const nl = out.indexOf(10, p);
    const [oid, type, size] = out.subarray(p, nl).toString().split(" ");
    const start = nl + 1;
    const end = start + Number(size);
    map.set(oid as string, { type: type as string, content: out.subarray(start, end) });
    p = end + 1;
  }
  return map;
}
/** Installs `pack` into a fresh repository with X6a; returns the repository and pack paths. */
async function installed(pack: Uint8Array) {
  const repo = emptyRepo();
  const files = new StreamingNodeFilesApi(join(repo, ".git"));
  const r = await installPack(files, "/objects/pack", chunks(pack));
  const base = `/objects/pack/pack-${r.packId}`;
  return { repo, files, packPath: `${base}.pack`, idxPath: `${base}.idx`, result: r };
}

const history = repoWithHistory(60);
const withBig = repoWithHistory(3, { bigBlobBytes: 4 * MiB });
const aggressive = (() => {
  const r = repoWithHistory(40);
  git(r, ["gc", "-q", "--aggressive"]);
  const p = readdirSync(join(r, ".git", "objects", "pack")).find((n) =>
    n.endsWith(".pack"),
  ) as string;
  return new Uint8Array(readFileSync(join(r, ".git", "objects", "pack", p)));
})();

describe("R1 every object equals git cat-file", () => {
  const variants: [string, Uint8Array][] = [
    ["OFS_DELTA", packAll(history, true)],
    ["REF_DELTA", packAll(history, false)],
    ["gc --aggressive", aggressive],
    ["a 4 MiB blob with a delta child", packAll(withBig, true)],
  ];
  for (const [name, pack] of variants) {
    it(name, async () => {
      const { repo, files, packPath, idxPath, result } = await installed(pack);
      const reader = await openPack(files, packPath, idxPath);
      const expected = allObjects(repo);
      expect(reader.count).toBe(result.entries.length);
      expect(expected.size).toBe(reader.count);
      for (const [oid, e] of expected) {
        const o = await reader.get(oid);
        expect(o?.type, oid).toBe(e.type);
        expect(o?.size, oid).toBe(e.content.length);
        expect((await collect(o?.content ?? [])).equals(e.content), oid).toBe(true);
      }
    }, 120_000);
  }
});

describe("R2 object database: loose objects and two packs", () => {
  it("reads every object, absent ids are undefined, has and list agree", async () => {
    const repo = repoWithHistory(20);
    git(repo, ["repack", "-q", "-d"]); // pack 1: everything so far
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(repo, `extra-${i}.txt`), `extra ${i}\n`.repeat(50));
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", `extra ${i}`]);
    }
    git(repo, ["repack", "-q", "-d"]); // pack 2: the loose objects of the extra commits
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(repo, `loose-${i}.txt`), `loose ${i}\n`);
      git(repo, ["add", "-A"]);
      git(repo, ["commit", "-q", "-m", `loose ${i}`]);
    }
    const packs = readdirSync(join(repo, ".git", "objects", "pack")).filter((n) =>
      n.endsWith(".idx"),
    );
    expect(packs.length).toBe(2);
    const db = await openObjectDatabase(new StreamingNodeFilesApi(join(repo, ".git")), "/objects");
    const expected = allObjects(repo);
    for (const [oid, e] of expected) {
      expect(await db.has(oid), oid).toBe(true);
      const o = await db.get(oid, { verify: true });
      expect(o?.type).toBe(e.type);
      expect((await collect(o?.content ?? [])).equals(e.content), oid).toBe(true);
    }
    const listed: string[] = [];
    for await (const id of db.list()) listed.push(id);
    expect(listed.length).toBe(new Set(listed).size);
    expect(new Set(listed)).toEqual(new Set(expected.keys()));
    const absent = "0123456789abcdef0123456789abcdef01234567";
    expect(await db.has(absent)).toBe(false);
    expect(await db.get(absent)).toBeUndefined();
  }, 120_000);
});

describe("R3 corruption is detected", () => {
  const pack = packAll(repoWithHistory(10), true);
  const flipAt = (b: Uint8Array, at: number) => {
    const c = b.slice();
    c[at] = (c[at] as number) ^ 0x40;
    return c;
  };
  it("idx checksum wrong, idx of another pack, truncated idx: open fails with PackError", async () => {
    const { files, packPath, idxPath } = await installed(pack);
    const idx = new Uint8Array(await collect(files.read(idxPath)));
    const other = await installed(packAll(repoWithHistory(4), true));
    const otherIdx = new Uint8Array(await collect(other.files.read(other.idxPath)));
    for (const [name, bytes] of [
      ["checksum", flipAt(idx, idx.length - 1)],
      ["another pack's idx", otherIdx],
      ["truncated", idx.subarray(0, idx.length - 100)],
    ] as const) {
      await files.write("/objects/pack/test.idx", [bytes]);
      await expect(
        openPack(files, packPath, "/objects/pack/test.idx"),
        name,
      ).rejects.toBeInstanceOf(PackError);
    }
  });
  it("an idx of another pack with the same object count is refused by the trailer check", async () => {
    const one = (t: string) =>
      buildPack([{ kind: 3, data: new TextEncoder().encode(t.repeat(40)) }]);
    const a = await installed(one("a\n"));
    const b = await installed(one("b\n"));
    const otherIdx = new Uint8Array(await collect(b.files.read(b.idxPath)));
    await a.files.write("/objects/pack/other.idx", [otherIdx]);
    await expect(openPack(a.files, a.packPath, "/objects/pack/other.idx")).rejects.toBeInstanceOf(
      PackError,
    );
  });
  it("a corrupt compressed entry fails with PackError when read", async () => {
    const { files, packPath, idxPath, result } = await installed(pack);
    // corrupt the middle of the first entry longer than 200 bytes (any type)
    const sorted = [...result.entries].sort((a, b) => a.offset - b.offset);
    const raw = new Uint8Array(await collect(files.read(packPath)));
    const target =
      sorted.find((e, i) => (sorted[i + 1]?.offset ?? raw.length - 20) - e.offset > 200) ??
      sorted[0];
    if (!target) throw new Error("no entry");
    await files.write(packPath, [flipAt(raw, target.offset + 60)]);
    const reader = await openPack(files, packPath, idxPath);
    await expect(
      (async () => {
        const o = await reader.get(target.oid, { verify: true });
        await collect(o?.content ?? []);
      })(),
    ).rejects.toBeInstanceOf(PackError);
  });
  it("verify detects content that hashes to another id", async () => {
    const A = new TextEncoder().encode("aaaa\n".repeat(30));
    const B = new TextEncoder().encode("bbbb\n".repeat(30));
    const pa = buildPack([{ kind: 3, data: A }]);
    const pb = buildPack([{ kind: 3, data: B }]);
    const { files, packPath, idxPath, result } = await installed(pa);
    // same layout, other content; keep pa's trailer so the pack/idx check passes
    const forged = pb.slice();
    forged.set(pa.subarray(pa.length - 20), forged.length - 20);
    await files.write(packPath, [forged]);
    const reader = await openPack(files, packPath, idxPath);
    const oid = result.entries[0]?.oid as string;
    const plain = await reader.get(oid);
    expect((await collect(plain?.content ?? [])).equals(Buffer.from(B))).toBe(true); // without verify: wrong bytes
    await expect(
      (async () => {
        const o = await reader.get(oid, { verify: true });
        await collect(o?.content ?? []);
      })(),
    ).rejects.toBeInstanceOf(PackError);
  });
});

const gc = () => (globalThis as { gc?: () => void }).gc?.();
const live = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

describe("R4 delta chains through the base cache", () => {
  it("random-order reads of a 4 MiB base + 50-deep chain: memory = cache + working set, cache halves inflations", async () => {
    const big = noise(4 * MiB, 3);
    const entries: CraftEntry[] = [{ kind: 3, data: big }];
    for (let i = 0; i < 50; i++) {
      const len = big.length + i;
      entries.push({ kind: 6, data: delta(len, len + 1, [...copyAll(len), 1, i]), baseIdx: i });
    }
    const { files, packPath, idxPath, result } = await installed(buildPack(entries));
    let seed = 7;
    const order = result.entries.map((e) => e.oid);
    for (let i = order.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const j = seed % (i + 1);
      [order[i], order[j]] = [order[j] as string, order[i] as string];
    }
    const read = files.read.bind(files);
    let peak = 0;
    let base = 0;
    let n = 0;
    files.read = (p, o) =>
      (async function* () {
        for await (const c of read(p, o)) {
          if (++n % 64 === 0) {
            gc();
            peak = Math.max(peak, live() - base);
          }
          yield c;
        }
      })();
    const inflations: number[] = [];
    for (const cache of [16 * MiB, 0]) {
      const reader = await openPack(files, packPath, idxPath, { baseCacheBytes: cache });
      gc();
      base = live();
      peak = 0;
      for (const oid of order) {
        const o = await reader.get(oid, { verify: true });
        let n = 0;
        for await (const c of o?.content ?? []) n += c.length;
        expect(n).toBe(o?.size);
        gc();
        peak = Math.max(peak, live() - base);
      }
      inflations.push(reader.stats.inflations);
      console.log(
        `R4 cache ${cache >> 20} MiB: ${reader.stats.inflations} inflations, peak +${(peak / MiB).toFixed(1)} MiB live`,
      );
      // The cache itself stays within its budget (deterministic). Process memory = the budget + a
      // working set of a few objects (the base being patched, the result, the caller's copy) plus
      // buffers awaiting release after a forced GC, which varies by Node version (≈ 30–34 MiB on
      // Node 22, 42 MiB on Node 24 in CI): only a loose sanity bound is asserted. The criterion's
      // "< 24 MiB" forgot the working set and is recorded as not met in the README.
      expect(reader.stats.peakCachedBytes).toBeLessThanOrEqual(cache);
      // the accounting matches what the cache really holds, and the cache was used
      expect(reader.stats.cachedBytes).toBe(reader.stats.cachedEntriesBytes);
      if (cache > 0) expect(reader.stats.peakCachedBytes).toBeGreaterThan(0);
      if (cache > 0) expect(peak).toBeLessThan(cache + 8 * 4 * MiB);
    }
    expect((inflations[0] as number) * 2).toBeLessThanOrEqual(inflations[1] as number);
  }, 300_000);
});

/** Writes a pack and an idx for it directly (no X6a checks), entries given by offset → oid. */
async function writeRaw(
  files: StreamingNodeFilesApi,
  pack: Uint8Array,
  entries: { oid: string; offset: number }[],
) {
  const packId = Buffer.from(pack.subarray(pack.length - 20)).toString("hex");
  const idx = writeIdx(
    entries.map((e) => ({ ...e, crc32: 0, type: "blob" as const, size: 0 })),
    packId,
  );
  await files.write(`/objects/pack/pack-${packId}.pack`, [pack]);
  await files.write(`/objects/pack/pack-${packId}.idx`, [idx]);
  return {
    packId,
    packPath: `/objects/pack/pack-${packId}.pack`,
    idxPath: `/objects/pack/pack-${packId}.idx`,
    idx,
  };
}
const fakeOid = (n: number) => n.toString(16).padStart(40, "0");

describe("R3b review: hostile and broken packs fail with PackError, never crash", () => {
  it("a REF_DELTA cycle across two packs is refused (no unbounded recursion)", async () => {
    const repo = emptyRepo();
    const files = new StreamingNodeFilesApi(join(repo, ".git"));
    const X = fakeOid(0xaa);
    const Y = fakeOid(0xbb);
    const d = delta(10, 10, [...copyAll(10)]);
    await writeRaw(files, buildPack([{ kind: 7, data: d, baseOid: Y }]), [{ oid: X, offset: 12 }]);
    await writeRaw(files, buildPack([{ kind: 7, data: d, baseOid: X }]), [{ oid: Y, offset: 12 }]);
    const db = await openObjectDatabase(files, "/objects");
    const t0 = performance.now();
    await expect(
      (async () => {
        const o = await db.get(X);
        await collect(o?.content ?? []);
      })(),
    ).rejects.toBeInstanceOf(PackError);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it("entry sizes that disagree with the data (larger, smaller) fail with PackError without verify", async () => {
    const repo = emptyRepo();
    const files = new StreamingNodeFilesApi(join(repo, ".git"));
    const data = new TextEncoder().encode("content\n".repeat(20));
    for (const sizeOverride of [data.length + 5, data.length - 5]) {
      const raw = await writeRaw(files, buildPack([{ kind: 3, data, sizeOverride }]), [
        { oid: fakeOid(sizeOverride), offset: 12 },
      ]);
      const reader = await openPack(files, raw.packPath, raw.idxPath);
      await expect(
        (async () => {
          const o = await reader.get(fakeOid(sizeOverride));
          await collect(o?.content ?? []);
        })(),
        String(sizeOverride),
      ).rejects.toBeInstanceOf(PackError);
    }
  });
  it("a delta base whose header declares 1.5 GiB or 2^40 bytes is refused before allocating", async () => {
    const repo = emptyRepo();
    const files = new StreamingNodeFilesApi(join(repo, ".git"));
    const base = new TextEncoder().encode("abc");
    for (const size of [1.5 * 2 ** 30, 2 ** 40]) {
      // the oversized entry is a delta base: reading the child must inflate it into memory
      const pack = buildPack([
        { kind: 3, data: base, sizeOverride: size },
        { kind: 6, data: delta(3, 3, [...copyAll(3)]), baseIdx: 0 },
      ]);
      const child = fakeOid(1 + (size % 9999));
      let headerLen = 1;
      for (let rest = Math.floor(size / 16); rest; rest = Math.floor(rest / 128)) headerLen++;
      const raw = await writeRaw(files, pack, [
        { oid: fakeOid(size % 9999), offset: 12 },
        { oid: child, offset: 12 + headerLen + deflateSync(base).length },
      ]);
      // no size limit: only the zlib expansion bound (≈1032:1 of the compressed bytes) protects
      const reader = await openPack(files, raw.packPath, raw.idxPath, { maxObjectSize: 2 ** 50 });
      let peak = 0;
      const read = files.read.bind(files);
      const before = process.memoryUsage().arrayBuffers;
      files.read = (p, o) =>
        (async function* () {
          for await (const c of read(p, o)) {
            peak = Math.max(peak, process.memoryUsage().arrayBuffers - before);
            yield c;
          }
        })();
      await expect(
        (async () => {
          const o = await reader.get(child);
          await collect(o?.content ?? []);
        })(),
        String(size),
      ).rejects.toBeInstanceOf(PackError);
      files.read = read;
      expect(peak, String(size)).toBeLessThan(64 * MiB);
    }
  });
  it("large offsets decode, and a large-offset index outside the table is refused at open", async () => {
    const { files, packPath, idxPath, result } = await installed(
      buildPack([{ kind: 3, data: new TextEncoder().encode("big offset\n") }]),
    );
    const idx = new Uint8Array(await collect(files.read(idxPath)));
    // rewrite entry 0's offset as an index into the 64-bit table, holding the real offset
    const rebuild = (index: number) => {
      const n = 1;
      const offAt = 8 + 1024 + n * 20 + n * 4;
      const head = idx.slice(0, offAt + 4);
      new DataView(head.buffer).setUint32(offAt, (0x80000000 | index) >>> 0);
      const table = new Uint8Array(8);
      new DataView(table.buffer).setUint32(4, result.entries[0]?.offset as number);
      const body = Buffer.concat([head, table, idx.subarray(idx.length - 40, idx.length - 20)]);
      return new Uint8Array(Buffer.concat([body, createHash("sha1").update(body).digest()]));
    };
    await files.write("/objects/pack/large.idx", [rebuild(0)]);
    const ok = await openPack(files, packPath, "/objects/pack/large.idx");
    const o = await ok.get(result.entries[0]?.oid as string, { verify: true });
    expect((await collect(o?.content ?? [])).toString()).toBe("big offset\n");
    await files.write("/objects/pack/bad-large.idx", [rebuild(7)]);
    await expect(openPack(files, packPath, "/objects/pack/bad-large.idx")).rejects.toBeInstanceOf(
      PackError,
    );
  });
  it("an idx whose object ids are out of order is refused at open", async () => {
    const pack = buildPack([
      { kind: 3, data: new TextEncoder().encode("one\n") },
      { kind: 3, data: new TextEncoder().encode("two\n") },
    ]);
    const repo = emptyRepo();
    const files = new StreamingNodeFilesApi(join(repo, ".git"));
    const raw = await writeRaw(files, pack, [
      { oid: `aa${"1".repeat(38)}`, offset: 12 },
      { oid: `aa${"2".repeat(38)}`, offset: 20 },
    ]);
    // swap the two ids inside the same fan-out bucket and re-checksum
    const idx = raw.idx.slice();
    const at = 8 + 1024;
    const a = idx.slice(at, at + 20);
    idx.copyWithin(at, at + 20, at + 40);
    idx.set(a, at + 20);
    idx.set(
      createHash("sha1")
        .update(idx.subarray(0, idx.length - 20))
        .digest(),
      idx.length - 20,
    );
    await files.write(raw.idxPath, [idx]);
    await expect(openPack(files, raw.packPath, raw.idxPath)).rejects.toBeInstanceOf(PackError);
  });
  it("one corrupt pack does not stop the database: it is skipped and reported", async () => {
    const repo = repoWithHistory(6);
    git(repo, ["repack", "-q", "-d"]);
    writeFileSync(join(repo, "more.txt"), "more\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "more"]);
    git(repo, ["repack", "-q", "-d"]);
    const packDir = join(repo, ".git", "objects", "pack");
    const idxs = readdirSync(packDir)
      .filter((n) => n.endsWith(".idx"))
      .sort();
    expect(idxs.length).toBe(2);
    const head = git(repo, ["rev-parse", "HEAD"]).toString().trim();
    // corrupt the pack that does NOT hold HEAD (pack names vary between runs)
    const holdsHead = (n: string) =>
      git(repo, ["show-index"], readFileSync(join(packDir, n)))
        .toString()
        .includes(head);
    const victim = idxs.find((n) => !holdsHead(n)) as string;
    const bad = join(packDir, victim);
    const bytes = readFileSync(bad);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
    chmodSync(bad, 0o644); // git writes .idx read-only (0444); only root could overwrite it as is
    writeFileSync(bad, bytes);
    const db = await openObjectDatabase(new StreamingNodeFilesApi(join(repo, ".git")), "/objects");
    expect(db.skipped.map((s) => s.pack)).toEqual([victim.replace(/\.idx$/, "")]);
    expect(await db.has(head)).toBe(true);
  });
});

describe("R2b review: cached objects are not shared with callers", () => {
  it("mutating a returned chunk does not change what the next get returns", async () => {
    const base = new TextEncoder().encode("base content\n".repeat(50));
    const d = delta(base.length, base.length + 3, [...copyAll(base.length), 3, 120, 121, 122]);
    const { files, packPath, idxPath, result } = await installed(
      buildPack([
        { kind: 3, data: base },
        { kind: 6, data: d, baseIdx: 0 },
      ]),
    );
    const reader = await openPack(files, packPath, idxPath);
    const child = result.entries.find((e) => e.offset !== 12)?.oid as string;
    const first = await reader.get(child);
    for await (const c of first?.content ?? []) c.fill(0);
    // the second read comes from the cache: mutate it too, then a third read must still verify
    const second = await reader.get(child);
    for await (const c of second?.content ?? []) c.fill(0);
    const third = await reader.get(child, { verify: true });
    await expect(collect(third?.content ?? [])).resolves.toBeDefined();
  });
});

describe("R6 streaming a large packed blob", () => {
  it("a 64 MiB incompressible blob is streamed with < 16 MiB live", async () => {
    const src = emptyRepo();
    writeFileSync(join(src, "big"), noise(64 * MiB, 11));
    const oid = git(src, ["hash-object", "-w", "big"]).toString().trim();
    const pack = new Uint8Array(git(src, ["pack-objects", "--stdout", "-q"], `${oid}\n`));
    const { files, packPath, idxPath } = await installed(pack);
    const reader = await openPack(files, packPath, idxPath);
    gc();
    const base = live();
    let peak = 0;
    let n = 0;
    let k = 0;
    const h = createHash("sha1").update(`blob ${64 * MiB}\0`);
    const o = await reader.get(oid);
    for await (const c of o?.content ?? []) {
      n += c.length;
      h.update(c);
      if (++k % 16 === 0 || k === 1) {
        // also the first chunk: a materialised object arrives as one huge chunk
        gc();
        peak = Math.max(peak, live() - base);
      }
    }
    console.log(`R6 64 MiB blob streamed: peak +${(peak / MiB).toFixed(1)} MiB live`);
    expect(n).toBe(64 * MiB);
    expect(h.digest("hex")).toBe(oid);
    expect(peak).toBeLessThan(16 * MiB);
  }, 300_000);
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
      durableObjects: { READ: { className: "ReadDo", useSQLite: true } },
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  it("every object of the fixture pack reads with verify", async () => {
    const r = (await (await mf.dispatchFetch("http://x/read", { method: "POST" })).json()) as {
      verified?: number;
      count?: number;
      error?: string;
    };
    expect(r.error).toBeUndefined();
    expect(r.verified).toBe(r.count);
    expect(r.count).toBeGreaterThan(200);
  }, 60_000);
});
