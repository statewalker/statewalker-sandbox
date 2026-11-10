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
    expect(String(err)).toMatch(/CRC|corrupt|crc/i);
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
      if (++n % 64 === 0) {
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
