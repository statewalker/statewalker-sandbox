import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@statewalker/db-api";
import { SQLITE_TRANSACTION, type SqliteTransactionHook } from "@statewalker/db-sqlite";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import json from "../../09-git-objects/fixtures/corpus.json" with { type: "json" };
import { decodeCorpus } from "../../09-git-objects/src/corpus.js";
import { gitObjects } from "../../09-git-objects/src/git-objects.js";
import { runObjectContract } from "../../09-git-objects/src/object-contract.js";
import { filesStagingStore } from "../../09-git-objects/src/staging.js";
import { pattern, runBlobContract } from "../src/blob-contract.js";
import { sqlBlobStore } from "../src/sql-blob-store.js";

const BLOB_CASES = 22;
const OBJECT_CASES = 20;
const CHUNK = 4096; // small rows so multi-row cases stay cheap
const MiB = 2 ** 20;
const corpus = decodeCorpus(json);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmpFile = () => {
  const d = mkdtempSync(join(tmpdir(), "x3b-"));
  dirs.push(d);
  return join(d, "db.sqlite");
};
let n = 0;
const fresh = (db: Db, chunkSize = CHUNK) => sqlBlobStore(db, { prefix: `t${n++}_`, chunkSize });

/** Wraps a Db so every statement (also inside transactions) counts; it dies at statement `k`. */
function instrumented(db: Db, k = Number.POSITIVE_INFINITY) {
  const stats = { statements: 0, rows: 0, chunkRows: 0 };
  const gate = () => {
    stats.statements++;
    if (stats.statements >= k) throw new Error(`db died at statement ${k}`);
  };
  const wrap = (inner: Db): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      gate();
      const rows = await inner.query<T>(sql, params);
      stats.rows += rows.length;
      if (/FROM \w+chunks/.test(sql) && /data/.test(sql)) stats.chunkRows += rows.length;
      return rows;
    },
    async exec(sql: string) {
      gate();
      return inner.exec(sql);
    },
    close: () => inner.close(),
  });
  const outer = wrap(db) as Db & { [SQLITE_TRANSACTION]?: SqliteTransactionHook };
  const hook = (db as unknown as Record<symbol, SqliteTransactionHook>)[SQLITE_TRANSACTION];
  if (hook)
    outer[SQLITE_TRANSACTION] = ((cb: (tx: Db) => Promise<unknown>) =>
      hook((tx) => cb(wrap(tx)))) as SqliteTransactionHook;
  return { db: outer, stats };
}

describe("R1 BlobStore contract on node:sqlite", () => {
  it("in memory", async () => {
    const db = await newNodeSqliteDb();
    const r = await runBlobContract(() => fresh(db), CHUNK);
    expect(r.cases).toBe(BLOB_CASES);
    expect(r.failed).toEqual([]);
  });
  it("on a file", async () => {
    const db = await newNodeSqliteDb({ path: tmpFile() });
    const r = await runBlobContract(() => fresh(db), CHUNK);
    expect(r.cases).toBe(BLOB_CASES);
    expect(r.failed).toEqual([]);
  });
});

describe("R2 X4 git-object contract over the native store", () => {
  it("node:sqlite", async () => {
    const db = await newNodeSqliteDb();
    const r = await runObjectContract(() => fresh(db), corpus);
    expect(r.cases).toBe(OBJECT_CASES);
    expect(r.failed).toEqual([]);
  });
});

describe("R3 atomicity", () => {
  it("a Db dying at every statement of a staged put leaves no blob or the whole blob", async () => {
    const data = pattern(CHUNK * 3 + 100, 5);
    let completed = false;
    const outcomes = new Set<string>();
    for (let k = 1; k <= 200 && !completed; k++) {
      const real = await newNodeSqliteDb({ path: tmpFile() });
      await sqlBlobStore(real, { chunkSize: CHUNK }); // tables exist before the crash run
      const { db } = instrumented(real, k);
      try {
        const s = await sqlBlobStore(db, { chunkSize: CHUNK });
        const r = await s.putStaged(
          (async function* () {
            for (let i = 0; i < data.length; i += 1000) yield data.subarray(i, i + 1000);
          })(),
          () => "obj",
        );
        completed = r.stored;
      } catch {
        // died
      }
      const after = await sqlBlobStore(real, { chunkSize: CHUNK });
      const has = await after.has("obj");
      if (has) {
        const parts: Uint8Array[] = [];
        for await (const c of after.get("obj")) parts.push(c);
        const got = Buffer.concat(parts);
        expect(got.equals(Buffer.from(data)), `crash at ${k}: partial blob visible`).toBe(true);
      }
      await after.sweepStaged?.(0);
      expect(await after.sweepStaged?.(0), `crash at ${k}: temporaries left`).toBe(0);
      outcomes.add(has ? "whole" : "absent");
      await real.close();
    }
    expect(completed).toBe(true);
    expect([...outcomes].sort()).toEqual(["absent", "whole"]);
  });
});

/** Live heap + array buffers, sampled after a full GC every 50 ms (see X4). */
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const mem = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
async function settle() {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function peakDuring<T>(run: () => Promise<T>) {
  await settle();
  const base = mem();
  let peak = 0;
  const sample = () => {
    gc();
    peak = Math.max(peak, mem() - base);
  };
  const t = setInterval(sample, 50);
  try {
    const result = await run();
    sample();
    return { result, peak };
  } finally {
    clearInterval(t);
  }
}

describe("R4 bounded memory (1 MiB rows)", () => {
  it("a 64 MB incompressible blob is written and read back with < 16 MB live", async () => {
    const db = await newNodeSqliteDb({ path: tmpFile() });
    const s = await sqlBlobStore(db);
    const MB = 64;
    const chunk = pattern(MiB, 9);
    const w = await peakDuring(() =>
      s.putStaged(
        (async function* () {
          for (let i = 0; i < MB; i++) yield chunk.slice();
        })(),
        () => "big",
      ),
    );
    let total = 0;
    const r = await peakDuring(async () => {
      for await (const c of s.get("big")) total += c.length;
    });
    console.log(
      `R4 64 MB: write peak +${(w.peak / MiB).toFixed(1)} MB, read peak +${(r.peak / MiB).toFixed(1)} MB`,
    );
    expect(total).toBe(MB * MiB);
    expect(w.peak).toBeLessThan(16 * MiB);
    expect(r.peak).toBeLessThan(16 * MiB);
  }, 120_000);
});

describe("R5 range reads fetch only overlapping rows", () => {
  it("a range inside one row of a 10-row blob reads one row; across a boundary, two", async () => {
    const real = await newNodeSqliteDb();
    const { db, stats } = instrumented(real);
    const s = await sqlBlobStore(db, { chunkSize: CHUNK });
    await s.put(
      "ten",
      (async function* () {
        yield pattern(CHUNK * 10);
      })(),
    );
    stats.chunkRows = 0;
    for await (const _ of s.get("ten", { start: CHUNK * 4 + 10, end: CHUNK * 4 + 20 }));
    const one = stats.chunkRows;
    stats.chunkRows = 0;
    for await (const _ of s.get("ten", { start: CHUNK * 6 - 5, end: CHUNK * 6 + 5 }));
    expect([one, stats.chunkRows]).toEqual([1, 2]);
  });
});

describe("R6 native vs composition (node:sqlite file)", () => {
  it("2 000 git-sized objects and 16 x 1 MiB through X4's kernel", async () => {
    const small = Array.from({ length: 2000 }, (_, i) =>
      pattern(100 + ((i * 2654435761) % 8092), i + 1),
    );
    const large = Array.from({ length: 16 }, (_, i) => pattern(MiB, 1000 + i));
    const rows: string[] = [];
    for (const kind of ["native", "composition"] as const) {
      const real = await newNodeSqliteDb({ path: tmpFile() });
      const { db, stats } = instrumented(real);
      const store =
        kind === "native"
          ? await sqlBlobStore(db)
          : await (async () => {
              const fs = new SqliteFilesApi(db, { compression: null });
              await fs.init();
              return filesStagingStore(fs, "/objects");
            })();
      const objs = gitObjects(store);
      const one = async function* (b: Uint8Array) {
        yield b;
      };
      const t0 = performance.now();
      const ids: string[] = [];
      for (const b of small) ids.push(await objs.put("blob", b.length, one(b)));
      const t1 = performance.now();
      const s1 = stats.statements;
      for (const id of ids) for await (const _ of objs.getRaw(id));
      const t2 = performance.now();
      const s2 = stats.statements;
      const lids: string[] = [];
      for (const b of large) lids.push(await objs.put("blob", b.length, one(b)));
      const t3 = performance.now();
      for (const id of lids) for await (const _ of objs.getRaw(id));
      const t4 = performance.now();
      rows.push(
        `${kind.padEnd(12)} small put ${(t1 - t0).toFixed(0)} ms (${(s1 / 2000).toFixed(1)} stmt/obj), small get ${(t2 - t1).toFixed(0)} ms (${((s2 - s1) / 2000).toFixed(1)} stmt/obj), 16 MiB put ${(t3 - t2).toFixed(0)} ms, get ${(t4 - t3).toFixed(0)} ms`,
      );
      expect(ids.length).toBe(2000);
      await real.close();
    }
    console.log(`R6\n${rows.join("\n")}`);
  }, 300_000);
});

describe("R1/R2 inside a Durable Object on workerd", () => {
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
    });
    mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { BLOBS: { className: "BlobsDo", useSQLite: true } },
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  for (const kind of ["blob", "object"]) {
    it(`${kind} contract`, async () => {
      const r = (await (
        await mf.dispatchFetch(`http://x/contract?kind=${kind}`, { method: "POST" })
      ).json()) as {
        cases: number;
        failed: string[];
      };
      expect(r.cases).toBe(kind === "blob" ? BLOB_CASES : OBJECT_CASES);
      expect(r.failed).toEqual([]);
    }, 120_000);
  }
  it("a 16 MiB blob in 1 MiB rows round-trips under the DO limits", async () => {
    const r = (await (await mf.dispatchFetch("http://x/big", { method: "POST" })).json()) as {
      ok: boolean;
      error?: string;
    };
    expect(r).toEqual({ ok: true });
  }, 120_000);
});
