import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newNodeSqliteDb } from "@statewalker/db-sqlite-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { rng } from "../../29-merge/tests/tree-harness.js";
import { fossilIndex, indexedSqlRepository, walkPathHistory, walkSearch } from "../src/fossil.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
let clock = 1_600_000_000;
const git = (cwd: string, args: string[], input?: string | Buffer) => {
  clock += 61; // distinct committer dates: the order is by date alone
  return execFileSync("git", args, {
    cwd,
    input,
    maxBuffer: 1 << 30,
    env: { ...gitEnv, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();
};
const write = (d: string, p: string, c: string) => {
  mkdirSync(dirname(join(d, p)), { recursive: true });
  writeFileSync(join(d, p), c);
};
const WORDS = ["merge", "fix", "Rename", "walk", "index", "Speed", "tree", "base"];

/** random histories: branches, merges, adds, edits, deletes, a file becoming a directory */
function history(seed: number): string {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const d = tmp("x9-");
  git(d, ["init", "-q", "-b", "main"]);
  const paths = ["a", "b", "d/e", "d/f", "d/g/h", "x"];
  for (const p of paths.slice(0, 4)) write(d, p, `${p}\n`);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "base commit"]);
  let n = 0;
  const work = (k: number) => {
    for (let i = 0; i < k; i++) {
      const p = pick(paths);
      const full = join(d, p);
      const r = rand();
      try {
        if (r < 0.6) write(d, p, `${p} ${n++}\n`);
        else if (r < 0.75) rmSync(full, { recursive: true, force: true });
        else if (r < 0.85) {
          rmSync(full, { recursive: true, force: true });
          write(d, `${p}/inner`, `inner ${n++}\n`);
        } else write(d, `${p}.${n++}`, "new\n");
      } catch {}
      git(d, ["add", "-A"]);
      const msg = `${pick(WORDS)} ${p} ${n}\n\n${pick(WORDS).toLowerCase()} body line ${n}`;
      git(d, ["commit", "-q", "--allow-empty", "-m", msg]);
    }
  };
  work(2 + Math.floor(rand() * 3));
  git(d, ["checkout", "-qb", "side"]);
  work(1 + Math.floor(rand() * 4));
  git(d, ["checkout", "-q", "main"]);
  work(1 + Math.floor(rand() * 3));
  if (rand() < 0.6) {
    try {
      git(d, ["merge", "-q", "--no-edit", "side"]);
    } catch {
      git(d, ["add", "-A"]);
      git(d, ["commit", "-qm", "merge side by hand"]);
    }
    work(Math.floor(rand() * 3));
  }
  if (rand() < 0.5) {
    git(d, ["checkout", "-qb", "topic", "HEAD~1"]);
    work(1 + Math.floor(rand() * 2));
  }
  return d;
}

/** every path and directory any commit's tree has had, plus one never present */
function allPaths(d: string): string[] {
  const out = new Set<string>(["never/there"]);
  for (const c of git(d, ["rev-list", "--all"]).split("\n").filter(Boolean))
    for (const p of git(d, ["ls-tree", "-r", "--name-only", c]).split("\n").filter(Boolean)) {
      out.add(p);
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
    }
  return [...out].sort();
}

/** the history's objects and refs in a SQL repository with the index: one pack, one ref batch */
async function loadSql(d: string) {
  const db = await newNodeSqliteDb();
  const { repo, index } = await indexedSqlRepository(db);
  const pack = execFileSync("git", ["pack-objects", "--all", "--stdout", "-q"], {
    cwd: d,
    input: "",
    maxBuffer: 1 << 30,
  });
  await repo.objects.installPack(
    (async function* () {
      yield new Uint8Array(pack);
    })(),
  );
  const refs = git(d, ["for-each-ref", "--format=%(refname) %(objectname)"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ") as [string, string]);
  const r = await repo.refs.batch(refs.map(([name, oid]) => ({ name, old: null, new: oid })));
  expect(r.ok).toBe(true);
  return { db, repo, index, refs };
}
const lines = (s: string) => s.split("\n").filter(Boolean);

const SEEDS = Array.from({ length: Number(process.env.X9_SEEDS ?? 40) }, (_, i) => 900 + i);

describe("F1 path history equals git log --all --full-history --no-merges -- <path>", () => {
  it("40 random histories, every path and directory, indexed and walked", async () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const seed of SEEDS) {
      const d = history(seed);
      const { repo, index } = await loadSql(d);
      for (const path of allPaths(d)) {
        const want = lines(
          git(d, ["log", "--all", "--full-history", "--no-merges", "--format=%H", "--", path]),
        );
        const indexed = await index.pathHistory(path);
        const walked = await walkPathHistory(repo, path);
        checked++;
        if (JSON.stringify(indexed) !== JSON.stringify(want))
          wrong.push(`${seed} ${path} indexed\n git:  ${want}\n ours: ${indexed}`);
        if (JSON.stringify(walked) !== JSON.stringify(want))
          wrong.push(`${seed} ${path} walked\n git:  ${want}\n ours: ${walked}`);
      }
    }
    expect(wrong.slice(0, 3)).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  }, 600_000);
});

describe("F2 search equals git log --all --no-merges -F --grep=<text>", () => {
  it("40 random histories: words, phrases, short and long substrings, absent text", async () => {
    const wrong: string[] = [];
    for (const seed of SEEDS) {
      const d = history(seed);
      const { repo, index } = await loadSql(d);
      const queries = [
        ...WORDS,
        "me",
        "x",
        "fix d",
        "body line",
        "rename",
        "nowhere at all",
        "line 1",
      ];
      for (const q of queries) {
        const want = lines(
          git(d, ["log", "--all", "--no-merges", "--format=%H", "-F", `--grep=${q}`]),
        );
        const indexed = await index.searchMessages(q);
        const walked = await walkSearch(repo, q);
        if (JSON.stringify(indexed) !== JSON.stringify(want))
          wrong.push(`${seed} "${q}" indexed\n git:  ${want}\n ours: ${indexed}`);
        if (JSON.stringify(walked) !== JSON.stringify(want))
          wrong.push(`${seed} "${q}" walked\n git:  ${want}\n ours: ${walked}`);
      }
    }
    expect(wrong.slice(0, 3)).toEqual([]);
  }, 600_000);
});

describe("F3 index rows in the ref batch's transaction", () => {
  const count = async (db: Awaited<ReturnType<typeof newNodeSqliteDb>>) =>
    Number(((await db.query("SELECT count(*) AS n FROM fossil_commit")) as { n: number }[])[0]?.n);

  it("a failing indexer leaves neither the ref nor any index row", async () => {
    const d = history(901);
    const db = await newNodeSqliteDb();
    const { repo } = await indexedSqlRepository(db, { failAfter: 2 });
    const pack = execFileSync("git", ["pack-objects", "--all", "--stdout", "-q"], {
      cwd: d,
      input: "",
    });
    await repo.objects.installPack(
      (async function* () {
        yield new Uint8Array(pack);
      })(),
    );
    const tip = git(d, ["rev-parse", "main"]).trim();
    await expect(
      repo.refs.batch([{ name: "refs/heads/main", old: null, new: tip }]),
    ).rejects.toThrow();
    expect(await repo.refs.resolve("refs/heads/main")).toBeUndefined();
    expect(await count(db)).toBe(0);
  });

  it("a rejected batch writes no index row; a commit reached twice is indexed once", async () => {
    const d = history(902);
    const { db, repo, refs } = await loadSql(d);
    const before = await count(db);
    expect(before).toBe(Number(git(d, ["rev-list", "--all", "--count"]).trim()));
    const [name, oid] = refs[0] as [string, string];
    // a mismatched old value: rejected
    const r = await repo.refs.batch([{ name: "refs/heads/other", old: oid, new: oid }]);
    expect(r.ok).toBe(false);
    // the same commits under another name: nothing new to index
    expect((await repo.refs.batch([{ name: `${name}-copy`, old: null, new: oid }])).ok).toBe(true);
    expect(await count(db)).toBe(before);
  });
});

describe("F4 speed: 100,000 commits over 50,000 files", () => {
  it("a path history and a search each under 100 ms", async () => {
    const d = tmp("x9big-");
    git(d, ["init", "-q", "-b", "main"]);
    // fast-import: 50 x 50 x 20 files, then 100,000 commits editing one file each
    const rand = rng(77);
    const file = (i: number) => `d${Math.floor(i / 1000)}/e${Math.floor(i / 20) % 50}/f${i % 20}`;
    const parts: string[] = [];
    let t = 1_500_000_000;
    // each commit continues the branch: fast-import starts from its current tip
    const commit = (msg: string, ops: string) =>
      `commit refs/heads/main\ncommitter C <c@x> ${t++} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${ops}\n`;
    let ops = "";
    for (let i = 0; i < 50_000; i++) ops += `M 100644 inline ${file(i)}\ndata 2\n${i % 10}\n\n`;
    parts.push(commit("import the tree", ops));
    for (let c = 1; c < 100_000; c++) {
      const i = Math.floor(rand() * 50_000);
      const word = WORDS[c % WORDS.length] as string;
      const body = `v${c}\n`;
      parts.push(
        commit(
          `${word} ${file(i)} change ${c}`,
          `M 100644 inline ${file(i)}\ndata ${body.length}\n${body}`,
        ),
      );
    }
    git(d, ["fast-import", "--quiet"], parts.join(""));
    const repo = await filesRepository(
      new StreamingNodeFilesApi(join(d, ".git")),
      nodeRefFiles(join(d, ".git")),
    );
    const db = await newNodeSqliteDb();
    const index = await fossilIndex(db, repo.objects);
    const tip = git(d, ["rev-parse", "main"]).trim();
    await index.indexCommits(db, [tip]);

    const target = file(12_345);
    let t0 = performance.now();
    const history = await index.pathHistory(target);
    const pathMs = performance.now() - t0;
    expect(history).toEqual(lines(git(d, ["log", "--format=%H", "--", target])));

    t0 = performance.now();
    const dirHistory = await index.pathHistory("d12/e3");
    const dirMs = performance.now() - t0;
    expect(dirHistory.length).toBe(lines(git(d, ["log", "--format=%H", "--", "d12/e3"])).length);

    t0 = performance.now();
    const found = await index.searchMessages("Rename d7/e1");
    const searchMs = performance.now() - t0;
    expect(found).toEqual(lines(git(d, ["log", "--format=%H", "-F", "--grep=Rename d7/e1"])));

    console.log(
      `path ${pathMs.toFixed(1)} ms, directory ${dirMs.toFixed(1)} ms, search ${searchMs.toFixed(1)} ms`,
    );
    expect(pathMs).toBeLessThan(100);
    expect(dirMs).toBeLessThan(100);
    expect(searchMs).toBeLessThan(100);
  }, 1_800_000);
});

describe("F5 portable", () => {
  it("src/ has no node: imports", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const f of readdirSync(src))
      expect(readFileSync(join(src, f), "utf8"), f).not.toMatch(/from "node:/);
  });
});
