import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@statewalker/db-api";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { git, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { openPack } from "../../13-pack-reader/src/pack-reader.js";
import { installPack } from "../../14-thin-packs/src/index-pack.js";
import { explodedObjects, explodeStep } from "../src/explode.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6b3-"));
  dirs.push(d);
  return d;
};
async function* chunks(bytes: Uint8Array, size = 65536) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
const collect = async (s: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
};

/** Installs `pack` into `files` (X6b1) and opens it (X6r). */
async function readerOf(files: FilesApi, pack: Uint8Array) {
  const r = await installPack(files, "/objects/pack", chunks(pack));
  const base = `/objects/pack/pack-${r.packId}`;
  return openPack(files, `${base}.pack`, `${base}.idx`);
}

/** git cat-file --batch for every object of `pack`: id → [type, content]. */
function gitObjectsOf(pack: Uint8Array): Map<string, [string, Buffer]> {
  const d = tmp();
  git(d, ["init", "-q", "."]);
  git(d, ["index-pack", "--stdin"], pack);
  const ids = git(d, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .toString()
    .trim()
    .split("\n");
  const out = git(d, ["cat-file", "--batch"], `${ids.join("\n")}\n`);
  const map = new Map<string, [string, Buffer]>();
  let p = 0;
  while (p < out.length) {
    const nl = out.indexOf(10, p);
    const [id, type, size] = out.subarray(p, nl).toString().split(" ");
    const n = Number(size);
    map.set(id as string, [type as string, out.subarray(nl + 1, nl + 1 + n)]);
    p = nl + 1 + n + 1;
  }
  return map;
}

async function explodeAll(db: Db, reader: Awaited<ReturnType<typeof readerOf>>, batch = 1024) {
  for (;;) {
    const r = await explodeStep(db, reader, { batch });
    if (r.done) return r;
  }
}

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
  ["OFS_DELTA", packAll(history, true)],
  ["REF_DELTA", packAll(history, false)],
  ["gc --aggressive", aggressive],
  ["a 4 MiB blob and a delta against it", packAll(withBig, true)],
];

describe("R1 exploded objects read back as git cat-file", () => {
  for (const [name, pack] of variants) {
    it(name, async () => {
      const reader = await readerOf(new MemFilesApi(), pack);
      const db = await newNodeSqliteDb();
      const r = await explodeAll(db, reader);
      expect(r.next).toBe(reader.count);
      const objects = await explodedObjects(db);
      const ref = gitObjectsOf(pack);
      expect(ref.size).toBe(reader.count);
      for (const [id, [type, content]] of ref) {
        const o = await objects.get(id, { verify: true });
        expect(o?.type, id).toBe(type);
        expect(o?.size).toBe(content.length);
        const bytes = await collect(o?.content ?? []);
        expect(Buffer.compare(Buffer.from(bytes), content), id).toBe(0);
      }
      const listed: string[] = [];
      for await (const id of objects.list()) listed.push(id);
      expect(listed.sort()).toEqual([...ref.keys()].sort());
    }, 120_000);
  }
});

describe("R2 many objects per transaction", () => {
  it("1 024 objects per transaction is ≥ 5× faster than one, on a file database", async () => {
    const pack = packAll(history, true);
    const times: Record<number, number> = {};
    for (const batch of [1, 64, 1024]) {
      const reader = await readerOf(new MemFilesApi(), pack);
      const db = await newNodeSqliteDb({ path: join(tmp(), "db.sqlite") });
      const t0 = performance.now();
      await explodeAll(db, reader, batch);
      times[batch] = performance.now() - t0;
      await db.close();
    }
    console.log(
      `R2 ${packAll(history, true).length} B pack: ${Object.entries(times)
        .map(([b, t]) => `batch ${b}: ${t.toFixed(0)} ms`)
        .join(", ")}`,
    );
    expect((times[1024] as number) * 5).toBeLessThanOrEqual(times[1] as number);
  }, 300_000);
});

/** A Db that fails at statement `k` (also inside transactions), as X3b's trap tests. */
function dying(db: Db, k: number) {
  let n = 0;
  const gate = () => {
    if (++n === k) throw new Error(`db died at statement ${k}`);
  };
  const wrap = (inner: Db): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      gate();
      return inner.query<T>(sql, params);
    },
    async exec(sql: string) {
      gate();
      return inner.exec(sql);
    },
    close: () => inner.close(),
  });
  const outer = wrap(db) as Db & Record<symbol, unknown>;
  for (const sym of Object.getOwnPropertySymbols(db)) {
    const hook = (db as unknown as Record<symbol, (cb: (tx: Db) => Promise<unknown>) => unknown>)[
      sym
    ];
    if (typeof hook === "function")
      outer[sym] = (cb: (tx: Db) => Promise<unknown>) => hook((tx) => cb(wrap(tx)));
  }
  return { db: outer as Db, count: () => n };
}

describe("R3 steps with the progress in the objects' transaction survive a failure anywhere", () => {
  it("a Db failing at statement k (swept), then resumed: every object present and verified", async () => {
    const pack = packAll(withBig, true); // small objects and one 4 MiB object (the staged path)
    const ref = gitObjectsOf(pack);
    const reader = await readerOf(new MemFilesApi(), pack);
    const probe = dying(await newNodeSqliteDb(), 0);
    for (;;) if ((await explodeStep(probe.db, reader, { batch: 4, units: 5 })).done) break;
    const total = probe.count();
    expect(total).toBeGreaterThan(20);
    for (let k = 1; k <= total; k++) {
      const db = await newNodeSqliteDb();
      const sick = dying(db, k).db;
      try {
        for (;;) if ((await explodeStep(sick, reader, { batch: 4, units: 5 })).done) break;
      } catch {
        // the injected failure
      }
      for (;;) if ((await explodeStep(db, reader, { batch: 4, units: 5 })).done) break;
      const objects = await explodedObjects(db);
      let n = 0;
      for await (const _id of objects.list()) n++;
      expect(n, `k=${k}`).toBe(ref.size);
      for (const [id, [type, content]] of ref) {
        const o = await objects.get(id, { verify: true });
        expect(o?.type, `k=${k} ${id}`).toBe(type);
        expect(Buffer.compare(Buffer.from(await collect(o?.content ?? [])), content)).toBe(0);
      }
      await db.close();
    }
  }, 600_000);
  it("the progress row never runs ahead of the objects", async () => {
    const reader = await readerOf(new MemFilesApi(), packAll(history, true));
    const db = await newNodeSqliteDb();
    for (;;) {
      const r = await explodeStep(db, reader, { batch: 16, units: 37 });
      const ids = [...reader.ids()].slice(0, r.next);
      const objects = await explodedObjects(db);
      for (const id of ids) expect(await objects.has(id)).toBe(true);
      if (r.done) break;
      expect(r.written).toBe(37);
    }
  });
});

describe("R4 exploded rows against the pack kept in SqliteFilesApi", () => {
  it("ingest, bytes, read-all and random reads on a file database", async () => {
    const big = repoWithHistory(150);
    const pack = packAll(big, true);
    const rows: string[] = [];
    // pack + idx in SqliteFilesApi, read by X6r
    const pPath = join(tmp(), "pack.sqlite");
    const pdb = await newNodeSqliteDb({ path: pPath });
    const pfiles = new SqliteFilesApi(pdb, { compression: null });
    await pfiles.init();
    let t0 = performance.now();
    const preader = await readerOf(pfiles, pack);
    const tPackIngest = performance.now() - t0;
    // exploded rows (the pack itself read from memory, as after any ingest)
    const ePath = join(tmp(), "rows.sqlite");
    const edb = await newNodeSqliteDb({ path: ePath });
    const mreader = await readerOf(new MemFilesApi(), pack);
    t0 = performance.now();
    await explodeAll(edb, mreader);
    const tExplode = performance.now() - t0;
    const objects = await explodedObjects(edb);
    const ids = [...preader.ids()];
    const readAll = async (get: (id: string) => Promise<AsyncIterable<Uint8Array> | undefined>) => {
      const t = performance.now();
      let bytes = 0;
      for (const id of ids) bytes += (await collect((await get(id)) ?? [])).length;
      return { ms: performance.now() - t, bytes };
    };
    let seed = 3;
    const random = Array.from({ length: 1000 }, () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return ids[seed % ids.length] as string;
    });
    const readSome = async (
      get: (id: string) => Promise<AsyncIterable<Uint8Array> | undefined>,
    ) => {
      const t = performance.now();
      for (const id of random) await collect((await get(id)) ?? []);
      return performance.now() - t;
    };
    // a fresh reader: no warm base cache from the ingest
    const preader2 = await openPack(
      pfiles,
      `/objects/pack/pack-${preader.packId}.pack`,
      `/objects/pack/pack-${preader.packId}.idx`,
    );
    const pAll = await readAll(async (id) => (await preader2.get(id))?.content);
    const eAll = await readAll(async (id) => (await objects.get(id))?.content);
    const pRand = await readSome(async (id) => (await preader2.get(id))?.content);
    const eRand = await readSome(async (id) => (await objects.get(id))?.content);
    await pdb.close();
    await edb.close();
    const size = (p: string) => statSync(p).size;
    rows.push(
      `R4 ${ids.length} objects, ${pack.length} B pack, ${pAll.bytes} B of content:`,
      `  pack+idx (SqliteFilesApi): install ${tPackIngest.toFixed(0)} ms, db ${size(pPath)} B, read all ${pAll.ms.toFixed(0)} ms, 1000 random ${pRand.toFixed(0)} ms`,
      `  exploded rows (X3b):       explode ${tExplode.toFixed(0)} ms, db ${size(ePath)} B, read all ${eAll.ms.toFixed(0)} ms, 1000 random ${eRand.toFixed(0)} ms`,
    );
    console.log(rows.join("\n"));
    writeFileSync(join(tmp(), "r4.txt"), rows.join("\n"));
    expect(eAll.bytes).toBe(pAll.bytes);
  }, 600_000);
});

describe("R5 inside a Durable Object, the runtime restarted between steps", () => {
  it("X6a's fixture pack exploded in steps of 40 objects: every object verifies", async () => {
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
    const persist = tmp();
    const call = async (path: string) => {
      const mf = new Miniflare({
        modules: true,
        script: out.outputFiles[0]?.text ?? "",
        compatibilityDate: "2026-07-01",
        durableObjectsPersist: persist,
        durableObjects: { OBJS: { className: "ObjectsDo", useSQLite: true } },
      });
      try {
        return (await (await mf.dispatchFetch(`http://x${path}`, { method: "POST" })).json()) as {
          done?: boolean;
          next?: number;
          total?: number;
          verified?: number;
          error?: string;
        };
      } finally {
        await mf.dispose();
      }
    };
    expect((await call("/install")).error).toBeUndefined();
    let steps = 0;
    for (;;) {
      const r = await call("/step?units=40");
      expect(r.error).toBeUndefined();
      steps++;
      if (r.done) break;
      expect(steps).toBeLessThan(100);
    }
    const v = await call("/verify");
    expect(v.error).toBeUndefined();
    expect(v.verified).toBe(v.total);
    expect(v.total).toBeGreaterThan(100);
    expect(steps).toBeGreaterThan(3);
  }, 600_000);
});
