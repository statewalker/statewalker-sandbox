import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { copyAll, delta, oidOf } from "../../12-index-pack/src/craft.js";
import { CRC_INIT, crc32Update, crcFinal } from "../../12-index-pack/src/crc32.js";
import { git, noise, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { writeIdx } from "../../12-index-pack/src/index-pack.js";
import { log } from "../../17-repository/src/commands.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { exportPack, listObjects } from "../../18-pack-export/src/export.js";
import { exportPackReusing, type ReuseStats } from "../src/export-reuse.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6d-"));
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
const stats = (): ReuseStats => ({ reusedWhole: 0, reusedDelta: 0, thinDelta: 0, deflated: 0 });
const objectsOfPack = (pack: Uint8Array) => {
  const d = emptyRepo();
  git(d, ["index-pack", "--stdin"], pack);
  return git(d, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .toString()
    .trim()
    .split("\n")
    .sort();
};

describe("R1 reuse of a native-git pack", () => {
  it("git's objects, accepted, within 1.25× of git pack-objects, > 90 % copied as stored", async () => {
    const src = repoWithHistory(60);
    git(src, ["gc", "-q", "--aggressive"]);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const s = stats();
    const ours = await collect(exportPackReusing(repo, [head], [], { stats: s }));
    const listed = (await listObjects(repo, [head], [])).map((o) => o.oid).sort();
    expect(objectsOfPack(ours)).toEqual(listed);
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], ours);
    git(dst, ["update-ref", "refs/heads/main", head]);
    git(dst, ["fsck", "--full", "--strict"]);
    const theirs = packAll(src, true);
    const whole = await collect(exportPack(repo, [head], []));
    console.log(
      `R1: reuse ${ours.length} B, whole ${whole.length} B, git ${theirs.length} B; ${JSON.stringify(s)}`,
    );
    expect(ours.length).toBeLessThanOrEqual(theirs.length * 1.25);
    expect(s.reusedWhole + s.reusedDelta).toBeGreaterThan(0.9 * listed.length);
  });
});

describe("R2 thin packs", () => {
  it("smaller than non-thin, deltas against the receiver's objects; native and X6b receivers install it", async () => {
    const src = repoWithHistory(30);
    git(src, ["gc", "-q"]);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const have = git(src, ["rev-parse", "HEAD~5"]).toString().trim();
    const full = await collect(exportPackReusing(repo, [head], [have]));
    const s = stats();
    const thin = await collect(exportPackReusing(repo, [head], [have], { thin: true, stats: s }));
    console.log(`R2: thin ${thin.length} B, non-thin ${full.length} B; ${JSON.stringify(s)}`);
    expect(thin.length).toBeLessThan(full.length);
    expect(s.thinDelta).toBeGreaterThan(0);
    const seed = git(
      src,
      ["pack-objects", "--stdout", "-q"],
      git(src, ["rev-list", "--objects", "HEAD~5"]),
    );
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], seed);
    git(dst, ["index-pack", "--stdin", "--fix-thin"], thin);
    git(dst, ["update-ref", "refs/heads/main", head]);
    git(dst, ["fsck", "--full"]);
    const dst2 = emptyRepo();
    git(dst2, ["index-pack", "--stdin"], seed);
    const repo2 = await open(dst2);
    await repo2.objects.installPack(chunks(thin));
    await repo2.refs.batch([{ name: "refs/heads/main", new: head }]);
    git(dst2, ["fsck", "--full"]);
    expect(await log(repo2, "refs/heads/main")).toEqual(await log(repo, head));
  });
});

describe("R3 a corrupt packed entry is not passed on", () => {
  it("bytes changed inside a stored entry (CRC mismatch): the export fails", async () => {
    const src = repoWithHistory(10);
    git(src, ["gc", "-q"]);
    const packDir = join(src, ".git", "objects", "pack");
    const name = readdirSync(packDir).find((n) => n.endsWith(".pack")) as string;
    const p = join(packDir, name);
    const bytes = new Uint8Array(readFileSync(p));
    // flip a byte in the middle of the pack (inside some entry's compressed data)
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] as number) ^ 0x01;
    rmSync(p, { force: true });
    writeFileSync(p, bytes);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const err = await collect(exportPackReusing(repo, [head], [])).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/idx CRC|corrupt|inflat|zlib|incorrect|invalid/i);
  });
});

/** A pack (and its idx) of the given entries, written as is: offsets and CRCs computed here. */
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

describe("R4 no delta cycles across packs", () => {
  it("pack 1 stores A against B, pack 2 stores B against A: the export has no cycle", async () => {
    const enc = new TextEncoder();
    const A = enc.encode("version A ".repeat(50));
    const B = new Uint8Array([...A, ...enc.encode(" and B")]);
    const a = oidOf("blob", A);
    const b = oidOf("blob", B);
    const dAB = delta(B.length, A.length, copyAll(A.length)); // A from B
    const dBA = delta(A.length, B.length, [...copyAll(A.length), 6, ...enc.encode(" and B")]); // B from A
    const d = emptyRepo();
    const pd = join(d, ".git", "objects", "pack");
    // names sort as given: pack "0…" is consulted first, so A comes from pack 1, B from pack 2
    const p1 = rawPack([{ kind: 7, data: dAB, baseOid: b, oid: a }]);
    const p2 = rawPack([
      { kind: 3, data: A, oid: a },
      { kind: 7, data: dBA, baseOid: a, oid: b },
    ]);
    const write = (p: typeof p1, n: string) => {
      writeFileSync(join(pd, `pack-${n}.pack`), p.pack);
      writeFileSync(join(pd, `pack-${n}.idx`), p.idx);
    };
    write(p1, `0${p1.id.slice(1)}`);
    write(p2, `f${p2.id.slice(1)}`);
    const repo = await open(d);
    expect((await repo.objects.get(a, { verify: true }))?.size).toBe(A.length);
    expect((await repo.objects.get(b, { verify: true }))?.size).toBe(B.length);
    const ours = await collect(
      (await import("../src/export-reuse.js")).writePackReusing(repo, [
        { oid: a, type: "blob" },
        { oid: b, type: "blob" },
      ]),
    );
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], ours);
    expect(git(dst, ["cat-file", "-p", a]).toString()).toBe(new TextDecoder().decode(A));
    expect(git(dst, ["cat-file", "-p", b]).toString()).toBe(new TextDecoder().decode(B));
  });
});

describe("R5 SQL backend", () => {
  it("packs in SqliteFilesApi are reused; loose rows are sent whole", async () => {
    const src = repoWithHistory(30);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const repo = await sqlRepository(await newNodeSqliteDb());
    await repo.objects.installPack(chunks(packAll(src, true)));
    const extra = await repo.objects.put("blob", new TextEncoder().encode("a loose row\n"));
    const s = stats();
    const ours = await collect(
      (await import("../src/export-reuse.js")).writePackReusing(
        repo,
        [...(await listObjects(repo, [head], [])), { oid: extra, type: "blob" }],
        { stats: s },
      ),
    );
    expect(s.deflated).toBe(1); // the loose row
    expect(s.reusedWhole + s.reusedDelta).toBeGreaterThan(100);
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], ours);
    git(dst, ["update-ref", "refs/heads/main", head]);
    git(dst, ["fsck", "--full"]);
  });
});

describe("R6 a large stored entry is copied, streaming", () => {
  it("a 64 MiB blob stored whole: < 16 MiB extra live, no deflate", async () => {
    const d = emptyRepo();
    writeFileSync(join(d, "big.bin"), noise(64 * 2 ** 20, 7));
    git(d, ["add", "big.bin"]);
    git(d, ["commit", "-q", "-m", "big"]);
    git(d, ["gc", "-q"]);
    const repo = await open(d);
    const head = git(d, ["rev-parse", "HEAD"]).toString().trim();
    const gc = () => (globalThis as { gc?: () => void }).gc?.();
    const live = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    gc();
    gc();
    const base = live();
    let peak = 0;
    let n = 0;
    const s = stats();
    for await (const _ of exportPackReusing(repo, [head], [], { stats: s })) {
      if (++n % 16 === 1) {
        gc();
        gc();
        peak = Math.max(peak, live() - base);
      }
    }
    console.log(`R6: peak +${(peak / 2 ** 20).toFixed(1)} MiB; ${JSON.stringify(s)}`);
    expect(s.deflated).toBe(0);
    expect(peak).toBeLessThan(16 * 2 ** 20);
  }, 300_000);
});

/** Review of #75: fall back past bad copies, check before sending, base first, depth, shallow receivers. */
describe("review cases (#75)", () => {
  const enc = new TextEncoder();
  /** `git verify-pack -v` rows of a pack: offset, depth and base for deltas. */
  const rows = (pack: Uint8Array) => {
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
        offset: Number(f[4]),
        depth: f[5] ? Number(f[5]) : 0,
        base: f[6],
      }));
  };
  it("a corrupt copy is not used when another pack holds the object: the export succeeds", async () => {
    const A = enc.encode("the content of A ".repeat(40));
    const a = oidOf("blob", A);
    const d = emptyRepo();
    const pd = join(d, ".git", "objects", "pack");
    const bad = rawPack([{ kind: 3, data: A, oid: a }]);
    // corrupt the copy in the pack consulted first (its idx CRC no longer matches)
    bad.pack[bad.pack.length - 25] = (bad.pack[bad.pack.length - 25] as number) ^ 0x01;
    const good = rawPack([{ kind: 3, data: A, oid: a }]);
    writeFileSync(join(pd, `pack-0${bad.id.slice(1)}.pack`), bad.pack);
    writeFileSync(join(pd, `pack-0${bad.id.slice(1)}.idx`), bad.idx);
    writeFileSync(join(pd, `pack-f${good.id.slice(1)}.pack`), good.pack);
    writeFileSync(join(pd, `pack-f${good.id.slice(1)}.idx`), good.idx);
    const repo = await open(d);
    const { writePackReusing } = await import("../src/export-reuse.js");
    const out = await collect(writePackReusing(repo, [{ oid: a, type: "blob" }]));
    const dst = emptyRepo();
    git(dst, ["index-pack", "--stdin"], out);
    expect(git(dst, ["cat-file", "-p", a]).toString()).toBe(new TextDecoder().decode(A));
  });
  it("a corrupt entry with no other copy fails the export before any of its bytes are sent", async () => {
    const A = enc.encode("only copy ".repeat(60));
    const a = oidOf("blob", A);
    const d = emptyRepo();
    const pd = join(d, ".git", "objects", "pack");
    const bad = rawPack([{ kind: 3, data: A, oid: a }]);
    bad.pack[bad.pack.length - 25] = (bad.pack[bad.pack.length - 25] as number) ^ 0x01;
    writeFileSync(join(pd, `pack-${bad.id}.pack`), bad.pack);
    writeFileSync(join(pd, `pack-${bad.id}.idx`), bad.idx);
    const repo = await open(d);
    const { writePackReusing } = await import("../src/export-reuse.js");
    let sent = 0;
    const err = await (async () => {
      for await (const c of writePackReusing(repo, [{ oid: a, type: "blob" }])) sent += c.length;
    })().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(sent).toBeLessThanOrEqual(12); // the pack header only: no byte of the corrupt entry
  });
  it("every reused delta's base is written before it", async () => {
    const src = repoWithHistory(30);
    git(src, ["gc", "-q", "--aggressive"]);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const r = rows(await collect(exportPackReusing(repo, [head], [])));
    const at = new Map(r.map((x) => [x.oid, x.offset]));
    const deltas = r.filter((x) => x.base);
    expect(deltas.length).toBeGreaterThan(50);
    for (const x of deltas) expect(at.get(x.base as string), x.oid).toBeLessThan(x.offset);
  });
  it("reused chains are cut at git's default depth (50)", async () => {
    const { buildPack } = await import("../../12-index-pack/src/craft.js");
    const base = enc.encode("chain base ".repeat(30));
    const entries: import("../../12-index-pack/src/craft.js").CraftEntry[] = [
      { kind: 3, data: base },
    ];
    let len = base.length;
    for (let i = 0; i < 70; i++) {
      entries.push({ kind: 6, baseIdx: i, data: delta(len, len + 1, [...copyAll(len), 1, i]) });
      len++;
    }
    const d = emptyRepo();
    const repo = await open(d);
    await repo.objects.installPack(chunks(buildPack(entries)));
    const ids: { oid: string; type: "blob" }[] = [];
    for await (const id of repo.objects.list()) ids.push({ oid: id, type: "blob" });
    const { writePackReusing } = await import("../src/export-reuse.js");
    const r = rows(await collect(writePackReusing(repo, ids)));
    expect(r.length).toBe(71);
    expect(Math.max(...r.map((x) => x.depth))).toBeLessThanOrEqual(50);
  });
  it("a thin pack for a shallow receiver: bases only from what it has (its shallow commits passed in)", async () => {
    const src = repoWithHistory(10);
    git(src, ["gc", "-q"]);
    const h = git(src, ["rev-parse", "HEAD"]).toString().trim();
    // a receiver that cloned only HEAD (depth 1): it lacks HEAD~1 and older
    const recv = tmp();
    git(tmpdir(), ["clone", "-q", "--depth", "1", `file://${src}`, recv]);
    writeFileSync(join(src, "file0.txt"), `${readFileSync(join(src, "file0.txt"), "utf8")}more\n`);
    git(src, ["commit", "-q", "-am", "one more"]);
    git(src, ["gc", "-q"]);
    const want = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const repo = await open(src);
    const thin = await collect(exportPackReusing(repo, [want], [h], { thin: true, shallow: [h] }));
    git(recv, ["index-pack", "--stdin", "--fix-thin"], thin);
    git(recv, ["update-ref", "refs/heads/main", want]);
    git(recv, ["fsck", "--full"]);
  });
});
