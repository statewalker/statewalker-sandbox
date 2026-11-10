import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { buildPack, oidOf } from "../../12-index-pack/src/craft.js";
import { applyDelta } from "../../12-index-pack/src/delta.js";
import { git, noise, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { listObjects } from "../../18-pack-export/src/export.js";
import { deltaIndex, encodeDelta } from "../src/delta-encode.js";
import { exportPackSearching, type SearchStats, writePackSearching } from "../src/export-search.js";

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
      git(dst, ["index-pack", "--stdin"], gitPack(src, have, `${have}~100`, false));
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
    // unrelated blobs of similar sizes, and one pair of near-identical files sharing a name
    for (let i = 0; i < 30; i++)
      writeFileSync(join(d, `n${i}.dat`), noise(4000 + rnd(200), 100 + i));
    const body = noise(4100, 7);
    for (const dir of ["a", "b"]) {
      mkdirSync(join(d, dir));
      const v = body.slice();
      if (dir === "b") v[100] = (v[100] as number) ^ 1;
      writeFileSync(join(d, dir, "settings.cfg"), v);
    }
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
  it("the window holds at most windowMemory plus one object", async () => {
    const src = repoWithHistory(20);
    const head = rev(src, "HEAD");
    const repo = await open(src);
    const s = searchStats();
    const windowMemory = 40000;
    await collect(exportPackSearching(repo, [head], [], { windowMemory, searchStats: s }));
    const largest = 400 * 70; // a text file of repoWithHistory
    expect(s.peakWindowBytes).toBeGreaterThan(0);
    expect(s.peakWindowBytes).toBeLessThanOrEqual(windowMemory + largest);
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
