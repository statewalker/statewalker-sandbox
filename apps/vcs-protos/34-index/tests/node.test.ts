import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { rng } from "../../29-merge/tests/tree-harness.js";
import { type IndexFile, parseIndex, serializeIndex } from "../src/index-file.js";
import { nodeReadLink, nodeStat } from "../src/node-stat.js";
import { addAll, smudgeRacy, status, type Worktree } from "../src/worktree.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, env: gitEnv, input }).toString();
const write = (d: string, path: string, content: string) => {
  mkdirSync(dirname(join(d, path)), { recursive: true });
  writeFileSync(join(d, path), content);
};
/** a non-bare repository with core.fileMode=false and one commit */
function initRepo(files: Record<string, string>): string {
  const d = tmp("x14-");
  git(d, ["init", "-q"]);
  git(d, ["config", "core.fileMode", "false"]);
  for (const [p, c] of Object.entries(files)) write(d, p, c);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "base"]);
  return d;
}
const indexTime = (d: string) => statSync(join(d, ".git/index")).mtimeMs;

describe("W1 index files written by git, round trip", () => {
  const scenarios: [string, (d: string) => void][] = [
    ["version 2 after a commit (TREE)", () => {}],
    [
      "version 3: intent-to-add and skip-worktree",
      (d) => {
        write(d, "new", "n\n");
        git(d, ["add", "-N", "new"]);
        git(d, ["update-index", "--skip-worktree", "a"]);
      },
    ],
    ["version 4", (d) => git(d, ["update-index", "--index-version", "4"])],
    [
      "conflict stages after a failed merge",
      (d) => {
        git(d, ["checkout", "-qb", "side"]);
        write(d, "a", "side\n");
        git(d, ["commit", "-qam", "side"]);
        git(d, ["checkout", "-q", "-"]);
        write(d, "a", "main\n");
        git(d, ["commit", "-qam", "main"]);
        try {
          git(d, ["merge", "-q", "side"]);
        } catch {}
      },
    ],
    [
      "REUC after resolving",
      (d) => {
        git(d, ["checkout", "-qb", "side"]);
        write(d, "a", "side\n");
        git(d, ["commit", "-qam", "side"]);
        git(d, ["checkout", "-q", "-"]);
        write(d, "a", "main\n");
        git(d, ["commit", "-qam", "main"]);
        try {
          git(d, ["merge", "-q", "side"]);
        } catch {}
        write(d, "a", "resolved\n");
        git(d, ["add", "a"]);
      },
    ],
    [
      "EOIE and IEOT",
      (d) => {
        write(d, "b", "b2\n");
        git(d, [
          "-c",
          "index.recordEndOfIndexEntries=true",
          "-c",
          "index.recordOffsetTable=true",
          "add",
          "b",
        ]);
      },
    ],
  ];
  for (const [name, setup] of scenarios)
    it(name, () => {
      const names: Record<string, string> = {
        a: "a\n",
        b: "b\n",
        "dir/c": "c\n",
        "dir/sub/d": "d\n",
      };
      // names of every length from 1 to 20 (each padding), and long shared prefixes (version 4's varint)
      for (let n = 1; n <= 20; n++) names[`len/${"x".repeat(n)}`] = `${n}\n`;
      names[`long/${"p".repeat(150)}/one`] = "1\n";
      names[`long/${"q".repeat(200)}`] = "2\n";
      const d = initRepo(names);
      setup(d);
      const bytes = readFileSync(join(d, ".git/index"));
      const idx = parseIndex(bytes);
      expect(idx.entries.length).toBeGreaterThan(0);
      expect(Buffer.from(serializeIndex(idx)).equals(bytes)).toBe(true);
      const ls = git(d, ["ls-files", "--stage"]).trim().split("\n");
      expect(
        idx.entries.map((e) => `${e.mode.toString(8)} ${e.oid} ${e.stage}\t${e.path}`),
      ).toEqual(ls);
    });
});

async function openRepo(d: string) {
  return filesRepository(new StreamingNodeFilesApi(join(d, ".git")), nodeRefFiles(join(d, ".git")));
}
const worktreeOf = (d: string): Worktree => ({
  files: new NodeFilesApi({ rootDir: d }),
  stat: nodeStat(d),
  readLink: nodeReadLink(d),
});
async function writeIndex(d: string, idx: IndexFile) {
  writeFileSync(join(d, ".git/index"), serializeIndex(idx));
}
const head = (d: string) => git(d, ["rev-parse", "HEAD^{tree}"]).trim();

describe("W2 our staging, read by git", () => {
  it("git status is clean, ls-files and write-tree agree", async () => {
    const d = initRepo({ a: "a\n", "dir/c": "c\n" });
    write(d, "a", "a2\n");
    write(d, "dir/new", "new\n");
    rmSync(join(d, "dir/c"));
    const repo = await openRepo(d);
    await new Promise((r) => setTimeout(r, 5));
    const before = parseIndex(readFileSync(join(d, ".git/index")));
    const idx = await addAll(repo, worktreeOf(d), before, Date.now());
    await writeIndex(d, idx);
    expect(git(d, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      "M  a\nD  dir/c\nA  dir/new\n",
    );
    const ours = idx.entries.map((e) => `${e.mode.toString(8)} ${e.oid} ${e.stage}\t${e.path}`);
    git(d, ["add", "-A"]);
    expect(git(d, ["ls-files", "--stage"]).trim().split("\n")).toEqual(ours);
  });
});

/** random changes over a committed tree, some staged by git */
function changeCorpus(n: number, seed: number) {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const names = ["a", "b", "c", "d/e", "d/f", "g/h/i"];
  let uid = 0;
  return Array.from({ length: n }, (_, i) => {
    const base: Record<string, string> = {};
    for (const p of names) if (rand() < 0.7) base[p] = `${p} ${seed}-${uid++}\n`;
    const ops: ((d: string) => void)[] = [];
    const k = 1 + Math.floor(rand() * 4);
    for (let j = 0; j < k; j++) {
      const p = pick(names);
      const r = rand();
      const stage = rand() < 0.3;
      ops.push((d) => {
        const full = join(d, p);
        try {
          if (r < 0.35) write(d, p, `edited ${uid++}\n`);
          else if (r < 0.5) rmSync(full, { recursive: true, force: true });
          else if (r < 0.65) write(d, `${p}.new`, `new ${uid++}\n`);
          else if (r < 0.75) {
            rmSync(full, { recursive: true, force: true });
            write(d, `${p}/inner`, `inner ${uid++}\n`);
          } else write(d, p, `${p} same size ${uid++ % 10}\n`);
          if (stage) git(d, ["add", "-A", "--", "."]);
        } catch {}
      });
    }
    return { name: `#${i}`, base, ops };
  });
}

describe("W3 status equal to git's", () => {
  it("300 random working-tree changes", async () => {
    const wrong: string[] = [];
    for (const c of changeCorpus(300, 909)) {
      const d = initRepo(c.base);
      for (const op of c.ops) op(d);
      const repo = await openRepo(d);
      const idx = parseIndex(readFileSync(join(d, ".git/index")));
      const r = await status(repo, worktreeOf(d), idx, head(d), indexTime(d));
      const g = git(d, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"])
        .split("\n")
        .filter(Boolean);
      if (JSON.stringify(g) !== JSON.stringify(r.lines))
        wrong.push(`${c.name}\n  git:  ${JSON.stringify(g)}\n  ours: ${JSON.stringify(r.lines)}`);
    }
    expect(wrong.slice(0, 3)).toEqual([]);
    expect(wrong.length).toBe(0);
  }, 600_000);
});

describe("W4 nothing hashed for unchanged files", () => {
  it("50,000 files in memory: a second status hashes nothing, one edit hashes one file", async () => {
    const d = initRepo({ seed: "s\n" });
    const repo = await openRepo(d);
    const files = new MemFilesApi();
    for (let i = 0; i < 50_000; i++) {
      const p = `/d${i % 100}/f${i}`;
      await files.write(p, [new TextEncoder().encode(`file ${i}\n`)]);
    }
    const wt: Worktree = { files };
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    const idx = await addAll(repo, wt, undefined, t0);
    const first = await status(repo, wt, idx, undefined, t0);
    const second = await status(repo, wt, first.index, undefined, t0);
    expect(second.hashed).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    await files.write("/d7/f7", [new TextEncoder().encode("changed\n")]);
    const third = await status(repo, wt, second.index, undefined, t0);
    expect(third.hashed).toBe(1);
    expect(third.lines).toContain("AM d7/f7");
  }, 600_000);

  it("on Node: a second status hashes nothing", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2_000; i++) files[`d${i % 20}/f${i}`] = `file ${i}\n`;
    const d = initRepo(files);
    const repo = await openRepo(d);
    const idx = parseIndex(readFileSync(join(d, ".git/index")));
    const first = await status(repo, worktreeOf(d), idx, head(d), indexTime(d));
    const second = await status(repo, worktreeOf(d), first.index, head(d), indexTime(d));
    expect(first.lines).toEqual([]);
    expect(second.hashed).toBe(0);
  }, 300_000);
});

describe("W5 racy git", () => {
  it("an edit within the index's timestamp is found, by us and by git", async () => {
    const d = initRepo({ a: "aaaa\n", b: "bbbb\n" });
    const repo = await openRepo(d);
    // our index, written right after the files: entries racy
    const idx = await addAll(
      repo,
      worktreeOf(d),
      parseIndex(readFileSync(join(d, ".git/index"))),
      Date.now(),
    );
    await writeIndex(d, idx);
    const t = statSync(join(d, ".git/index")).mtime;
    // same size, mtime set to the index's own timestamp
    writeFileSync(join(d, "a"), "AAAA\n");
    utimesSync(join(d, "a"), t, t);
    const ours = await status(
      repo,
      worktreeOf(d),
      parseIndex(readFileSync(join(d, ".git/index"))),
      head(d),
      indexTime(d),
    );
    expect(ours.lines).toEqual([" M a"]);
    expect(git(d, ["status", "--porcelain=v1"])).toBe(" M a\n");
  });

  it("racy entries are smudged when we write the index (size 0)", async () => {
    const d = initRepo({ a: "aaaa\n" });
    const repo = await openRepo(d);
    // an index timestamp not newer than the file's mtime: the entry is racy (is_racy_timestamp)
    const ts = statSync(join(d, "a")).mtimeMs - 1;
    const idx = await addAll(repo, worktreeOf(d), undefined, ts);
    expect(idx.entries.find((e) => e.path === "a")?.size).toBe(0);
  });
});

describe("W7 cases for mutants the corpora missed", () => {
  const porcelain = (d: string) =>
    git(d, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"])
      .split("\n")
      .filter(Boolean);
  const ourStatus = async (d: string) => {
    const repo = await openRepo(d);
    return status(
      repo,
      worktreeOf(d),
      parseIndex(readFileSync(join(d, ".git/index"))),
      head(d),
      indexTime(d),
    );
  };

  it("racy: same size, same mtime as the entry, the index written in that instant", async () => {
    const d = initRepo({ a: "aaaa\n" });
    const t = statSync(join(d, "a")).mtime;
    writeFileSync(join(d, "a"), "AAAA\n");
    utimesSync(join(d, "a"), t, t);
    utimesSync(join(d, ".git/index"), t, t);
    expect((await ourStatus(d)).lines).toEqual([" M a"]);
    expect(porcelain(d)).toEqual([" M a"]);
  });

  it("a same-size edit with the mtime restored: only ctime tells", async () => {
    const d = initRepo({ a: "aaaa\n" });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(d, "a"), old, old);
    git(d, ["update-index", "--refresh"]); // the entry records the old mtime; the index is newer
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(d, "a"), "AAAA\n");
    utimesSync(join(d, "a"), old, old);
    // only ctime's nanoseconds changed: we compare them; a git built without USE_NSEC (Ubuntu's)
    // compares seconds and misses this edit, so git is not asserted here
    expect((await ourStatus(d)).lines).toEqual([" M a"]);
  });

  it("a size change with the mtime kept", async () => {
    const d = initRepo({ a: "aaaa\n" });
    await new Promise((r) => setTimeout(r, 20));
    const t = statSync(join(d, "a")).mtime;
    writeFileSync(join(d, "a"), "longer content\n");
    utimesSync(join(d, "a"), t, t);
    expect((await ourStatus(d)).lines).toEqual([" M a"]);
    expect(porcelain(d)).toEqual([" M a"]);
  });

  it("in memory: a same-size edit found by its mtime", async () => {
    const d = initRepo({ seed: "s\n" });
    const repo = await openRepo(d);
    const files = new MemFilesApi();
    await files.write("/f", [new TextEncoder().encode("one\n")]);
    const wt: Worktree = { files };
    await new Promise((r) => setTimeout(r, 5));
    const t0 = Date.now();
    const idx = await addAll(repo, wt, undefined, t0);
    await new Promise((r) => setTimeout(r, 5));
    await files.write("/f", [new TextEncoder().encode("two\n")]);
    expect((await status(repo, wt, idx, undefined, t0)).lines).toEqual(["AM f"]);
  });

  it("a touched file is hashed once, then its stat data is refreshed", async () => {
    const d = initRepo({ a: "aaaa\n" });
    await new Promise((r) => setTimeout(r, 20));
    const later = new Date(Date.now() - 5000);
    utimesSync(join(d, "a"), later, later);
    const repo = await openRepo(d);
    const first = await status(
      repo,
      worktreeOf(d),
      parseIndex(readFileSync(join(d, ".git/index"))),
      head(d),
      indexTime(d),
    );
    expect(first.hashed).toBe(1);
    const second = await status(repo, worktreeOf(d), first.index, head(d), indexTime(d));
    expect(second.hashed).toBe(0);
    expect(second.lines).toEqual([]);
  });

  it("intent-to-add and skip-worktree entries, as git reports them", async () => {
    const d = initRepo({ a: "a\n", b: "b\n" });
    write(d, "new", "n\n");
    git(d, ["add", "-N", "new"]);
    git(d, ["update-index", "--skip-worktree", "a"]);
    write(d, "a", "changed\n");
    expect((await ourStatus(d)).lines).toEqual(porcelain(d));
  });
});

describe("W8 review cases", () => {
  const porcelain = (d: string) =>
    git(d, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"])
      .split("\n")
      .filter(Boolean);
  const ourStatus = async (d: string, wt = worktreeOf(d)) =>
    status(
      await openRepo(d),
      wt,
      parseIndex(readFileSync(join(d, ".git/index"))),
      head(d),
      indexTime(d),
    );
  /** the same setup in two repositories: `git add -A` in one, ours in the other */
  async function addAllLikeGit(setup: (d: string) => void, files: Record<string, string>) {
    const ours = initRepo(files);
    const theirs = initRepo(files);
    setup(ours);
    setup(theirs);
    await new Promise((r) => setTimeout(r, 5));
    const repo = await openRepo(ours);
    const idx = await addAll(
      repo,
      worktreeOf(ours),
      parseIndex(readFileSync(join(ours, ".git/index"))),
      Date.now(),
    );
    await writeIndex(ours, idx);
    git(theirs, ["add", "-A"]);
    const ls = (d: string) => [git(d, ["ls-files", "--stage"]), git(d, ["ls-files", "-v"])];
    expect(ls(ours)).toEqual(ls(theirs));
  }

  it("git add -A keeps skip-worktree and assume-valid entries", async () => {
    await addAllLikeGit(
      (d) => {
        git(d, ["update-index", "--skip-worktree", "a"]);
        git(d, ["update-index", "--assume-unchanged", "b"]);
        rmSync(join(d, "a"));
        write(d, "b", "b changed\n");
      },
      { a: "a\n", b: "b\n", c: "c\n" },
    );
  });

  it("an unmerged path staged without a stage 0: the default mode", async () => {
    await addAllLikeGit(
      (d) => {
        const oid = (c: string) => git(d, ["hash-object", "-w", "--stdin"], c).trim();
        const [o1, o2, o3] = [oid("1\n"), oid("2\n"), oid("3\n")];
        git(
          d,
          ["update-index", "--index-info"],
          `0 ${"0".repeat(40)}\tm\n100755 ${o1} 1\tm\n100644 ${o2} 2\tm\n100755 ${o3} 3\tm\n`,
        );
        write(d, "m", "resolved\n");
      },
      { a: "a\n" },
    );
  });

  it("symlinks and gitlinks are kept by status and git add -A", async () => {
    const setup = (d: string) => {
      const sub = join(d, "sub");
      mkdirSync(sub);
      git(sub, ["init", "-q"]);
      write(sub, "x", "x\n");
      git(sub, ["add", "x"]);
      git(sub, ["commit", "-qm", "sub"]);
      execFileSync("ln", ["-s", "a", join(d, "l")]);
      git(d, ["add", "sub", "l"]);
      git(d, ["commit", "-qm", "links"]);
    };
    const d = initRepo({ a: "a\n" });
    setup(d);
    expect((await ourStatus(d)).lines).toEqual([]);
    expect(porcelain(d)).toEqual([]);
    rmSync(join(d, "l"));
    execFileSync("ln", ["-s", "elsewhere", join(d, "l")]);
    expect((await ourStatus(d)).lines).toEqual(porcelain(d));
    await addAllLikeGit(setup, { a: "a\n" });
  });

  it("git's line order and quoted paths", async () => {
    const d = initRepo({ a: "a\n", z: "z\n", "a b": "1\n", é: "2\n", 'q"x': "3\n", "t\tb": "4\n" });
    write(d, "a", "a2\n");
    git(d, ["add", "a"]);
    write(d, "z", "z2\n");
    write(d, "a b", "1b\n");
    write(d, "é", "2b\n");
    write(d, 'q"x', "3b\n");
    write(d, "t\tb", "4b\n");
    write(d, "m", "untracked\n");
    write(d, "ü new", "untracked\n");
    expect((await ourStatus(d)).lines).toEqual(porcelain(d));
  });

  it("intent-to-add over a path in HEAD", async () => {
    const d = initRepo({ a: "a\n", b: "b\n" });
    git(d, ["rm", "-q", "--cached", "b"]);
    git(d, ["add", "-N", "b"]);
    expect((await ourStatus(d)).lines).toEqual(porcelain(d));
  });

  it("the written version follows the entries' flags, as git's", () => {
    const d = initRepo({ a: "a\n" });
    write(d, "n", "n\n");
    git(d, ["add", "-N", "n"]);
    const v3 = parseIndex(readFileSync(join(d, ".git/index")));
    expect(v3.version).toBe(3);
    const down = parseIndex(serializeIndex({ ...v3, version: 2 }));
    expect(down.version).toBe(3);
    expect(down.entries.find((e) => e.path === "n")?.intentToAdd).toBe(true);
    git(d, ["rm", "-q", "--cached", "n"]);
    const plain = parseIndex(readFileSync(join(d, ".git/index")));
    expect(plain.version).toBe(2);
    const flagged = { ...plain, version: 3 as const };
    expect(parseIndex(serializeIndex(flagged)).version).toBe(2);
  });

  it("names that are not UTF-8 round-trip byte for byte", () => {
    const d = initRepo({ a: "a\n" });
    writeFileSync(join(Buffer.from(d), Buffer.from([0x2f, 0x6c, 0xe9])), "latin1\n");
    git(d, ["add", "-A"]);
    const bytes = readFileSync(join(d, ".git/index"));
    expect(Buffer.from(serializeIndex(parseIndex(bytes))).equals(bytes)).toBe(true);
  });

  it("a split index is refused, not read partially", () => {
    const d = initRepo({ a: "a\n", b: "b\n" });
    git(d, ["update-index", "--split-index"]);
    expect(() => parseIndex(readFileSync(join(d, ".git/index")))).toThrow(/link/);
  });

  it("FilesApi only: a size change with the mtime restored", async () => {
    const d = initRepo({ a: "aaaa\n" });
    const wt: Worktree = { files: new NodeFilesApi({ rootDir: d }) };
    await new Promise((r) => setTimeout(r, 5));
    const idx = await addAll(await openRepo(d), wt, undefined, Date.now());
    await writeIndex(d, idx);
    const t = statSync(join(d, "a")).mtime;
    writeFileSync(join(d, "a"), "longer content\n");
    utimesSync(join(d, "a"), t, t);
    const r = await status(await openRepo(d), wt, idx, head(d), indexTime(d));
    expect(r.lines).toEqual([" M a"]);
  });

  it("FilesApi only: a smudged entry whose file is now empty, mtime restored", async () => {
    const d = initRepo({ a: "aaaa\n" });
    const wt: Worktree = { files: new NodeFilesApi({ rootDir: d }) };
    const ts = statSync(join(d, "a")).mtimeMs - 1;
    const idx = await addAll(await openRepo(d), wt, undefined, ts);
    expect(idx.entries[0]?.size).toBe(0);
    const t = statSync(join(d, "a")).mtime;
    writeFileSync(join(d, "a"), "");
    utimesSync(join(d, "a"), t, t);
    const r = await status(await openRepo(d), wt, idx, head(d), ts + 10_000_000);
    expect(r.lines).toEqual([" M a"]);
  });

  it("a refreshed index is smudged when written in the same instant", async () => {
    const d = initRepo({ a: "aaaa\n" });
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(d, "a"), old, old);
    git(d, ["update-index", "--refresh"]);
    writeFileSync(join(d, "a"), "aaaa\n"); // same content, new mtime
    const r = await ourStatus(d);
    const at = statSync(join(d, "a")).mtimeMs;
    const written = smudgeRacy(r.index, at);
    expect(written.entries.find((e) => e.path === "a")?.size).toBe(0);
    expect(smudgeRacy(r.index, at + 1000).entries.find((e) => e.path === "a")?.size).toBe(5);
  });

  it("a directory replaced by a file", async () => {
    const d = initRepo({ "d/x": "x\n", "d/y": "y\n", a: "a\n" });
    rmSync(join(d, "d"), { recursive: true });
    write(d, "d", "now a file\n");
    expect((await ourStatus(d)).lines).toEqual(porcelain(d));
    await addAllLikeGit(
      (r) => {
        rmSync(join(r, "d"), { recursive: true });
        write(r, "d", "now a file\n");
      },
      { "d/x": "x\n", "d/y": "y\n", a: "a\n" },
    );
  });
});

describe("W6 portable", () => {
  it("src/ has no node: imports outside node-stat.ts", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of readdirSync(src))
      if (file !== "node-stat.ts")
        expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/from "node:/);
  });
});
