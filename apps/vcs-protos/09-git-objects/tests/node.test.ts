import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { collect, runObjectContract } from "../src/object-contract.js";
import { filesStagingStore, withStaging } from "../src/staging.js";

const corpus = decodeCorpus(json);
const CASES = 13;
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
    // Exit status 0: fsck re-inflates and re-hashes every loose object. Its warnings about the
    // deliberately exotic objects (zero-padded modes, missing tagger) do not fail it.
    git(repo, ["fsck", "--full", "--no-dangling"]);
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

describe("R4 one pass over a large blob", () => {
  const MB = Number(process.env.X4_BIG_MB ?? 500);
  it(`put("blob", ${MB} MB) reads the source once, heap grows < 64 MB, git agrees`, async () => {
    const repo = newRepo();
    const objs = gitObjects(repoStore(repo));
    const CHUNK = 1 << 20;
    const size = MB * CHUNK;
    let pulled = 0;
    let passes = 0;
    let peak = 0;
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const base = process.memoryUsage().heapUsed;
    const source = {
      async *[Symbol.asyncIterator]() {
        passes++;
        for (let i = 0; i < MB; i++) {
          const c = new Uint8Array(CHUNK);
          for (let j = 0; j < CHUNK; j += 4096) c[j] = (i * 31 + j) & 255;
          pulled += c.length;
          if (i % 32 === 0) {
            gc?.();
            peak = Math.max(peak, process.memoryUsage().heapUsed - base);
          }
          yield c;
        }
      },
    };
    const t0 = performance.now();
    const id = await objs.put("blob", size, source);
    const ms = performance.now() - t0;
    console.log(
      `R4 ${MB} MB: ${ms.toFixed(0)} ms (${((MB / ms) * 1000).toFixed(0)} MB/s), heap peak +${(peak / 2 ** 20).toFixed(1)} MB`,
    );
    expect(passes).toBe(1);
    expect(pulled).toBe(size);
    expect(peak).toBeLessThan(64 * 2 ** 20);
    expect(git(repo, ["cat-file", "-s", id]).toString().trim()).toBe(String(size));
    git(repo, ["fsck", "--full", "--no-dangling"]);
    expect(
      readdirSync(join(repo, ".git", "objects")).filter((n) => n.startsWith("tmp_obj_")),
    ).toEqual([]);
  }, 300_000);
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
