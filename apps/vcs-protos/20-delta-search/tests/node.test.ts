import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { buildPack, copyAll, delta, oidOf } from "../../12-index-pack/src/craft.js";
import { CRC_INIT, crc32Update, crcFinal } from "../../12-index-pack/src/crc32.js";
import { applyDelta } from "../../12-index-pack/src/delta.js";
import { git, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { writeIdx } from "../../12-index-pack/src/index-pack.js";
import { log } from "../../17-repository/src/commands.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { listObjects, type ToSend } from "../../18-pack-export/src/export.js";
import { deltaIndex, encodeDelta } from "../src/delta-encode.js";
import {
  exportPackSearching,
  nameHash,
  type SearchStats,
  writePackSearching,
} from "../src/export-search.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6e-"));
  dirs.push(d);
  return d;
};
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const collect = async (s: AsyncIterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};
const open = (dir: string) =>
  filesRepository(new StreamingNodeFilesApi(join(dir, ".git")), nodeRefFiles(join(dir, ".git")));
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main", "."]);
  return d;
};
const rev = (d: string, r: string) => git(d, ["rev-parse", r]).toString().trim();
const searchStats = (): SearchStats => ({
  candidates: 0,
  computed: 0,
  comparisons: 0,
  peakWindowBytes: 0,
  big: 0,
});
let seed = 1;
const rnd = (n: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed % n;
};
/** `n` more commits editing a few lines of each text file (loose objects). */
function moreCommits(d: string, n: number, tag: string) {
  for (let c = 0; c < n; c++) {
    for (let f = 0; f < 4; f++) {
      const p = join(d, `file${f}.txt`);
      const lines = readFileSync(p, "utf8").split("\n");
      for (let k = 0; k < 3; k++)
        lines[(c * 13 + k * 101 + f * 7) % lines.length] = `${tag} ${c}/${k}`;
      writeFileSync(p, lines.join("\n"));
    }
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", `${tag} ${c}`, "--date", `${1800000000 + c * 60} +0000`]);
  }
}
/** git's own pack for `want ^have` (`pack-objects --revs`, its default window and depth). */
const gitPack = (d: string, want: string, have: string, thin: boolean) =>
  new Uint8Array(
    git(
      d,
      ["pack-objects", "--revs", "--stdout", "-q", ...(thin ? ["--thin"] : [])],
      `${want}\n^${have}\n`,
    ),
  );
/** `git verify-pack -v` rows: oid, type, size (delta size for deltas), depth, base. */
const verifyRows = (pack: Uint8Array) => {
  const d = emptyRepo();
  const p = join(d, "x.pack");
  writeFileSync(p, pack);
  git(d, ["index-pack", p]);
  return git(d, ["verify-pack", "-v", p])
    .toString()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => /^[0-9a-f]{40}$/.test(f[0] ?? "") && f.length >= 5)
    .map((f) => ({
      oid: f[0] as string,
      type: f[1] as string,
      size: Number(f[2]),
      depth: f[5] ? Number(f[5]) : 0,
      base: f[6],
    }));
};

/** Walks a delta's instructions, checking git's bounds; returns the copy and insert counts. */
function checkInstructions(src: Uint8Array, d: Uint8Array) {
  let p = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = d[p++] as number;
      v += (b & 0x7f) * mul;
      mul *= 128;
      if (!(b & 0x80)) return v;
    }
  };
  expect(varint()).toBe(src.length);
  varint();
  let copies = 0;
  let inserts = 0;
  while (p < d.length) {
    const cmd = d[p++] as number;
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (cmd & (1 << i)) off += (d[p++] as number) * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (cmd & (0x10 << i)) size += (d[p++] as number) << (8 * i);
      if (size === 0) size = 0x10000;
      expect(off + size).toBeLessThanOrEqual(src.length);
      copies++;
    } else {
      expect(cmd).toBeGreaterThanOrEqual(1);
      expect(cmd).toBeLessThanOrEqual(127);
      p += cmd;
      inserts++;
    }
  }
  expect(p).toBe(d.length);
  return { copies, inserts };
}

describe("R1 the delta encoder", () => {
  it("random edits round-trip through applyDelta, every instruction within git's bounds", () => {
    seed = 42;
    let targets = 0;
    let deltas = 0;
    for (let t = 0; t < 300; t++) {
      const len = rnd(t < 50 ? 64 : 60000);
      const src = Uint8Array.from({ length: len }, () => rnd(t % 3 ? 256 : 4));
      const tgt = Array.from(src);
      for (let k = rnd(20); k > 0; k--) {
        const at = rnd(tgt.length + 1);
        const op = rnd(3);
        if (op === 0) tgt.splice(at, 0, ...Array.from({ length: rnd(300) }, () => rnd(256)));
        else if (op === 1) tgt.splice(at, rnd(500));
        else {
          const from = rnd(tgt.length + 1);
          tgt.splice(at, 0, ...tgt.slice(from, from + rnd(2000)));
        }
      }
      const target = Uint8Array.from(tgt);
      const d = encodeDelta(deltaIndex(src), target) as Uint8Array;
      expect(Buffer.compare(applyDelta(src, d), target), `case ${t}`).toBe(0);
      checkInstructions(src, d);
      targets += target.length;
      deltas += d.length;
    }
    console.log(`R1: ${targets} target bytes as ${deltas} delta bytes`);
    expect(deltas).toBeLessThan(targets * 0.05); // edits are small: the deltas are mostly copies
  });
  it("copies longer than 64 KiB are split; an empty source or target works", () => {
    const big = noise(300000, 3);
    const d = encodeDelta(deltaIndex(big), big) as Uint8Array;
    expect(checkInstructions(big, d).copies).toBe(Math.ceil(300000 / 0x10000));
    expect(d.length).toBeLessThan(40);
    const e = new Uint8Array(0);
    expect(Buffer.compare(applyDelta(e, encodeDelta(deltaIndex(e), big) as Uint8Array), big)).toBe(
      0,
    );
    expect(applyDelta(big, encodeDelta(deltaIndex(big), e) as Uint8Array).length).toBe(0);
  });
  it("gives up once the delta would exceed maxSize", () => {
    const a = noise(20000, 5);
    const b = noise(20000, 6);
    expect(encodeDelta(deltaIndex(a), b, 1000)).toBeUndefined();
    expect((encodeDelta(deltaIndex(a), b) as Uint8Array).length).toBeGreaterThan(1000);
  });
  it("matches found past an unindexed position extend back over the literals (a sparse index)", () => {
    const src = noise(65536, 21);
    const tgt = src.slice();
    for (let i = 0; i < 50; i++) tgt[600 + i * 1300] = (tgt[600 + i * 1300] as number) ^ 0x55;
    const d = encodeDelta(deltaIndex(src, 16), tgt) as Uint8Array;
    expect(Buffer.compare(applyDelta(src, d), tgt)).toBe(0);
    // each change: an insert of 1 byte and a copy; without extending back, up to 15 more literals
    console.log(`R1 sparse: ${d.length} B for 50 one-byte changes`);
    expect(d.length).toBeLessThan(50 * 9 + 20);
  });
  it("on git's own (base, target) pairs, within 1.05× of git's delta bytes", async () => {
    const src = repoWithHistory(30);
    const pack = new Uint8Array(
      git(src, ["pack-objects", "--stdout", "-q"], git(src, ["rev-list", "--objects", "HEAD"])),
    );
    const pairs = verifyRows(pack).filter((r) => r.base && r.type === "blob");
    expect(pairs.length).toBeGreaterThan(50);
    const repo = await open(src);
    const read = async (oid: string) => {
      const o = await repo.objects.get(oid);
      if (!o) throw new Error(`missing ${oid}`);
      return collect(o.content);
    };
    let theirs = 0;
    let ours = 0;
    for (const r of pairs) {
      theirs += r.size;
      const d = encodeDelta(deltaIndex(await read(r.base as string)), await read(r.oid));
      ours += (d as Uint8Array).length;
    }
    console.log(`R1 vs git's encoder: ours ${ours} B, git ${theirs} B on ${pairs.length} pairs`);
    expect(ours).toBeLessThanOrEqual(theirs * 1.05);
  });
  it("git resolves the computed deltas (index-pack, cat-file)", () => {
    const base = new TextEncoder().encode(
      Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"),
    );
    const target = new TextEncoder().encode(
      Array.from({ length: 520 }, (_, i) => (i % 37 ? `line ${i}` : `changed ${i}`)).join("\n"),
    );
    const d = encodeDelta(deltaIndex(base), target) as Uint8Array;
    const pack = buildPack([
      { kind: 3, data: base },
      { kind: 7, data: d, baseOid: oidOf("blob", base) },
    ]);
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], pack);
    expect(git(dst, ["cat-file", "-p", oidOf("blob", target)]).toString()).toBe(
      new TextDecoder().decode(target),
    );
  });
});

describe("R2 incremental exports near git's size", () => {
  it("new loose commits after a gc: within 1.10× of git, non-thin and thin", async () => {
    const src = repoWithHistory(30);
    git(src, ["gc", "-q"]);
    const have = rev(src, "HEAD");
    moreCommits(src, 5, "loose");
    const want = rev(src, "HEAD");
    const repo = await open(src);
    for (const thin of [false, true]) {
      const s = searchStats();
      const ours = await collect(
        exportPackSearching(repo, [want], [have], { thin, searchStats: s }),
      );
      const theirs = gitPack(src, want, have, thin);
      console.log(
        `R2 loose thin=${thin}: ours ${ours.length} B, git ${theirs.length} B; ${JSON.stringify(s)}`,
      );
      expect(ours.length).toBeLessThanOrEqual(theirs.length * 1.1);
      const dst = emptyRepo();
      const seed = git(
        src,
        ["pack-objects", "--stdout", "-q"],
        git(src, ["rev-list", "--objects", have]),
      );
      git(dst, ["index-pack", "--stdin"], seed);
      git(dst, ["index-pack", "--stdin", ...(thin ? ["--fix-thin"] : [])], ours);
      git(dst, ["update-ref", "refs/heads/main", want]);
      git(dst, ["fsck", "--full"]);
    }
  });
  it("the newest commits stored whole after a gc (nothing to reuse): within 1.10× of git", async () => {
    const src = repoWithHistory(30);
    moreCommits(src, 5, "packed");
    git(src, ["gc", "-q"]);
    const want = rev(src, "HEAD");
    const have = rev(src, "HEAD~5");
    const repo = await open(src);
    for (const thin of [false, true]) {
      const s = searchStats();
      const ours = await collect(
        exportPackSearching(repo, [want], [have], { thin, searchStats: s }),
      );
      const theirs = gitPack(src, want, have, thin);
      console.log(
        `R2 packed thin=${thin}: ours ${ours.length} B, git ${theirs.length} B; ${JSON.stringify(s)}`,
      );
      expect(ours.length).toBeLessThanOrEqual(theirs.length * 1.1);
    }
  });
});

describe("R3 loose history", () => {
  it("a full export of a never-packed history: within 1.25× of git, fsck --strict", async () => {
    const src = repoWithHistory(30);
    const head = rev(src, "HEAD");
    const repo = await open(src);
    const s = searchStats();
    const ours = await collect(exportPackSearching(repo, [head], [], { searchStats: s }));
    const theirs = new Uint8Array(
      git(src, ["pack-objects", "--stdout", "-q"], git(src, ["rev-list", "--objects", "HEAD"])),
    );
    console.log(`R3: ours ${ours.length} B, git ${theirs.length} B; ${JSON.stringify(s)}`);
    expect(ours.length).toBeLessThanOrEqual(theirs.length * 1.25);
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], ours);
    git(dst, ["update-ref", "refs/heads/main", head]);
    git(dst, ["fsck", "--full", "--strict"]);
  });
});

describe("R4 git's ordering and bounds", () => {
  it("same-named files in different directories are tried against each other (path hash order)", async () => {
    const d = emptyRepo();
    seed = 9;
    // one pair of near-identical files sharing a name, their sizes 300 bytes apart, and 30
    // unrelated blobs with sizes between them: in size order the pair is 30 apart, beyond a window
    // of 2; only the path hash brings them together
    for (let i = 0; i < 30; i++) writeFileSync(join(d, `n${i}.dat`), noise(4105 + i * 10, 100 + i));
    const body = noise(4100, 7);
    mkdirSync(join(d, "a"));
    mkdirSync(join(d, "b"));
    writeFileSync(join(d, "a", "settings.cfg"), body);
    writeFileSync(join(d, "b", "settings.cfg"), Buffer.concat([body, noise(300, 8)]));
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "x"]);
    const repo = await open(d);
    const head = rev(d, "HEAD");
    const s = searchStats();
    const ours = await collect(
      exportPackSearching(repo, [head], [], { window: 2, searchStats: s }),
    );
    const rows = verifyRows(ours);
    const a = git(d, ["rev-parse", "HEAD:a/settings.cfg"]).toString().trim();
    const b = git(d, ["rev-parse", "HEAD:b/settings.cfg"]).toString().trim();
    const pair = rows.filter((r) => r.oid === a || r.oid === b);
    expect(pair.some((r) => r.base === a || r.base === b)).toBe(true);
  });
  it("deltas stay below git's max_size and chains at depth ≤ 50", async () => {
    const d = emptyRepo();
    let text = Array.from({ length: 200 }, (_, i) => `row ${i} ${"x".repeat(30)}`);
    for (let c = 0; c < 70; c++) {
      text = text.map((l, i) => (i === (c * 7) % 200 ? `edit ${c}` : l));
      writeFileSync(join(d, "f.txt"), text.join("\n"));
      git(d, ["add", "-A"]);
      git(d, ["commit", "-q", "-m", `c${c}`]);
    }
    const repo = await open(d);
    const head = rev(d, "HEAD");
    const ours = await collect(exportPackSearching(repo, [head], []));
    const rows = verifyRows(ours);
    const deltas = rows.filter((r) => r.base);
    expect(deltas.length).toBeGreaterThan(50);
    expect(Math.max(...rows.map((r) => r.depth))).toBeLessThanOrEqual(50);
    // the search respects the depth itself: a chain at its limit is not extended, another base is
    // found (were the writer's cap to cut it, versions past depth 50 would go whole)
    const blobs = rows.filter((r) => r.type === "blob");
    expect(blobs.filter((r) => !r.base).length).toBeLessThanOrEqual(2);
    const sizeOf = (oid: string) => Number(git(d, ["cat-file", "-s", oid]).toString());
    for (const r of deltas) expect(r.size).toBeLessThan(sizeOf(r.oid) / 2 - 20);
  });
});

describe("R5 bounded memory", () => {
  it("windowMemory bounds the window's content; objects above bigFileThreshold are not delta'd nor buffered", async () => {
    const d = emptyRepo();
    const big = noise(64 * 2 ** 20, 11);
    writeFileSync(join(d, "big.bin"), big);
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "v1"]);
    big[1000] = (big[1000] as number) ^ 1;
    writeFileSync(join(d, "big.bin"), big);
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "v2"]);
    const repo = await open(d);
    const head = rev(d, "HEAD");
    const gc = () => (globalThis as { gc?: () => void }).gc?.();
    const live = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    gc();
    gc();
    const base = live();
    let peak = 0;
    let n = 0;
    const s = searchStats();
    for await (const _ of exportPackSearching(repo, [head], [], {
      bigFileThreshold: 16 * 2 ** 20,
      searchStats: s,
    })) {
      if (++n % 16 === 1) {
        gc();
        gc();
        peak = Math.max(peak, live() - base);
      }
    }
    console.log(`R5 big: peak +${(peak / 2 ** 20).toFixed(1)} MiB; ${JSON.stringify(s)}`);
    expect(s.big).toBe(2);
    expect(peak).toBeLessThan(16 * 2 ** 20);
  }, 300_000);
  it("the window holds at most windowMemory (contents and their indexes) plus the current target", async () => {
    const src = repoWithHistory(20);
    const head = rev(src, "HEAD");
    const repo = await open(src);
    const unbounded = searchStats();
    await collect(
      exportPackSearching(repo, [head], [], { windowMemory: 0, searchStats: unbounded }),
    );
    const s = searchStats();
    const windowMemory = 600_000;
    await collect(exportPackSearching(repo, [head], [], { windowMemory, searchStats: s }));
    const largest = 30_000; // a text file of repoWithHistory (~28 KB)
    console.log(
      `R5 window: peak ${s.peakWindowBytes} B (unbounded ${unbounded.peakWindowBytes} B)`,
    );
    expect(unbounded.peakWindowBytes).toBeGreaterThan(windowMemory + largest); // the cap binds
    expect(s.peakWindowBytes).toBeLessThanOrEqual(windowMemory + largest);
    // a window smaller than one indexed text file (~150 KB with its index): those are not kept, so
    // the window holds only the small objects and the current target
    const tiny = searchStats();
    await collect(
      exportPackSearching(repo, [head], [], { windowMemory: 100_000, searchStats: tiny }),
    );
    expect(tiny.peakWindowBytes).toBeLessThanOrEqual(100_000 + largest);
  });
});

describe("R6 cost bounded by the window", () => {
  it("comparisons ≤ window × candidates", async () => {
    const src = repoWithHistory(30);
    const repo = await open(src);
    const head = rev(src, "HEAD");
    for (const window of [1, 4, 10]) {
      const s = searchStats();
      await collect(exportPackSearching(repo, [head], [], { window, searchStats: s }));
      expect(s.candidates).toBeGreaterThan(100);
      expect(s.comparisons).toBeGreaterThan(0);
      expect(s.comparisons).toBeLessThanOrEqual(window * s.candidates);
    }
  });
});

describe("R7 X6b installs the searched packs", () => {
  it("files and SQL backends: installed, logs equal git's", async () => {
    const src = repoWithHistory(20);
    const head = rev(src, "HEAD");
    const repo = await open(src);
    const objects = await listObjects(repo, [head], []);
    const pack = await collect(writePackSearching(repo, objects));
    for (const make of [
      async () => open(emptyRepo()),
      async () => sqlRepository(await newNodeSqliteDb()),
    ]) {
      const dst = await make();
      await dst.objects.installPack(chunks(pack));
      await dst.refs.batch([{ name: "refs/heads/main", new: head }]);
      expect(await log(dst, "refs/heads/main")).toEqual(await log(repo, head));
    }
  });
});

/** A pack (and its idx) of the given entries, written as is. */
function rawPack(entries: { kind: number; data: Uint8Array; baseOid?: string; oid: string }[]) {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write("PACK");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  parts.push(head);
  let offset = 12;
  const idxEntries: { oid: string; offset: number; crc32: number; type: "blob"; size: number }[] =
    [];
  for (const e of entries) {
    const h: number[] = [];
    let size = e.data.length;
    let b = (e.kind << 4) | (size & 15);
    size = Math.floor(size / 16);
    while (size) {
      h.push(b | 0x80);
      b = size & 127;
      size = Math.floor(size / 128);
    }
    h.push(b);
    if (e.kind === 7) h.push(...Buffer.from(e.baseOid as string, "hex"));
    const entry = Buffer.concat([Buffer.from(h), deflateSync(e.data)]);
    idxEntries.push({
      oid: e.oid,
      offset,
      crc32: crcFinal(crc32Update(CRC_INIT, entry)),
      type: "blob",
      size: 0,
    });
    parts.push(entry);
    offset += entry.length;
  }
  const body = Buffer.concat(parts);
  const trailer = createHash("sha1").update(body).digest();
  const pack = new Uint8Array(Buffer.concat([body, trailer]));
  return { pack, idx: writeIdx(idxEntries, trailer.toString("hex")), id: trailer.toString("hex") };
}
const installRaw = (d: string, p: ReturnType<typeof rawPack>, name = p.id) => {
  const pd = join(d, ".git", "objects", "pack");
  writeFileSync(join(pd, `pack-${name}.pack`), p.pack);
  writeFileSync(join(pd, `pack-${name}.idx`), p.idx);
};
const hashObject = (d: string, data: Uint8Array) => {
  writeFileSync(join(d, "obj.tmp"), data);
  return git(d, ["hash-object", "-w", "obj.tmp"]).toString().trim();
};
const reuseStats = () => ({
  reusedWhole: 0,
  reusedDelta: 0,
  thinDelta: 0,
  deflated: 0,
  computed: 0,
});

describe("review cases (#80)", () => {
  const enc = new TextEncoder();
  it("a corrupt first copy with a good one in another pack: the search export succeeds (as X6d's)", async () => {
    const A = enc.encode("the content of A ".repeat(40));
    const B = enc.encode(`${"the content of A ".repeat(39)}the content of B `);
    const a = oidOf("blob", A);
    const b = oidOf("blob", B);
    const d = emptyRepo();
    const bad = rawPack([{ kind: 3, data: A, oid: a }]);
    bad.pack[bad.pack.length - 25] = (bad.pack[bad.pack.length - 25] as number) ^ 0x01;
    const good = rawPack([
      { kind: 3, data: A, oid: a },
      { kind: 3, data: B, oid: b },
    ]);
    installRaw(d, bad, `0${bad.id.slice(1)}`);
    installRaw(d, good, `f${good.id.slice(1)}`);
    const repo = await open(d);
    const out = await collect(
      writePackSearching(repo, [
        { oid: a, type: "blob" },
        { oid: b, type: "blob" },
      ]),
    );
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], out);
    expect(git(dst, ["cat-file", "-p", a]).toString()).toBe(new TextDecoder().decode(A));
  });
  it("a base's reused-delta children count against its depth (git's check_delta_limit)", async () => {
    const line = (i: number) =>
      `line ${i} of the shared text, padded to be long enough ${(i * 7919) % 1000}\n`;
    const ver = (n: number) =>
      enc.encode(Array.from({ length: 200 + n }, (_, i) => line(i)).join(""));
    const d = emptyRepo();
    const objs: ToSend[] = [];
    for (let n = 50; n >= 1; n--)
      objs.push({ oid: hashObject(d, ver(n)), type: "blob", path: "f" });
    const V0 = ver(0);
    const v0 = oidOf("blob", V0);
    const tail = enc.encode("X\n");
    const X = new Uint8Array([...V0, ...tail]);
    const x = oidOf("blob", X);
    const dl = delta(V0.length, X.length, [...copyAll(V0.length), tail.length, ...tail]);
    installRaw(
      d,
      rawPack([
        { kind: 3, data: V0, oid: v0 },
        { kind: 7, data: dl, baseOid: v0, oid: x },
      ]),
    );
    objs.push({ oid: v0, type: "blob", path: "f" }, { oid: x, type: "blob", path: "g" });
    const repo = await open(d);
    const rs = reuseStats();
    const s = searchStats();
    const out = await collect(
      writePackSearching(repo, objs, { window: 1, stats: rs, searchStats: s }),
    );
    const rows = verifyRows(out);
    expect(rows.find((r) => r.oid === x)?.base).toBe(v0); // X stays the 11-byte reused delta
    expect(rs.reusedDelta).toBe(1);
    expect(Math.max(...rows.map((r) => r.depth))).toBeLessThanOrEqual(50);
    expect(s.computed).toBe(rs.computed ?? 0); // no computed delta demoted by the writer's cap
  });
  it("the depth option bounds the whole pack, reused deltas included", async () => {
    const line = (i: number) => `line ${i} of the shared text, padded to be long enough\n`;
    const txt = (n: number, tag: string) =>
      enc.encode(Array.from({ length: n }, (_, i) => line(i)).join("") + tag);
    const Y = txt(100, "Y\n");
    const Xc = txt(100, "X changed\n");
    const Z = txt(101, "Z\n");
    const y = oidOf("blob", Y);
    const x = oidOf("blob", Xc);
    const d = emptyRepo();
    const tail = enc.encode("X changed\n");
    const dl = delta(Y.length, Xc.length, [...copyAll(Y.length - 2), tail.length, ...tail]);
    installRaw(
      d,
      rawPack([
        { kind: 3, data: Y, oid: y },
        { kind: 7, data: dl, baseOid: y, oid: x },
      ]),
    );
    const z = hashObject(d, Z);
    const repo = await open(d);
    for (const depth of [1, 2]) {
      const out = await collect(
        writePackSearching(
          repo,
          [
            { oid: z, type: "blob", path: "f" },
            { oid: y, type: "blob", path: "f" },
            { oid: x, type: "blob", path: "f" },
          ],
          { depth },
        ),
      );
      expect(
        Math.max(...verifyRows(out).map((r) => r.depth)),
        `depth ${depth}`,
      ).toBeLessThanOrEqual(depth);
    }
  });
  it("the depth option cuts reused chains deeper than it", async () => {
    const A = enc.encode("stored chain base ".repeat(30));
    const B = new Uint8Array([...A, ...enc.encode("b")]);
    const C = new Uint8Array([...B, ...enc.encode("c")]);
    const [a, b, c] = [A, B, C].map((x) => oidOf("blob", x)) as [string, string, string];
    const d = emptyRepo();
    installRaw(
      d,
      rawPack([
        { kind: 3, data: A, oid: a },
        {
          kind: 7,
          data: delta(A.length, B.length, [...copyAll(A.length), 1, 0x62]),
          baseOid: a,
          oid: b,
        },
        {
          kind: 7,
          data: delta(B.length, C.length, [...copyAll(B.length), 1, 0x63]),
          baseOid: b,
          oid: c,
        },
      ]),
    );
    const repo = await open(d);
    const objs: ToSend[] = [a, b, c].map((oid) => ({ oid, type: "blob" }));
    const out = await collect(writePackSearching(repo, objs, { depth: 1 }));
    expect(Math.max(...verifyRows(out).map((r) => r.depth))).toBeLessThanOrEqual(1);
  });
  it("the size bound passed to the encoder is git's, scaled by depth: the same base as git", async () => {
    const N = (n: number, s: number) => new Uint8Array(noise(n, s));
    const cat = (...a: Uint8Array[]) => new Uint8Array(Buffer.concat(a));
    const C = N(1000, 1);
    const Ux = N(1100, 2);
    const Vx = N(1300, 3);
    const U = cat(C, Ux);
    const V = cat(C, Vx);
    const R0 = cat(C, N(600, 9), Vx.subarray(600), N(50, 10));
    const T = cat(C, Vx.subarray(0, 600), Ux.subarray(0, 400));
    const d = emptyRepo();
    const objs: ToSend[] = [R0, V, U, T].map((b) => ({
      oid: hashObject(d, b),
      type: "blob",
      path: "f",
    }));
    const t = objs[3]?.oid as string;
    const repo = await open(d);
    for (const depth of [2, 50]) {
      const ours = verifyRows(await collect(writePackSearching(repo, objs, { depth })));
      const theirs = verifyRows(
        new Uint8Array(
          git(
            d,
            ["pack-objects", "--stdout", "-q", `--depth=${depth}`],
            `${objs.map((o) => `${o.oid} f`).join("\n")}\n`,
          ),
        ),
      );
      expect(ours.find((r) => r.oid === t)?.base, `depth ${depth}`).toBe(
        theirs.find((r) => r.oid === t)?.base,
      );
    }
  });
  it("with the defaults, two similar 15 MiB blobs: delta'd, live memory < 96 MiB (a Durable Object has 128)", async () => {
    const d = emptyRepo();
    const big = noise(15 * 2 ** 20, 31);
    writeFileSync(join(d, "big.bin"), big);
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "v1"]);
    big[777777] = (big[777777] as number) ^ 1;
    writeFileSync(join(d, "big.bin"), big);
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "v2"]);
    const repo = await open(d);
    const head = rev(d, "HEAD");
    const gc = () => (globalThis as { gc?: () => void }).gc?.();
    const live = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    gc();
    gc();
    const base = live();
    let peak = 0;
    const s = searchStats();
    const origGet = repo.objects.get.bind(repo.objects);
    // sample while the search reads (the window is full then) and while the pack streams
    repo.objects.get = async (oid, o) => {
      gc();
      peak = Math.max(peak, live() - base);
      return origGet(oid, o);
    };
    let n = 0;
    let bytes = 0;
    for await (const c of exportPackSearching(repo, [head], [], { searchStats: s })) {
      bytes += c.length;
      if (++n % 16 === 1) {
        gc();
        peak = Math.max(peak, live() - base);
      }
    }
    console.log(
      `#80 defaults, 2 × 15 MiB: peak +${(peak / 2 ** 20).toFixed(1)} MiB; ${JSON.stringify(s)}`,
    );
    expect(bytes).toBeLessThan(16 * 2 ** 20); // one 15 MiB blob whole, the other a delta
    expect(peak).toBeLessThan(96 * 2 ** 20);
    expect(s.peakWindowBytes).toBeLessThanOrEqual(32 * 2 ** 20 + 15 * 2 ** 20);
  }, 300_000);
  it("only the first of a run of identical windows is indexed", () => {
    const run = new Uint8Array(64).fill(0x61);
    expect(deltaIndex(run, 1).pos.length).toBe(1);
  });
  it("nameHash skips the spaces git's isspace knows (\\t \\n \\r and space), not \\v or \\f", () => {
    expect(nameHash("a b")).toBe(nameHash("ab"));
    expect(nameHash("a\tb")).toBe(nameHash("ab"));
    expect(nameHash("a\vb")).not.toBe(nameHash("ab"));
    expect(nameHash("a\fb")).not.toBe(nameHash("ab"));
  });
});
