import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, noise, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { exportPack, listObjects, writePack } from "../src/export.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "x6c-"));
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
const revList = (dir: string, args: string[]) =>
  git(dir, ["rev-list", "--objects", ...args])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40))
    .sort();
/** A fresh repository holding `pack` (native git), `ref` pointing at `head`. */
function receiveNative(pack: Uint8Array, head: string, into = tmp()) {
  if (!git(into, ["rev-parse", "--git-dir"]).toString()) throw new Error("not a repo");
  git(into, ["index-pack", "--stdin", "--fix-thin"], pack);
  git(into, ["update-ref", "refs/heads/main", head]);
  git(into, ["fsck", "--full", "--strict"]);
  return into;
}
const emptyRepo = () => {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main", "."]);
  return d;
};

describe("R1 a full export is git's object set and git accepts it", () => {
  it("wants = HEAD, no haves", async () => {
    const src = repoWithHistory(20);
    git(src, ["gc", "-q"]); // packed and loose mixed later
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const list = await listObjects(repo, [head], []);
    expect(list.map((o) => o.oid).sort()).toEqual(revList(src, ["HEAD"]));
    const pack = await collect(exportPack(repo, [head], []));
    const dst = receiveNative(pack, head, emptyRepo());
    expect(git(dst, ["log", "--format=%H", "main"]).toString()).toBe(
      git(src, ["log", "--format=%H", "HEAD"]).toString(),
    );
  });
});

describe("R2 incremental exports", () => {
  it("wants = HEAD, haves = HEAD~5: git's set; a receiver holding HEAD~5 installs it (git and X6b)", async () => {
    const src = repoWithHistory(20);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const have = git(src, ["rev-parse", "HEAD~5"]).toString().trim();
    const list = await listObjects(repo, [head], [have]);
    expect(list.map((o) => o.oid).sort()).toEqual(revList(src, ["HEAD", "^HEAD~5"]));
    const pack = await collect(exportPack(repo, [head], [have]));
    // a native receiver that has HEAD~5
    const dst = emptyRepo();
    git(
      dst,
      ["index-pack", "--stdin"],
      git(src, ["pack-objects", "--stdout", "-q"], git(src, ["rev-list", "--objects", "HEAD~5"])),
    );
    receiveNative(pack, head, dst);
    // X6b over the files backend
    const dst2 = emptyRepo();
    git(
      dst2,
      ["index-pack", "--stdin"],
      git(src, ["pack-objects", "--stdout", "-q"], git(src, ["rev-list", "--objects", "HEAD~5"])),
    );
    const repo2 = await open(dst2);
    await repo2.objects.installPack(chunks(pack));
    await repo2.refs.batch([{ name: "refs/heads/main", new: head }]);
    git(dst2, ["fsck", "--full"]);
    expect(await log(repo2, "refs/heads/main")).toEqual(await log(repo, head));
  });
  it("a side branch forked below the have and merged above it: its old ancestry is excluded", async () => {
    const src = repoWithHistory(20);
    const have = git(src, ["rev-parse", "HEAD~2"]).toString().trim();
    git(src, ["checkout", "-q", "-b", "side", "HEAD~8"]);
    writeFileSync(join(src, "side.txt"), "side\n");
    git(src, ["add", "side.txt"]);
    git(src, ["commit", "-q", "-m", "side"]);
    git(src, ["checkout", "-q", "main"]);
    git(src, ["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const list = await listObjects(repo, [head], [have]);
    expect(list.map((o) => o.oid).sort()).toEqual(revList(src, ["HEAD", `^${have}`]));
  });
  it("an annotated tag among the wants is sent with what it points at", async () => {
    const src = repoWithHistory(6);
    git(src, ["tag", "-a", "v1", "-m", "release", "HEAD~1"]);
    const tag = git(src, ["rev-parse", "v1"]).toString().trim();
    const repo = await open(src);
    const list = await listObjects(repo, [tag], []);
    expect(list.map((o) => o.oid).sort()).toEqual(revList(src, ["v1"]));
    expect(list.find((o) => o.oid === tag)?.type).toBe("tag");
  });
});

describe("R3 SQL backend to SQL backend", () => {
  it("a received history exported and received again: equal logs", async () => {
    const src = repoWithHistory(15);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const a = await sqlRepository(await newNodeSqliteDb());
    await a.objects.installPack(chunks(packAll(src, true)));
    const b = await sqlRepository(await newNodeSqliteDb());
    await b.objects.installPack(exportPack(a, [head], []));
    expect(await log(b, head)).toEqual(await log(a, head));
  });
});

describe("R4 streaming", () => {
  it("a 64 MiB blob is exported with < 16 MiB extra live", async () => {
    const d = emptyRepo();
    writeFileSync(join(d, "big.bin"), noise(64 * 2 ** 20, 3));
    git(d, ["add", "big.bin"]);
    git(d, ["commit", "-q", "-m", "big"]);
    git(d, ["gc", "-q"]); // the blob in a pack (not a delta)
    const repo = await open(d);
    const head = git(d, ["rev-parse", "HEAD"]).toString().trim();
    const gc = () => (globalThis as { gc?: () => void }).gc?.();
    const live = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    gc();
    gc();
    const base = live();
    let peak = 0;
    let n = 0;
    let bytes = 0;
    for await (const c of exportPack(repo, [head], [])) {
      bytes += c.length;
      if (++n % 64 === 0) {
        gc();
        gc();
        peak = Math.max(peak, live() - base);
      }
    }
    console.log(`R4: ${bytes} B exported, peak +${(peak / 2 ** 20).toFixed(1)} MiB`);
    expect(bytes).toBeGreaterThan(64 * 2 ** 20);
    expect(peak).toBeLessThan(16 * 2 ** 20);
  }, 300_000);
});

/** Counts objects opened and their streams released. */
function spied(repo: Repository) {
  const s = { opened: 0, released: 0 };
  const get = repo.objects.get.bind(repo.objects);
  repo.objects.get = async (oid, o) => {
    const r = await get(oid, o);
    if (!r) return r;
    s.opened++;
    const content = r.content;
    return {
      ...r,
      content: {
        [Symbol.asyncIterator]() {
          const it = content[Symbol.asyncIterator]();
          let done = false;
          const finish = () => {
            if (!done) s.released++;
            done = true;
          };
          return {
            async next() {
              const x = await it.next();
              if (x.done) finish();
              return x;
            },
            async return() {
              finish();
              return (await it.return?.()) ?? { done: true, value: undefined };
            },
          };
        },
      },
    };
  };
  return s;
}

describe("R5 backpressure and cancel", () => {
  it("the producer reads at most one object ahead of the consumer", async () => {
    const src = repoWithHistory(10);
    const repo = await open(src);
    const s = spied(repo);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const list = await listObjects(repo, [head], []);
    s.opened = 0; // count what writing opens, not the walk
    s.released = 0;
    const it = writePack(repo, list)[Symbol.asyncIterator]();
    await it.next(); // the header
    await new Promise((r) => setTimeout(r, 50));
    expect(s.opened).toBeLessThanOrEqual(1);
    for (let k = 0; k < 5; k++) await it.next();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.opened).toBeLessThanOrEqual(6);
    await it.return?.(undefined);
    expect(s.released).toBe(s.opened);
  });
  it("an AbortSignal stops the export within one object; streams released", async () => {
    const src = repoWithHistory(10);
    const repo = await open(src);
    const s = spied(repo);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const ac = new AbortController();
    const list = await listObjects(repo, [head], []);
    s.opened = 0; // count what writing opens, not the walk
    s.released = 0;
    let chunksSeen = 0;
    let openedAtAbort = 0;
    const err = await (async () => {
      for await (const _ of writePack(repo, list, { signal: ac.signal })) {
        if (++chunksSeen === 10) {
          ac.abort();
          openedAtAbort = s.opened;
        }
      }
    })().catch((e) => e);
    expect(err?.name).toBe("AbortError");
    expect(s.opened).toBe(openedAtAbort); // nothing opened after the abort
    expect(s.opened).toBeLessThan(list.length);
    expect(s.released).toBe(s.opened);
  });
});

describe("R6 size next to git pack-objects", () => {
  it("measured and recorded", async () => {
    const src = repoWithHistory(60);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const ours = await collect(exportPack(repo, [head], []));
    const theirs = packAll(src, true);
    console.log(
      `R6: ours ${ours.length} B (whole objects), git ${theirs.length} B (deltas): ${(ours.length / theirs.length).toFixed(1)}×`,
    );
    expect(ours.length).toBeGreaterThan(0);
  });
});

describe("R7 export inside a Durable Object", () => {
  it("the fixture history exported from the SQL backend is accepted by native git", async () => {
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
    const mf = new Miniflare({
      modules: true,
      script: out.outputFiles[0]?.text ?? "",
      compatibilityDate: "2026-07-01",
      durableObjects: { REPO: { className: "ExportDo", useSQLite: true } },
    });
    try {
      const res = await mf.dispatchFetch("http://x/export", { method: "POST" });
      const head = res.headers.get("x-head") as string;
      expect(res.headers.get("x-error")).toBeNull();
      const pack = new Uint8Array(await res.arrayBuffer());
      const dst = receiveNative(pack, head, emptyRepo());
      expect(git(dst, ["rev-list", "--count", "main"]).toString().trim()).toBe("40");
    } finally {
      await mf.dispose();
    }
  }, 300_000);
});
