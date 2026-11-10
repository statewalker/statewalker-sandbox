import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { git, gitEnv, noise, packAll, repoWithHistory } from "../../12-index-pack/src/git-repo.js";
import { log } from "../../17-repository/src/commands.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository, sqlRepository } from "../../17-repository/src/repository.js";
import { exportPack, listObjects, listObjectsWithEdges, writePack } from "../src/export.js";

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
const execMkdir = (p: string) => mkdirSync(p, { recursive: true });
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

/** Review of #73: git's sets across shapes, non-commit haves, explicit shallow, a limited walk. */
describe("review cases (#73)", () => {
  const revListArgs = (dir: string, args: string[]) =>
    git(dir, ["rev-list", ...args])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(0, 40))
      .sort();
  /** A random history: branches, merges (criss-cross too), files shared and edited across branches. */
  function randomRepo(seed: number) {
    let x = seed;
    const rnd = (n: number) => {
      x = (x * 1103515245 + 12345) >>> 0;
      return x % n;
    };
    const d = emptyRepo();
    const commitOn = (msg: string) => {
      for (let k = 0; k < 3; k++) writeFileSync(join(d, `f${rnd(6)}.txt`), `${msg} ${rnd(1000)}\n`);
      const sub = join(d, "x", "y");
      if (rnd(3) === 0) {
        execMkdir(sub);
        writeFileSync(join(sub, `g${rnd(3)}.txt`), `${msg}\n`);
      }
      git(d, ["add", "-A"]);
      git(d, ["commit", "-q", "-m", msg]);
    };
    commitOn("root");
    const branches = ["main"];
    for (let i = 0; i < 18; i++) {
      const r = rnd(10);
      if (r < 2 && branches.length < 4) {
        const name = `b${i}`;
        git(d, ["checkout", "-q", "-b", name]);
        branches.push(name);
      } else if (r < 4 && branches.length > 1) {
        const other = branches[rnd(branches.length)] as string;
        const cur = git(d, ["rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
        if (other !== cur)
          git(d, ["merge", "-q", "--no-ff", "-X", "theirs", "-m", `merge ${other}`, other]);
      } else if (r < 5) {
        git(d, ["checkout", "-q", branches[rnd(branches.length)] as string]);
      }
      commitOn(`c${i}`);
    }
    const commits = git(d, ["rev-list", "--all"]).toString().trim().split("\n");
    return { d, commits, rnd };
  }
  it("random histories: exactly git's --objects-edge-aggressive set; never more than rev-list, never missing what the haves lack", async () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { d, commits, rnd } = randomRepo(seed);
      const repo = await open(d);
      for (let q = 0; q < 6; q++) {
        const wants = [commits[rnd(commits.length)] as string];
        const haves = [commits[rnd(commits.length)] as string];
        const ours = (await listObjects(repo, wants, haves)).map((o) => o.oid).sort();
        const args = [...wants, ...haves.map((h) => `^${h}`)];
        const plain = revListArgs(d, ["--objects", ...args]);
        const wantClosure = new Set(revListArgs(d, ["--objects", ...wants]));
        const haveClosure = new Set(revListArgs(d, ["--objects", ...haves]));
        const label = `seed ${seed} want ${wants[0]?.slice(0, 7)} have ${haves[0]?.slice(0, 7)}`;
        for (const o of ours) expect(plain, label).toContain(o);
        for (const o of wantClosure) if (!haveClosure.has(o)) expect(ours, label).toContain(o);
        // the want is not below the have (git's aggressive mode marks such a want's tree too)
        const wantBelowHave = revListArgs(d, [...haves]).includes(wants[0] as string);
        if (!wantBelowHave)
          expect(ours, label).toEqual(
            revListArgs(d, ["--objects-edge-aggressive", ...args]).filter(
              (l) => !l.startsWith("-"),
            ),
          );
      }
    }
  }, 300_000);
  it("trees, blobs and tags are honoured as haves", async () => {
    const src = repoWithHistory(6);
    git(src, ["tag", "-a", "t", "-m", "t", "HEAD^{tree}"]);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    for (const have of ["HEAD^{tree}", "HEAD:file0.txt", "t"]) {
      const id = git(src, ["rev-parse", have]).toString().trim();
      const ours = (await listObjects(repo, [head], [id])).map((o) => o.oid).sort();
      expect(ours, have).toEqual(revListArgs(src, ["--objects", "HEAD", `^${id}`]));
    }
    const tag = git(src, ["rev-parse", "t"]).toString().trim();
    expect(await listObjects(repo, [tag], [tag])).toEqual([]);
  });
  it("a missing object fails the export unless it is below a declared shallow commit", async () => {
    const src = repoWithHistory(8);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const gone = git(src, ["rev-parse", "HEAD~3"]).toString().trim();
    rmSync(join(src, ".git", "objects", gone.slice(0, 2), gone.slice(2)));
    await expect(listObjects(repo, [head], [])).rejects.toThrow(/missing|not in/);
    const shallow = git(src, ["rev-parse", "HEAD~2"]).toString().trim();
    const ok = await listObjects(repo, [head], [], { shallow: [shallow] });
    expect(ok.filter((o) => o.type === "commit").length).toBe(3);
  });
  it("an incremental export reads only what it needs, not the whole history", async () => {
    const d = emptyRepo();
    writeFileSync(join(d, "f.txt"), "v0\n");
    git(d, ["add", "-A"]);
    git(d, ["commit", "-q", "-m", "c0"]);
    for (let i = 1; i < 400; i++) {
      writeFileSync(join(d, "f.txt"), `v${i}\n`);
      // distinct dates, as real histories have (equal dates make the walk go on: see above)
      const date = `${1700000000 + i * 60} +0000`;
      execFileSync("git", ["commit", "-q", "-am", `c${i}`], {
        cwd: d,
        env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    }
    const repo = await open(d);
    let gets = 0;
    const get = repo.objects.get.bind(repo.objects);
    repo.objects.get = (oid, o) => {
      gets++;
      return get(oid, o);
    };
    const head = git(d, ["rev-parse", "HEAD"]).toString().trim();
    const have = git(d, ["rev-parse", "HEAD~1"]).toString().trim();
    const list = await listObjects(repo, [head], [have]);
    expect(list.map((o) => o.oid).sort()).toEqual(revListArgs(d, ["--objects", "HEAD", "^HEAD~1"]));
    expect(gets).toBeLessThan(50);
  }, 300_000);
  it("an abort during the walk stops it", async () => {
    const src = repoWithHistory(20);
    const repo = await open(src);
    const ac = new AbortController();
    let gets = 0;
    const get = repo.objects.get.bind(repo.objects);
    repo.objects.get = (oid, o) => {
      if (++gets === 10) ac.abort();
      return get(oid, o);
    };
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const err = await listObjects(repo, [head], [], { signal: ac.signal }).catch((e) => e);
    expect(err?.name).toBe("AbortError");
    expect(gets).toBeLessThan(15);
  });
  it("streaming, not buffering: stopping after the first data chunk of an 8 MiB object read ≤ 2 MiB of it", async () => {
    for (const kind of ["files", "sql"] as const) {
      const d = emptyRepo();
      writeFileSync(join(d, "big.bin"), noise(8 * 2 ** 20, 9));
      git(d, ["add", "big.bin"]);
      git(d, ["commit", "-q", "-m", "big"]);
      git(d, ["gc", "-q"]);
      let repo = await open(d);
      if (kind === "sql") {
        const sql = await sqlRepository(await newNodeSqliteDb());
        await sql.objects.installPack(chunks(packAll(d, true)));
        repo = sql;
      }
      const blob = git(d, ["rev-parse", "HEAD:big.bin"]).toString().trim();
      let read = 0;
      const get = repo.objects.get.bind(repo.objects);
      repo.objects.get = async (oid, o) => {
        const r = await get(oid, o);
        if (!r || oid !== blob) return r;
        const content = r.content;
        return {
          ...r,
          content: (async function* () {
            for await (const c of content) {
              read += c.length;
              yield c;
            }
          })(),
        };
      };
      const it = writePack(repo, [{ oid: blob, type: "blob" }])[Symbol.asyncIterator]();
      await it.next(); // pack header
      await it.next(); // entry header
      await it.next(); // first deflated bytes
      await it.return?.(undefined);
      expect(read, kind).toBeLessThanOrEqual(2 * 2 ** 20);
      expect(read, kind).toBeGreaterThan(0);
    }
  }, 300_000);
  it("the list carries paths and the walk's edges (for delta search and thin packs)", async () => {
    const src = repoWithHistory(8);
    const repo = await open(src);
    const head = git(src, ["rev-parse", "HEAD"]).toString().trim();
    const have = git(src, ["rev-parse", "HEAD~3"]).toString().trim();
    const { objects, edges } = await listObjectsWithEdges(repo, [head], [have]);
    expect(edges).toEqual([have]);
    const named = git(src, ["rev-list", "--objects", "HEAD", "^HEAD~3"])
      .toString()
      .trim()
      .split("\n");
    for (const line of named) {
      const [oid, path] = [line.slice(0, 40), line.slice(41)];
      if (path) expect(objects.find((o) => o.oid === oid)?.path, oid).toBe(path);
    }
  });
});
