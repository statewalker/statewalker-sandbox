import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import {
  buildPack,
  type CraftEntry,
  copyAll,
  delta,
  oidOf,
} from "../../12-index-pack/src/craft.js";
import { git, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { openObjectDatabase } from "../../13-pack-reader/src/object-db.js";
import {
  type ExternalBase,
  installPack,
  PackError,
  sweepPackTemporaries,
} from "../src/index-pack.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6b-"));
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
const sha1hex = (b: Uint8Array) => createHash("sha1").update(b).digest("hex");
const packDir = (repo: string) => join(repo, ".git", "objects", "pack");
const packFiles = (repo: string) => readdirSync(packDir(repo)).sort();
/** git's own .idx for a complete pack. */
function gitIdx(pack: Uint8Array): Uint8Array {
  const d = tmp();
  writeFileSync(join(d, "p.pack"), pack);
  git(d, ["index-pack", "-o", join(d, "p.idx"), join(d, "p.pack")]);
  return new Uint8Array(readFileSync(join(d, "p.idx")));
}
/** `git verify-pack -v`: entries in pack order. */
function verifyPack(pack: string) {
  const out = git(tmp(), ["verify-pack", "-v", pack]).toString().split("\n");
  return out
    .map((l) => l.split(/\s+/))
    .filter((f) => /^[0-9a-f]{40}$/.test(f[0] ?? "") && f.length >= 5)
    .map((f) => ({ oid: f[0] as string, type: f[1] as string, offset: Number(f[4]) }))
    .sort((a, b) => a.offset - b.offset);
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
const collect = async (s: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of s) {
    parts.push(c);
    n += c.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** externalBase over the receiver's object database (X6r). */
async function odbBase(files: StreamingNodeFilesApi): Promise<ExternalBase & { calls: string[] }> {
  const db = await openObjectDatabase(files, "/objects");
  const calls: string[] = [];
  const f = async (oid: string) => {
    calls.push(oid);
    const o = await db.get(oid);
    return o ? { type: o.type, data: await collect(o.content) } : undefined;
  };
  return Object.assign(f, { calls });
}

/**
 * A sender repository and a receiver holding the objects of `have` only; the thin pack carries
 * `want ^have`. Returns git's completion of it (index-pack --fix-thin in a copy of the receiver).
 */
function thinCase(sender: string, want: string, have: string, ofs: boolean) {
  const receiver = emptyRepo();
  const haveObjects = git(sender, ["rev-list", "--objects", have]);
  const basePack = git(sender, ["pack-objects", "--stdout", "-q"], haveObjects);
  git(receiver, ["index-pack", "--stdin"], basePack);
  const args = ["pack-objects", "--revs", "--thin", "--stdout", "-q"];
  if (ofs) args.push("--delta-base-offset");
  const thin = new Uint8Array(git(sender, args, `${want}\n^${have}\n`));
  const ref = tmp();
  cpSync(receiver, ref, { recursive: true });
  const before = new Set(packFiles(ref));
  git(ref, ["index-pack", "--fix-thin", "--stdin"], thin);
  const name = packFiles(ref).find((n) => n.endsWith(".pack") && !before.has(n)) as string;
  return { receiver, thin, gitPack: join(packDir(ref), name) };
}

const history = repoWithHistory(30);
const withBig = repoWithHistory(3, { bigBlobBytes: 4 * 2 ** 20 });
const cases: [string, string, string, string, boolean][] = [
  ["REF_DELTA, last 5 commits of 30", history, "HEAD", "HEAD~5", false],
  ["OFS_DELTA, last 5 commits of 30", history, "HEAD", "HEAD~5", true],
  ["one commit on top (fetch of a single commit)", history, "HEAD", "HEAD~1", true],
  ["a 4 MiB blob edited by one byte", withBig, "HEAD", "HEAD~1", true],
];

describe("R1 thin packs completed as git index-pack --fix-thin", () => {
  for (const [name, sender, want, have, ofs] of cases) {
    it(name, async () => {
      const { receiver, thin, gitPack } = thinCase(sender, want, have, ofs);
      const files = new StreamingNodeFilesApi(join(receiver, ".git"));
      const before = new Set(packFiles(receiver));
      const externalBase = await odbBase(files);
      const r = await installPack(files, "/objects/pack", chunks(thin), { externalBase });
      expect(r.stats.appended).toBeGreaterThan(0);
      const added = packFiles(receiver).filter((n) => !before.has(n));
      expect(added).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
      const ours = join(packDir(receiver), `pack-${r.packId}.pack`);
      const bytes = new Uint8Array(readFileSync(ours));
      // named after the SHA-1 of its final content (the trailer)
      expect(sha1hex(bytes.subarray(0, bytes.length - 20))).toBe(r.packId);
      expect(Buffer.from(bytes.subarray(bytes.length - 20)).toString("hex")).toBe(r.packId);

      const mine = verifyPack(ours);
      const theirs = verifyPack(gitPack);
      expect(mine.map((e) => e.oid).sort()).toEqual(theirs.map((e) => e.oid).sort());
      const recvEnd = thin.length - 20;
      // the received entries keep their offsets and CRC-32 (git's index of its own completion)
      const myIdx = showIndex(new Uint8Array(readFileSync(ours.replace(/\.pack$/, ".idx"))));
      const gitIdxMap = showIndex(new Uint8Array(readFileSync(gitPack.replace(/\.pack$/, ".idx"))));
      let received = 0;
      for (const [off, [oid, crc]] of gitIdxMap) {
        if (off >= recvEnd) continue;
        received++;
        expect(myIdx.get(off)).toEqual([oid, crc]);
      }
      expect(received).toBeGreaterThan(0);
      // appended bases: git's order and types
      const app = (l: typeof mine) =>
        l.filter((e) => e.offset >= recvEnd).map((e) => `${e.type} ${e.oid}`);
      expect(app(mine)).toEqual(app(theirs));
      expect(app(mine).length).toBe(r.stats.appended);
      // our .idx is what git computes for our completed pack
      expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(gitIdx(bytes)))).toBe(0);
      // native git reads it
      git(receiver, ["verify-pack", ours]);
      git(receiver, [
        "update-ref",
        "refs/heads/main",
        git(sender, ["rev-parse", want]).toString().trim(),
      ]);
      git(receiver, ["fsck", "--full", "--no-dangling"]);
      for (const { oid } of mine) {
        const a = git(receiver, ["cat-file", "-p", oid]);
        const b = git(sender, ["cat-file", "-p", oid]);
        expect(Buffer.compare(a, b)).toBe(0);
      }
    });
  }
});

describe("R1b thin-pack refusals and base lookups", () => {
  const A = new TextEncoder().encode("base content ".repeat(40));
  const Aid = oidOf("blob", A);
  const B = new Uint8Array([...A, ...new TextEncoder().encode(" and more")]);
  const dAB = delta(A.length, B.length, [
    ...copyAll(A.length),
    9,
    ...new TextEncoder().encode(" and more"),
  ]);
  const Bid = oidOf("blob", B);
  const C = new Uint8Array([...B, 33]);
  const dBC = delta(B.length, C.length, [...copyAll(B.length), 1, 33]);
  const other = new TextEncoder().encode("an unrelated blob");
  const thin = (entries: CraftEntry[]) => buildPack(entries);
  const memRepo = () => new MemFilesApi();
  const listed = async (files: MemFilesApi) => {
    const out: string[] = [];
    for await (const e of files.list("/objects/pack")) out.push(e.name);
    return out;
  };
  const baseOf = (objs: Record<string, Uint8Array>) =>
    Object.assign(async (oid: string) => {
      calls.push(oid);
      const d = objs[oid];
      return d ? { type: "blob" as const, data: d } : undefined;
    }, {});
  let calls: string[] = [];

  it("without externalBase a thin pack is refused (X6a behaviour)", async () => {
    const files = memRepo();
    await expect(
      installPack(files, "/objects/pack", chunks(thin([{ kind: 7, baseOid: Aid, data: dAB }]))),
    ).rejects.toThrow(/thin pack/);
    expect(await listed(files)).toEqual([]);
  });
  it("an unknown base: refused, the message counts the unresolved deltas", async () => {
    const files = memRepo();
    calls = [];
    const p = thin([
      { kind: 3, data: other },
      { kind: 7, baseOid: Aid, data: dAB },
      { kind: 7, baseOid: Aid, data: dAB.slice() },
    ]);
    const err = await installPack(files, "/objects/pack", chunks(p), {
      externalBase: baseOf({}),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(String(err)).toMatch(/2 (unresolved )?deltas/);
    expect(calls).toEqual([Aid]); // a miss is remembered: asked once per id
    expect(await listed(files)).toEqual([]);
  });
  it("a base whose content hashes to another id is refused", async () => {
    const files = memRepo();
    calls = [];
    const err = await installPack(
      files,
      "/objects/pack",
      chunks(thin([{ kind: 7, baseOid: Aid, data: dAB }])),
      { externalBase: baseOf({ [Aid]: other }) },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(String(err)).toMatch(/hash|id/i);
    expect(await listed(files)).toEqual([]);
  });
  it("a REF_DELTA on a thin delta's result needs no second lookup; a shared base is appended once", async () => {
    const files = memRepo();
    calls = [];
    // B = A + δ (A external), C = B + δ (REF on B, which only exists once A is appended), and a
    // second delta on A. (A delta on B placed before B's own delta would be looked up first, as
    // git's fix_unresolved_deltas does: it walks the unresolved deltas in pack order.)
    const p = thin([
      { kind: 7, baseOid: Aid, data: dAB },
      { kind: 7, baseOid: Bid, data: dBC },
      { kind: 7, baseOid: Aid, data: delta(A.length, A.length, copyAll(A.length)) },
    ]);
    const r = await installPack(files, "/objects/pack", chunks(p), {
      externalBase: baseOf({ [Aid]: A }),
    });
    expect(calls).toEqual([Aid]);
    expect(r.stats.appended).toBe(1);
    expect(r.count).toBe(4);
    const ids = [...r.entries].map((e) => e.oid).sort();
    expect(ids).toEqual([Aid, Bid, oidOf("blob", C), Aid].sort());
    expect((await listed(files)).sort()).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
  });
  it("the stored pack changing while it is completed is detected", async () => {
    const files = memRepo();
    calls = [];
    const p = thin([
      { kind: 3, data: other },
      { kind: 7, baseOid: Aid, data: dAB },
    ]);
    const read = files.read.bind(files);
    // the completion re-reads the received part [12, size - 20): flip a byte in that read only
    files.read = (path, o) =>
      (async function* () {
        const copy = /tmp_pack_[^/]*$/.test(path) && o?.start === 12 && o.length === p.length - 32;
        for await (const c of read(path, o)) {
          if (!copy) yield c;
          else {
            const x = c.slice();
            x[0] = (x[0] as number) ^ 1;
            yield x;
          }
        }
      })();
    const err = await installPack(files, "/objects/pack", chunks(p), {
      externalBase: baseOf({ [Aid]: A }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(String(err)).toMatch(/changed/);
    expect(await listed(files)).toEqual([]);
  });
  it("an evicted base reached through REF links is re-derived (git's idx, 1-byte cache)", async () => {
    const enc = new TextEncoder();
    const blob = (s: string) => enc.encode(s.repeat(30));
    const ext = (b: Uint8Array, tail: string) => {
      const t = enc.encode(tail);
      return {
        data: new Uint8Array([...b, ...t]),
        d: delta(b.length, b.length + t.length, [...copyAll(b.length), t.length, ...t]),
      };
    };
    const a = blob("root ");
    const b = ext(a, "B");
    const c1 = ext(b.data, "C1");
    const c2 = ext(b.data, "C2");
    const d2 = ext(c2.data, "D2");
    // A ← B ← {C1, C2 ← D2}, all REF_DELTA: after C2's subtree B's evicted content must be
    // rebuilt from A through B's recorded base
    const p = buildPack([
      { kind: 3, data: a },
      { kind: 7, baseOid: oidOf("blob", a), data: b.d },
      { kind: 7, baseOid: oidOf("blob", b.data), data: c1.d },
      { kind: 7, baseOid: oidOf("blob", b.data), data: c2.d },
      { kind: 7, baseOid: oidOf("blob", c2.data), data: d2.d },
    ]);
    const r = await installPack(memRepo(), "/objects/pack", chunks(p), { baseCacheBytes: 1 });
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(gitIdx(p)))).toBe(0);
    expect(r.stats.deltaLoads).toBeGreaterThan(5); // B was rebuilt, not kept
  });
  it("a complete pack never calls externalBase", async () => {
    const files = memRepo();
    calls = [];
    const p = thin([
      { kind: 3, data: A },
      { kind: 6, baseIdx: 0, data: dAB },
    ]);
    const r = await installPack(files, "/objects/pack", chunks(p), { externalBase: baseOf({}) });
    expect(calls).toEqual([]);
    expect(r.stats.appended).toBe(0);
    expect(r.packId).toBe(sha1hex(p.subarray(0, p.length - 20)));
  });
});

/** two collections: the first may leave ArrayBuffer backing stores to the concurrent sweeper */
const gc = () => {
  (globalThis as { gc?: () => void }).gc?.();
  (globalThis as { gc?: () => void }).gc?.();
};
const live = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const MiB = 2 ** 20;

/** n entries: every 4th a REF_DELTA, every 4th an OFS_DELTA, on the blob just before it. */
function bigPack(n: number): Uint8Array {
  const entries: CraftEntry[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < n; i++) {
    const k = i % 4;
    if (k === 1 || k === 3) {
      const prev = enc.encode(`blob number ${i - 1} ${"x".repeat(20)}`);
      const tail = enc.encode(`+${i}`);
      const d = delta(prev.length, prev.length + tail.length, [
        ...copyAll(prev.length),
        tail.length,
        ...tail,
      ]);
      entries.push(
        k === 1
          ? { kind: 7, baseOid: oidOf("blob", prev), data: d }
          : { kind: 6, baseIdx: i - 1, data: d },
      );
    } else {
      entries.push({ kind: 3, data: enc.encode(`blob number ${i} ${"x".repeat(20)}`) });
    }
  }
  return buildPack(entries);
}

describe("R3 compact entries", () => {
  it("a 200 000-object pack installs with < 40 MiB extra live and git's .idx", async () => {
    const pack = bigPack(200_000);
    const ref = gitIdx(pack);
    const d = tmp();
    const files = new StreamingNodeFilesApi(d);
    const read = files.read.bind(files);
    let peak = 0;
    let base = 0;
    files.read = (p, o) =>
      (async function* () {
        for await (const c of read(p, o)) {
          gc();
          peak = Math.max(peak, live() - base);
          yield c;
        }
      })();
    let n = 0;
    const source = (async function* () {
      for await (const c of chunks(pack)) {
        if (++n % 16 === 0) {
          gc();
          peak = Math.max(peak, live() - base);
        }
        yield c;
      }
    })();
    gc();
    base = live(); // the source pack and git's idx are allocated before the baseline
    const r = await installPack(files, "/objects/pack", source);
    gc();
    peak = Math.max(peak, live() - base - r.idx.length);
    console.log(`R3 200k objects: peak +${(peak / MiB).toFixed(1)} MiB live`);
    expect(r.count).toBe(200_000);
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(ref))).toBe(0);
    expect(peak).toBeLessThan(40 * MiB);
  }, 300_000);
});

describe("R4 entry count checked against the pack size", () => {
  it("a header declaring 2^32-1 entries in a small pack is refused before allocating", async () => {
    const p = buildPack([{ kind: 3, data: new Uint8Array(10) }], { count: 0xffffffff });
    gc();
    const base = live();
    const err = await installPack(new MemFilesApi(), "/objects/pack", chunks(p)).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(String(err)).toMatch(/entries|count/);
    expect(live() - base).toBeLessThan(16 * MiB);
  });
});

describe("R5 phase 2 reads through a bounded window", () => {
  it("the history pack's delta loads need at most a quarter as many storage reads", async () => {
    const pack = packAll(repoWithHistory(60), true);
    const files = new StreamingNodeFilesApi(tmp());
    const read = files.read.bind(files);
    let reads = 0;
    files.read = (p, o) => {
      reads++;
      return read(p, o);
    };
    const r = await installPack(files, "/objects/pack", chunks(pack));
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(gitIdx(pack)))).toBe(0);
    console.log(
      `R5: ${r.stats.deltaLoads} delta loads, ${r.stats.storageReads} storage reads (${reads} counted)`,
    );
    expect(r.stats.deltaLoads).toBeGreaterThanOrEqual(245);
    expect(reads).toBe(r.stats.storageReads + 1); // + the phase-1 pass
    expect(r.stats.storageReads * 4).toBeLessThanOrEqual(r.stats.deltaLoads);
  });
});

describe("R6 stale temporaries are swept as git prune does", () => {
  it("removes old tmp_* files, keeps young ones and never touches packs", async () => {
    const d = tmp();
    const files = new StreamingNodeFilesApi(d);
    const pd = join(d, "objects", "pack");
    const r = await installPack(files, "/objects/pack", chunks(packAll(history, true)));
    for (const n of ["tmp_pack_old", "tmp_idx_old", "tmp_pack_young", "garbage.txt"])
      writeFileSync(join(pd, n), "x");
    const old = (Date.now() - 3 * 24 * 3600 * 1000) / 1000;
    for (const n of ["tmp_pack_old", "tmp_idx_old", "garbage.txt", `pack-${r.packId}.pack`])
      utimesSync(join(pd, n), old, old);
    const removed = await sweepPackTemporaries(files, "/objects/pack", {
      olderThanMs: 24 * 3600 * 1000,
    });
    expect(removed.sort()).toEqual(["/objects/pack/tmp_idx_old", "/objects/pack/tmp_pack_old"]);
    expect(readdirSync(pd).sort()).toEqual(
      ["garbage.txt", `pack-${r.packId}.idx`, `pack-${r.packId}.pack`, "tmp_pack_young"].sort(),
    );
  });
  it("on MemFilesApi too (the threshold compares lastModified with `now`)", async () => {
    const files = new MemFilesApi();
    await files.write("/objects/pack/tmp_pack_a", [new Uint8Array(1)]);
    const removed0 = await sweepPackTemporaries(files, "/objects/pack", { olderThanMs: 1000 });
    expect(removed0).toEqual([]);
    const removed = await sweepPackTemporaries(files, "/objects/pack", {
      olderThanMs: 1000,
      now: Date.now() + 5000,
    });
    expect(removed).toEqual(["/objects/pack/tmp_pack_a"]);
    expect(await files.exists("/objects/pack/tmp_pack_a")).toBe(false);
  });
});

describe("R7 fixture: the committed thin pack completes to the committed result", () => {
  const fx = (n: string) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
  it("on Node", async () => {
    const thinPack = new Uint8Array(readFileSync(fx("thin.pack")));
    const bases = JSON.parse(readFileSync(fx("bases.json"), "utf8")) as Record<
      string,
      { type: "blob" | "tree" | "commit" | "tag"; base64: string }
    >;
    const expected = new Uint8Array(readFileSync(fx("completed.idx")));
    const files = new MemFilesApi();
    const r = await installPack(files, "/objects/pack", chunks(thinPack, 4096), {
      externalBase: async (oid) => {
        const b = bases[oid];
        return b
          ? { type: b.type, data: new Uint8Array(Buffer.from(b.base64, "base64")) }
          : undefined;
      },
    });
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(expected))).toBe(0);
  });
  describe("inside a Durable Object (SqliteFilesApi)", () => {
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
    it("same .idx as on Node", async () => {
      const r = (await (await mf.dispatchFetch("http://x/thin", { method: "POST" })).json()) as {
        same?: boolean;
        appended?: number;
        error?: string;
      };
      expect(r.error).toBeUndefined();
      expect(r.appended).toBeGreaterThan(0);
      expect(r.same).toBe(true);
    });
  });
});

/** Review of #66: memory and reads under shapes the first tests did not cover. */
describe("R3b/R5b review cases", () => {
  const enc = new TextEncoder();
  const fill = async (files: MemFilesApi, path: string) => collect(files.read(path));
  it("a pack declaring as many entries as its size allows, garbage after 100 000 valid entries: refused with < 16 MiB live", async () => {
    // 100 000 small valid entries (~2 MiB) so the refusal happens chunks after the tables exist
    const valid = buildPack(
      Array.from({ length: 100_000 }, (_, i) => ({ kind: 3, data: enc.encode(`v${i}`) })),
    );
    const size = 16 * MiB;
    const p = new Uint8Array(size);
    p.set(valid.subarray(0, valid.length - 20)); // zeros after the valid entries (type 0)
    new DataView(p.buffer).setUint32(8, Math.floor((size - 32) / 9));
    const files = new StreamingNodeFilesApi(tmp());
    gc();
    const base = live();
    let peak = 0;
    const read = files.read.bind(files);
    files.read = (path, o) =>
      (async function* () {
        for await (const c of read(path, o)) {
          gc();
          peak = Math.max(peak, live() - base);
          yield c;
        }
      })();
    const err = await installPack(files, "/objects/pack", chunks(p)).catch((e) => e);
    expect(err).toBeInstanceOf(PackError);
    expect(String(err)).toMatch(/bad object type 0/); // refused at the first garbage entry
    console.log(`R3b declared-count pack: peak +${(peak / MiB).toFixed(1)} MiB`);
    expect(peak).toBeLessThan(16 * MiB);
  });
  it("a 100 000-deep comb (REF chain, an OFS leaf on every node), 2 MiB cache: < 40 MiB extra live", async () => {
    const N = 100_000;
    const prefix = "x".repeat(50);
    const content = (t: string) => enc.encode(prefix + t.padStart(10, "0"));
    const d = (tag: string) => {
      const t = enc.encode(tag.padStart(10, "0"));
      return delta(60, 60, [0x90, 50, t.length, ...t]); // copy 50 bytes, insert 10
    };
    const entries: CraftEntry[] = [{ kind: 3, data: content("c0") }];
    let prev = content("c0");
    for (let i = 1; i <= N; i++) {
      entries.push({ kind: 7, baseOid: oidOf("blob", prev), data: d(`c${i}`) });
      entries.push({ kind: 6, baseIdx: entries.length - 1, data: d(`l${i}`) });
      prev = content(`c${i}`);
    }
    const pack = buildPack(entries);
    const ref = gitIdx(pack);
    const files = new StreamingNodeFilesApi(tmp());
    const read = files.read.bind(files);
    let peak = 0;
    let base = 0;
    let n = 0;
    files.read = (path, o) => {
      if (++n % 500 === 0) {
        gc();
        peak = Math.max(peak, live() - base);
      }
      return read(path, o);
    };
    gc();
    base = live();
    const r = await installPack(files, "/objects/pack", chunks(pack), {
      windowBytes: 64,
      baseCacheBytes: 2 * MiB,
    });
    console.log(`R3b comb: ${r.stats.storageReads} reads, peak +${(peak / MiB).toFixed(1)} MiB`);
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(ref))).toBe(0);
    expect(r.stats.storageReads).toBeGreaterThan(10_000); // sampled throughout phase 2
    expect(peak).toBeLessThan(40 * MiB);
  }, 600_000);
  const ext = (b: Uint8Array, tail: string) => {
    const t = enc.encode(tail);
    return {
      data: new Uint8Array([...b, ...t]),
      d: delta(b.length, b.length + t.length, [...copyAll(b.length), t.length, ...t]),
    };
  };
  for (const big of [false, true]) {
    it(`an evicted appended base is re-read (${big ? "3 MB, direct read" : "small, windowed"}): git's idx`, async () => {
      const A = big
        ? (await import("../../12-index-pack/src/git-repo.js")).noise(3_000_000, 5)
        : enc.encode("root ".repeat(30));
      const A2 = enc.encode("second external ".repeat(30));
      const b = ext(A, "B");
      const c = ext(A, "C");
      const e = ext(A2, "E");
      const f = ext(b.data, "F");
      const g = ext(c.data, "G");
      const p = buildPack([
        { kind: 7, baseOid: oidOf("blob", A), data: b.d },
        { kind: 7, baseOid: oidOf("blob", A2), data: e.d },
        { kind: 7, baseOid: oidOf("blob", b.data), data: f.d },
        { kind: 7, baseOid: oidOf("blob", A), data: c.d },
        { kind: 7, baseOid: oidOf("blob", c.data), data: g.d },
      ]);
      const objs: Record<string, Uint8Array> = { [oidOf("blob", A)]: A, [oidOf("blob", A2)]: A2 };
      const files = new MemFilesApi();
      const r = await installPack(files, "/objects/pack", chunks(p), {
        baseCacheBytes: 1,
        windowBytes: 4096,
        externalBase: async (o) => (objs[o] ? { type: "blob", data: objs[o] } : undefined),
      });
      expect(r.stats.appended).toBe(2);
      expect(r.stats.deltaLoads).toBeGreaterThanOrEqual(6); // A was loaded back
      const bytes = await fill(files, `/objects/pack/pack-${r.packId}.pack`);
      expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(gitIdx(bytes)))).toBe(0);
    });
  }
  it("50 appended bases are written in a few batches, not one file each", async () => {
    const bases: Record<string, Uint8Array> = {};
    const entries: CraftEntry[] = [];
    for (let k = 0; k < 50; k++) {
      const A = enc.encode(`external base ${k} `.repeat(40));
      bases[oidOf("blob", A)] = A;
      entries.push({ kind: 7, baseOid: oidOf("blob", A), data: ext(A, `+${k}`).d });
    }
    const p = buildPack(entries);
    const files = new MemFilesApi();
    const write = files.write.bind(files);
    const written: string[] = [];
    files.write = (path, content) => {
      written.push(path);
      return write(path, content);
    };
    const r = await installPack(files, "/objects/pack", chunks(p), {
      externalBase: async (o) => (bases[o] ? { type: "blob", data: bases[o] } : undefined),
    });
    expect(r.stats.appended).toBe(50);
    expect(r.count).toBe(100);
    const thinFiles = written.filter((w) => /tmp_thin_/.test(w));
    expect(thinFiles.length).toBeLessThanOrEqual(2);
    const bytes = await fill(files, `/objects/pack/pack-${r.packId}.pack`);
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(gitIdx(bytes)))).toBe(0);
    expect(await listed2(files)).toEqual([`pack-${r.packId}.idx`, `pack-${r.packId}.pack`]);
  });
  const listed2 = async (files: MemFilesApi) => {
    const out: string[] = [];
    for await (const e of files.list("/objects/pack")) out.push(e.name);
    return out.sort();
  };
  it("the window is bounded: no phase-2 read is longer than windowBytes", async () => {
    const pack = packAll(history, true);
    const files = new StreamingNodeFilesApi(tmp());
    const read = files.read.bind(files);
    const lengths: number[] = [];
    files.read = (path, o) => {
      if (o?.length !== undefined) lengths.push(o.length);
      return read(path, o);
    };
    const r = await installPack(files, "/objects/pack", chunks(pack), { windowBytes: 4 * 1024 });
    expect(pack.length).toBeGreaterThan(4 * 4 * 1024);
    expect(Buffer.compare(Buffer.from(r.idx), Buffer.from(gitIdx(pack)))).toBe(0);
    expect(lengths.length).toBe(r.stats.storageReads);
    expect(r.stats.storageReads).toBeGreaterThan(1);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(4 * 1024);
  });
});
