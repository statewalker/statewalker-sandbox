import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
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
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { SqliteFilesApi } from "@statewalker/webrun-files-sqlite";
import { memBlobStore } from "@statewalker/webrun-storage";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import json from "../fixtures/corpus.json" with { type: "json" };
import { decodeCorpus } from "../src/corpus.js";
import { gitObjects } from "../src/git-objects.js";
import { StreamingNodeFilesApi } from "../src/node-streaming-files.js";
import { collect, runObjectContract } from "../src/object-contract.js";
import { filesStagingStore, withStaging } from "../src/staging.js";

const corpus = decodeCorpus(json);
const CASES = 20;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x4-"));
  dirs.push(d);
  return d;
};
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() };
const git = (cwd: string, args: string[], input?: Uint8Array | string) =>
  execFileSync("git", args, { cwd, env: gitEnv, input, maxBuffer: 1 << 27 });
const newRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "."]);
  return d;
};
const repoStore = (repo: string) =>
  filesStagingStore(new NodeFilesApi({ rootDir: repo }), "/.git/objects");
const body = (raw: Uint8Array) => raw.subarray(raw.indexOf(0) + 1);
const fsck = (repo: string) => {
  const r = spawnSync(
    "git",
    ["-c", "fsck.missingSpaceBeforeEmail=warn", "fsck", "--full", "--no-dangling"],
    { cwd: repo, env: gitEnv, encoding: "utf8" },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}`.trim() };
};

describe("R1 corpus fixture is native git's", () => {
  it("every id equals `git hash-object --literally` of the content", () => {
    const repo = newRepo();
    expect(corpus.length).toBe(21);
    for (const o of corpus) {
      const id = git(repo, ["hash-object", "--literally", "-t", o.type, "--stdin"], body(o.raw));
      expect(id.toString().trim(), o.name).toBe(o.id);
    }
  });
});

describe("R1/R3/R5 contract on every Node adapter", () => {
  const adapters: [string, () => Promise<Parameters<typeof gitObjects>[0]>][] = [
    [
      "memBlobStore (generic staging: temporary id, then copy)",
      async () => withStaging(memBlobStore()),
    ],
    ["FilesApi: MemFilesApi", async () => filesStagingStore(new MemFilesApi(), "/objects")],
    ["FilesApi: NodeFilesApi in a git repository", async () => repoStore(newRepo())],
    [
      "FilesApi: SqliteFilesApi on node:sqlite (no second compression)",
      async () => {
        const fs = new SqliteFilesApi(await newNodeSqliteDb(), { compression: null });
        await fs.init();
        return filesStagingStore(fs, "/objects");
      },
    ],
  ];
  for (const [name, make] of adapters) {
    it(name, async () => {
      const r = await runObjectContract(make, corpus);
      expect(r.cases).toBe(CASES);
      expect(r.failed).toEqual([]);
    });
  }
});

describe("R2 native git interop", () => {
  it("objects we write are printed byte-identically by git cat-file and pass git fsck --full", async () => {
    const repo = newRepo();
    const objs = gitObjects(repoStore(repo));
    for (const o of corpus)
      expect(await objs.put(o.type, body(o.raw).length, [body(o.raw)].values() as never)).toBe(
        o.id,
      );
    for (const o of corpus) {
      expect(git(repo, ["cat-file", "-t", o.id]).toString().trim()).toBe(o.type);
      expect(new Uint8Array(git(repo, ["cat-file", o.type, o.id])), o.name).toEqual(body(o.raw));
    }
    // fsck re-inflates and re-hashes every loose object. The corpus holds one commit with
    // "Name<a@b>" (as some old importers wrote); fsck calls that an error by default, and git's own
    // fsck.<msg-id> config downgrades it. Exotic-but-valid objects only produce warnings.
    const r = fsck(repo);
    expect(r.status, r.output).toBe(0);
    expect(r.output).not.toMatch(/hash mismatch|corrupt|inflate|garbage|sha1 mismatch/i);
  });
  for (const level of [0, 1, 9]) {
    it(`objects git writes at core.compression=${level} are read back byte-identically`, async () => {
      const repo = newRepo();
      for (const o of corpus) {
        git(
          repo,
          [
            "-c",
            `core.compression=${level}`,
            "hash-object",
            "--literally",
            "-w",
            "-t",
            o.type,
            "--stdin",
          ],
          body(o.raw),
        );
      }
      const objs = gitObjects(repoStore(repo));
      for (const o of corpus) {
        expect(await collect(objs.getRaw(o.id)), o.name).toEqual(o.raw);
        const g = await objs.get(o.id, { verify: true });
        expect(g?.type).toBe(o.type);
        expect(await collect(g?.content ?? ([].values() as never))).toEqual(body(o.raw));
      }
    });
  }
  it("list() over a real .git/objects yields only object ids", async () => {
    const repo = newRepo();
    for (const o of corpus.slice(0, 5)) {
      git(repo, ["hash-object", "--literally", "-w", "-t", o.type, "--stdin"], body(o.raw));
    }
    const objectsDir = join(repo, ".git", "objects");
    mkdirSync(join(objectsDir, "pack"), { recursive: true });
    writeFileSync(join(objectsDir, "pack", "pack-0123.pack"), "x");
    writeFileSync(join(objectsDir, "info", "packs"), "x");
    writeFileSync(join(objectsDir, "tmp_obj_AbC123"), "x");
    mkdirSync(join(objectsDir, "ab"), { recursive: true });
    writeFileSync(join(objectsDir, "ab", "tmp_obj_XyZ789"), "x"); // git's own placement (create_tmpfile)
    expect(readdirSync(objectsDir)).toContain("pack");
    const ids: string[] = [];
    for await (const id of gitObjects(repoStore(repo)).list()) ids.push(id);
    expect(ids.sort()).toEqual(
      corpus
        .slice(0, 5)
        .map((o) => o.id)
        .sort(),
    );
  });
});

/** Incompressible bytes, so nothing downstream can hide buffering behind a tiny deflate output. */
function prng(seed: number) {
  let x = seed >>> 0 || 1;
  return (chunk: Uint8Array) => {
    const w = new Uint32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >>> 2);
    for (let i = 0; i < w.length; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      w[i] = x >>> 0;
    }
    return chunk;
  };
}
const mem = () => {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};
const gc = () => (globalThis as { gc?: () => void }).gc?.();
/** Samples heap + array buffers every 5 ms and once more when `run` resolves. */
/** Full GC, then a pause so ArrayBuffer backing stores freed by earlier tests are really released. */
async function settle() {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 50));
  }
}
async function peakDuring<T>(run: () => Promise<T>): Promise<{ result: T; peak: number }> {
  await settle();
  const base = mem();
  let peak = 0;
  const timer = setInterval(() => {
    peak = Math.max(peak, mem() - base);
  }, 5);
  try {
    const result = await run();
    peak = Math.max(peak, mem() - base);
    return { result, peak };
  } finally {
    clearInterval(timer);
  }
}
function randomSource(mb: number, counters: { passes: number; pulled: number }) {
  return {
    async *[Symbol.asyncIterator]() {
      counters.passes++;
      const fill = prng(12345);
      for (let i = 0; i < mb; i++) {
        const c = fill(new Uint8Array(1 << 20));
        counters.pulled += c.length;
        yield c;
      }
    },
  };
}
const MiB = 2 ** 20;

describe("R4 one pass over a large blob", () => {
  const MB = Number(process.env.X4_BIG_MB ?? 500);
  it(`put("blob", ${MB} MB of incompressible data) reads the source once, memory grows < 64 MB, git agrees`, async () => {
    const repo = newRepo();
    const objs = gitObjects(filesStagingStore(new StreamingNodeFilesApi(repo), "/.git/objects"));
    const counters = { passes: 0, pulled: 0 };
    const t0 = performance.now();
    const { result: id, peak } = await peakDuring(() =>
      objs.put("blob", MB * MiB, randomSource(MB, counters)),
    );
    const ms = performance.now() - t0;
    console.log(
      `R4 ${MB} MB incompressible: ${ms.toFixed(0)} ms (${((MB / ms) * 1000).toFixed(0)} MB/s), heap+arrayBuffers peak +${(peak / MiB).toFixed(1)} MB`,
    );
    expect(counters.passes).toBe(1);
    expect(counters.pulled).toBe(MB * MiB);
    expect(peak).toBeLessThan(64 * MiB);
    expect(git(repo, ["cat-file", "-s", id]).toString().trim()).toBe(String(MB * MiB));
    const f = fsck(repo);
    expect(f.status, f.output).toBe(0);
    expect(f.output).not.toMatch(/error|warning|mismatch|corrupt|garbage/i); // only "notice: unborn HEAD"
    expect(
      readdirSync(join(repo, ".git", "objects")).filter((n) => n.startsWith("tmp_obj_")),
    ).toEqual([]);
  }, 600_000);
  it("trap: webrun-files-node's NodeFilesApi.write collects the whole file before writing", async () => {
    const MBT = 160;
    const repo = newRepo();
    const objs = gitObjects(repoStore(repo)); // the published NodeFilesApi
    const { peak } = await peakDuring(() =>
      objs.put("blob", MBT * MiB, randomSource(MBT, { passes: 0, pulled: 0 })),
    );
    console.log(
      `trap: NodeFilesApi, ${MBT} MB incompressible: peak +${(peak / MiB).toFixed(0)} MB`,
    );
    // A streaming write stays under the R4 bound (64 MB); this one holds a large share of the file.
    expect(peak).toBeGreaterThan(MBT * MiB * 0.5);
  }, 300_000);
  it("reading a 256 MB object retains < 16 MB while its first content chunk is held (SqliteFilesApi, 1 MiB blocks)", async () => {
    const fs = new SqliteFilesApi(await newNodeSqliteDb(), { compression: null });
    await fs.init();
    const objs = gitObjects(filesStagingStore(fs, "/objects"));
    const size = 256 * MiB;
    const zeros = new Uint8Array(MiB);
    const id = await objs.put(
      "blob",
      size,
      (async function* () {
        for (let i = 0; i < 256; i++) yield zeros;
      })(),
    );
    await settle();
    const base = mem();
    const g = await objs.get(id);
    const it = g?.content[Symbol.asyncIterator]();
    const first = await it?.next();
    await settle(); // what the open read retains while the caller holds the first chunk
    const retained = mem() - base;
    console.log(`R4b first chunk of a 256 MB object: retained +${(retained / MiB).toFixed(1)} MB`);
    expect(first?.done).toBe(false);
    expect(retained).toBeLessThan(16 * MiB);
    await it?.return?.(undefined);
  }, 120_000);
});

describe("R5 an existing object is kept", () => {
  it("putting an object git already wrote (core.compression=0) leaves git's file byte-for-byte", async () => {
    const repo = newRepo();
    const o = corpus.find((x) => x.type === "blob" && body(x.raw).length > 1000) ?? corpus[0];
    if (!o) throw new Error("no corpus");
    git(repo, ["-c", "core.compression=0", "hash-object", "-w", "--stdin"], body(o.raw));
    const file = join(repo, ".git", "objects", o.id.slice(0, 2), o.id.slice(2));
    const before = readFileSync(file);
    const id = await gitObjects(repoStore(repo)).put(
      "blob",
      body(o.raw).length,
      [body(o.raw)].values() as never,
    );
    expect(id).toBe(o.id);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});

describe("temporaries left by a crash", () => {
  it("sweepStaged removes tmp_obj_* older than the given age, at the top level and in fan-out directories", async () => {
    const repo = newRepo();
    const objectsDir = join(repo, ".git", "objects");
    mkdirSync(join(objectsDir, "ab"), { recursive: true });
    const old = [join(objectsDir, "tmp_obj_old1"), join(objectsDir, "ab", "tmp_obj_old2")];
    const fresh = join(objectsDir, "tmp_obj_new");
    for (const f of [...old, fresh]) writeFileSync(f, "partial");
    const past = new Date(Date.now() - 3 * 3600_000);
    for (const f of old) utimesSync(f, past, past);
    const store = repoStore(repo);
    expect(await store.sweepStaged?.(3600_000)).toBe(2);
    expect(readdirSync(objectsDir)).toContain("tmp_obj_new");
    expect(readdirSync(objectsDir)).not.toContain("tmp_obj_old1");
    expect(readdirSync(join(objectsDir, "ab"))).toEqual([]);
  });
});

describe("R6 Durable Object on workerd (SqliteFilesApi on ctx.storage.sql)", () => {
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
      durableObjects: { OBJECTS: { className: "ObjectsDo", useSQLite: true } },
    });
  }, 120_000);
  afterAll(async () => {
    await mf?.dispose();
  });
  it("R1/R3/R5 contract inside the Durable Object", async () => {
    const r = (await (await mf.dispatchFetch("http://x/contract", { method: "POST" })).json()) as {
      cases: number;
      failed: string[];
    };
    expect(r.cases).toBe(CASES);
    expect(r.failed).toEqual([]);
  });
});
