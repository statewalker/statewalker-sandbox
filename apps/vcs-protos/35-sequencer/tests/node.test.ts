import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { filesRefDb } from "../../10-ref-transactions/src/files-ref-db.js";
import { runRefContract } from "../../10-ref-transactions/src/ref-contract.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import type { Person } from "../../17-repository/src/git-format.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import {
  legacyHashChars,
  legacyPathInWay,
  legacyRenameToSelf,
  rng,
} from "../../29-merge/tests/tree-harness.js";
import { nodeStat } from "../../34-index/src/node-stat.js";
import { filesRefFiles, subFiles } from "../src/files-adapters.js";
import {
  abortOp,
  addAllOp,
  cherryPick,
  commitOp,
  continueOp,
  merge,
  rebase,
  type Session,
} from "../src/sequencer.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const AUTHOR_DATE = 1700000000;
const COMMITTER_DATE = 1700000100;
const env = {
  ...gitEnv,
  GIT_AUTHOR_DATE: `${AUTHOR_DATE} +0000`,
  GIT_COMMITTER_DATE: `${COMMITTER_DATE} +0000`,
  GIT_EDITOR: "true",
};
const author: Person = { name: "A U Thor", email: "a@example.com", when: AUTHOR_DATE, tz: "+0000" };
const committer: Person = {
  name: "C O Mitter",
  email: "c@example.com",
  when: COMMITTER_DATE,
  tz: "+0000",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
/** git that may stop on a conflict (exit status 1) */
const gitMay = (cwd: string, args: string[]) => {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
};
const write = (d: string, path: string, content: string) => {
  mkdirSync(dirname(join(d, path)), { recursive: true });
  writeFileSync(join(d, path), content);
};

/** random histories: a base, `side` and `main` each with a few commits over five small files */
function history(seed: number): string {
  const rand = rng(seed);
  const d = tmp("x15-");
  git(d, ["init", "-q", "-b", "main"]);
  git(d, ["config", "core.fileMode", "false"]);
  const files = ["a", "b", "c", "d/e", "d/f"];
  for (const f of files)
    write(d, f, `${["1", "2", "3", "4", "5", "6"].map((l) => `${f}${l}`).join("\n")}\n`);
  git(d, ["add", "-A"]);
  git(d, ["commit", "-qm", "base"]);
  let n = 0;
  const work = (branch: string, k: number) => {
    for (let i = 0; i < k; i++) {
      const f = files[Math.floor(rand() * files.length)] as string;
      const r = rand();
      const full = join(d, f);
      if (r < 0.75 || !existsSync(full)) {
        const lines = existsSync(full) ? readFileSync(full, "utf8").split("\n") : ["", ""];
        lines[Math.floor(rand() * (lines.length - 1))] = `${branch} ${n++}`;
        write(d, f, lines.join("\n"));
      } else if (r < 0.88) write(d, `${f}.${branch}${n++}`, `new ${n}\n`);
      else rmSync(full);
      git(d, ["add", "-A"]);
      // side's commits have their own author and date: a pick must keep them
      const by =
        branch === "side" ? ["--author=S Ide <s@example.com>", "--date=1600000000 +0200"] : [];
      git(d, ["commit", "-qm", `${branch} ${i}\n\nbody ${n}`, ...by]);
    }
  };
  git(d, ["checkout", "-qb", "side"]);
  work("side", 1 + Math.floor(rand() * 3));
  git(d, ["checkout", "-q", "main"]);
  work("main", 1 + Math.floor(rand() * 3));
  return d;
}
/** a resolution that is never the HEAD tree: every unmerged path gets new content */
const resolve = (d: string) => {
  const paths = new Set(
    git(d, ["ls-files", "-u"])
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t")[1] as string),
  );
  for (const p of paths) write(d, p, `resolved ${p}\n`);
  git(d, ["add", "-A"]);
};
/** does this git leave AUTO_MERGE after a clean cherry-pick (2.43 does)? */
const legacyAutoMerge = (() => {
  const d = tmp("x15p-");
  git(d, ["init", "-q", "-b", "main"]);
  write(d, "a", "1\n");
  git(d, ["add", "a"]);
  git(d, ["commit", "-qm", "a"]);
  git(d, ["checkout", "-qb", "side"]);
  write(d, "b", "2\n");
  git(d, ["add", "b"]);
  git(d, ["commit", "-qm", "b"]);
  git(d, ["checkout", "-q", "main"]);
  write(d, "c", "3\n");
  git(d, ["add", "c"]);
  git(d, ["commit", "-qm", "c"]);
  git(d, ["cherry-pick", "side"]);
  return existsSync(join(d, ".git/AUTO_MERGE"));
})();
/**
 * How this git writes a stopped rebase: does it leave REBASE_HEAD after stopping on its last pick
 * (2.43 does); does it write todo lines without `# ` before the subject, and `rebase-merge/message`
 * as the message alone rather than with the conflict list (2.43 does; 2.56 does not)?
 */
const rebaseProbe = (() => {
  const d = tmp("x15q-");
  git(d, ["init", "-q", "-b", "main"]);
  write(d, "a", "1\n");
  git(d, ["add", "a"]);
  git(d, ["commit", "-qm", "a"]);
  git(d, ["checkout", "-qb", "side"]);
  write(d, "a", "side\n");
  git(d, ["commit", "-qam", "side"]);
  git(d, ["checkout", "-q", "main"]);
  write(d, "a", "main\n");
  git(d, ["commit", "-qam", "main"]);
  git(d, ["checkout", "-q", "side"]);
  gitMay(d, ["rebase", "main"]);
  const done = readFileSync(join(d, ".git/rebase-merge/done"), "utf8");
  const message = readFileSync(join(d, ".git/rebase-merge/message"), "utf8");
  git(d, ["add", "-A"]);
  git(d, ["rebase", "--continue"]);
  return {
    legacyRebaseHead: existsSync(join(d, ".git/REBASE_HEAD")),
    legacyTodoFormat: !/ # side/.test(done),
    legacyRebaseMessage: !message.includes("# Conflicts:"),
  };
})();
const twin = (d: string) => {
  const t = tmp("x15t-");
  cpSync(d, t, { recursive: true });
  return t;
};

const mergeOptions = {
  legacyHashChars,
  legacyPathInWay,
  legacyRenameToSelf,
  detectRenames: true,
};
async function session(d: string): Promise<Session> {
  return {
    repo: await filesRepository(
      new StreamingNodeFilesApi(join(d, ".git")),
      nodeRefFiles(join(d, ".git")),
    ),
    git: new NodeFilesApi({ rootDir: join(d, ".git") }),
    wt: { files: new NodeFilesApi({ rootDir: d }), stat: nodeStat(d) },
    author,
    committer,
    mergeOptions,
    legacyAutoMerge,
    ...rebaseProbe,
  };
}

const STATE = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "ORIG_HEAD",
  "AUTO_MERGE",
  "CHERRY_PICK_HEAD",
  "REBASE_HEAD",
  ...[
    "head-name",
    "onto",
    "orig-head",
    "git-rebase-todo",
    "done",
    "msgnum",
    "end",
    "author-script",
    "message",
    "stopped-sha",
    "interactive",
    "drop_redundant_commits",
    "no-reschedule-failed-exec",
    "rewritten-list",
  ].map((f) => `rebase-merge/${f}`),
];
function worktreeFiles(d: string, at = d, out: Record<string, string> = {}) {
  for (const e of readdirSync(at, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(at, e.name);
    if (e.isDirectory()) {
      // git removes directories it empties: an empty one is a difference
      if (!readdirSync(p).length) out[`${relative(d, p)}/`] = "";
      worktreeFiles(d, p, out);
    } else out[relative(d, p)] = readFileSync(p, "utf8");
  }
  return out;
}
/** what must be equal between the twins */
function snapshot(d: string) {
  const state: Record<string, string> = {};
  for (const f of STATE) {
    const p = join(d, ".git", f);
    if (existsSync(p)) state[f] = readFileSync(p, "utf8");
  }
  let symbolic = "";
  try {
    symbolic = git(d, ["symbolic-ref", "-q", "HEAD"]);
  } catch {}
  return {
    head: git(d, ["rev-parse", "HEAD"]),
    symbolic,
    refs: git(d, ["show-ref"]),
    state,
    index: git(d, ["ls-files", "--stage"]),
    files: worktreeFiles(d),
    status: git(d, ["status", "--porcelain=v1", "--untracked-files=all"]),
  };
}

const N = 120;
const corpus = Array.from({ length: N }, (_, i) => 7000 + i);

describe("S1 merge: the same commit or the same stopped state as git merge", () => {
  it(`${N} random histories`, async () => {
    let conflicts = 0;
    let clean = 0;
    const wrong: string[] = [];
    for (const seed of corpus) {
      const a = history(seed);
      const b = twin(a);
      const ok = gitMay(a, ["merge", "side"]);
      const r = await merge(await session(b), "refs/heads/side");
      if (r.status === "conflict") conflicts++;
      else clean++;
      if (ok !== (r.status !== "conflict")) wrong.push(`${seed}: git ${ok}, ours ${r.status}`);
      else if (JSON.stringify(snapshot(a)) !== JSON.stringify(snapshot(b)))
        wrong.push(
          `${seed}\n git:  ${JSON.stringify(snapshot(a))}\n ours: ${JSON.stringify(snapshot(b))}`,
        );
    }
    expect(wrong.slice(0, 2)).toEqual([]);
    expect(conflicts).toBeGreaterThan(15);
    expect(clean).toBeGreaterThan(15);
  }, 600_000);

  it("fast-forward, already up to date, a merge into another branch", async () => {
    const cases: [string, (d: string) => void, string][] = [
      ["fast-forward", (d) => git(d, ["checkout", "-qb", "behind", "side~1"]), "side"],
      [
        "up to date",
        (d) => {
          git(d, ["branch", "old", "side~1"]);
          git(d, ["checkout", "-q", "side"]);
        },
        "old",
      ],
      ["into topic", (d) => git(d, ["checkout", "-qb", "topic"]), "side"],
    ];
    for (const [name, setup, branch] of cases) {
      const a = history(7001);
      setup(a);
      const b = twin(a);
      gitMay(a, ["merge", branch]);
      await merge(await session(b), `refs/heads/${branch}`);
      expect(snapshot(b), name).toEqual(snapshot(a));
    }
  }, 60_000);
});

/** the conflicted cases of the corpus */
const conflicted = () => {
  const out: number[] = [];
  for (const seed of corpus) {
    if (out.length >= 12) break;
    const a = history(seed);
    if (!gitMay(a, ["merge", "side"])) out.push(seed);
  }
  return out;
};

describe("S2 native git finishes our merge", () => {
  it("git commit --no-edit, and git merge --abort", async () => {
    for (const seed of conflicted()) {
      const a = history(seed);
      const b = twin(a);
      const c = twin(a);
      gitMay(a, ["merge", "side"]);
      await merge(await session(b), "refs/heads/side");
      await merge(await session(c), "refs/heads/side");
      for (const d of [a, b]) {
        git(d, ["add", "-A"]);
        git(d, ["commit", "-q", "--no-edit"]);
      }
      expect(snapshot(b), `${seed}`).toEqual(snapshot(a));
      const a2 = history(seed);
      gitMay(a2, ["merge", "side"]);
      for (const d of [a2, c]) git(d, ["merge", "--abort"]);
      expect(snapshot(c), `${seed} abort`).toEqual(snapshot(a2));
    }
  }, 600_000);
});

describe("S3 we finish native git's merge", () => {
  it("commitOp after git add, abortOp, and our own add", async () => {
    for (const seed of conflicted()) {
      const a = history(seed);
      gitMay(a, ["merge", "side"]);
      const b = twin(a);
      const c = twin(a);
      const e = twin(a);
      git(a, ["add", "-A"]);
      git(a, ["commit", "-q", "--no-edit"]);
      git(b, ["add", "-A"]);
      await commitOp(await session(b));
      expect(snapshot(b), `${seed}`).toEqual(snapshot(a));
      await addAllOp(await session(e));
      await commitOp(await session(e));
      expect(snapshot(e), `${seed} our add`).toEqual(snapshot(a));
      const a2 = history(seed);
      gitMay(a2, ["merge", "side"]);
      git(a2, ["merge", "--abort"]);
      await abortOp(await session(c));
      expect(snapshot(c), `${seed} abort`).toEqual(snapshot(a2));
    }
  }, 600_000);
});

describe("S4 cherry-pick, both ways", () => {
  it(`${N} random histories: side's tip onto main`, async () => {
    let conflicts = 0;
    const wrong: string[] = [];
    for (const seed of corpus) {
      const a = history(seed);
      const b = twin(a);
      const pick = git(a, ["rev-parse", "side"]).trim();
      const ok = gitMay(a, ["cherry-pick", pick]);
      const r = await cherryPick(await session(b), pick);
      if (ok !== (r.status !== "conflict")) {
        wrong.push(`${seed}: git ${ok}, ours ${r.status}`);
        continue;
      }
      if (JSON.stringify(snapshot(a)) !== JSON.stringify(snapshot(b))) {
        wrong.push(
          `${seed}\n git:  ${JSON.stringify(snapshot(a))}\n ours: ${JSON.stringify(snapshot(b))}`,
        );
        continue;
      }
      if (ok) continue;
      conflicts++;
      // native finishes ours (b), we finish native's (c)
      const c = twin(a);
      for (const d of [a, b, c]) resolve(d);
      git(a, ["commit", "-q", "--no-edit"]);
      git(b, ["commit", "-q", "--no-edit"]);
      await commitOp(await session(c));
      if (JSON.stringify(snapshot(a)) !== JSON.stringify(snapshot(b)))
        wrong.push(`${seed} native commit of ours`);
      if (JSON.stringify(snapshot(a)) !== JSON.stringify(snapshot(c)))
        wrong.push(
          `${seed} our commit of native's\n git:  ${JSON.stringify(snapshot(a))}\n ours: ${JSON.stringify(snapshot(c))}`,
        );
    }
    expect(wrong.map((w) => w.slice(0, 300)).slice(0, 8)).toEqual([]);
    expect(conflicts).toBeGreaterThan(10);
  }, 600_000);
});

/** rebases `side` onto `main`, starting and continuing with git or with us */
async function rebaseFlow(
  seed: number,
  start: "git" | "ours",
  cont: "git" | "ours",
  abortAt?: number,
): Promise<{ a: string; b: string; stops: number; wrong: string[] }> {
  const a = history(seed);
  git(a, ["checkout", "-q", "side"]);
  const b = twin(a);
  const wrong: string[] = [];
  const check = (what: string) => {
    const x = snapshot(a) as Record<string, unknown>;
    const y = snapshot(b) as Record<string, unknown>;
    const keys = Object.keys(x).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
    if (keys.length)
      wrong.push(
        `${seed} ${what}: ${keys.map((k) => `${k}\n git:  ${JSON.stringify(x[k])}\n ours: ${JSON.stringify(y[k])}`).join("\n")}`,
      );
  };
  let stopped = !gitMay(a, ["rebase", "main"]);
  if (start === "git") gitMay(b, ["rebase", "main"]);
  else await rebase(await session(b), "refs/heads/main");
  check(`start (${start})`);
  let stops = 0;
  while (stopped && !wrong.length) {
    stops++;
    if (abortAt === stops) {
      git(a, ["rebase", "--abort"]);
      if (cont === "git") git(b, ["rebase", "--abort"]);
      else await abortOp(await session(b));
      check("abort");
      break;
    }
    git(a, ["add", "-A"]);
    git(b, ["add", "-A"]);
    stopped = !gitMay(a, ["rebase", "--continue"]);
    if (cont === "git") gitMay(b, ["rebase", "--continue"]);
    else await continueOp(await session(b));
    check(`continue ${stops} (${cont})`);
  }
  return { a, b, stops, wrong };
}

describe("S5 rebase, both ways", () => {
  it(`${N} random histories, git and us starting and continuing in turn`, async () => {
    let stops = 0;
    const wrong: string[] = [];
    const modes = [
      ["ours", "ours"],
      ["ours", "git"],
      ["git", "ours"],
      ["git", "git"],
    ] as const;
    for (const [i, seed] of corpus.entries()) {
      const [start, cont] = modes[i % 4] as (typeof modes)[number];
      const r = await rebaseFlow(seed, start, cont);
      stops += r.stops;
      wrong.push(...r.wrong);
    }
    expect(wrong.map((w) => w.slice(0, 300)).slice(0, 6)).toEqual([]);
    expect(stops).toBeGreaterThan(15);
  }, 900_000);

  it("--abort both ways", async () => {
    const wrong: string[] = [];
    let aborted = 0;
    for (const seed of corpus.slice(0, 40)) {
      for (const cont of ["git", "ours"] as const) {
        const r = await rebaseFlow(seed, cont === "git" ? "ours" : "git", cont, 1);
        if (r.stops) aborted++;
        wrong.push(...r.wrong);
      }
    }
    expect(wrong.slice(0, 2)).toEqual([]);
    expect(aborted).toBeGreaterThan(5);
  }, 600_000);
});

describe("S8 hand-made cases for mutants the corpora missed", () => {
  const repo = (base: Record<string, string>) => {
    const d = tmp("x15h-");
    git(d, ["init", "-q", "-b", "main"]);
    git(d, ["config", "core.fileMode", "false"]);
    for (const [p, c] of Object.entries(base)) write(d, p, c);
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "base"]);
    return d;
  };
  const commitAll = (d: string, msg: string) => {
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", msg]);
  };

  it("a rebased commit that becomes empty is dropped", async () => {
    const a = repo({ a: "a1\na2\n", b: "b1\nb2\n" });
    git(a, ["checkout", "-qb", "side"]);
    write(a, "a", "X\na2\n");
    commitAll(a, "side: a1 to X");
    write(a, "b", "b1\nside\n");
    commitAll(a, "side: b2");
    git(a, ["checkout", "-q", "main"]);
    write(a, "a", "X\na2\n");
    write(a, "c", "new\n"); // not the same patch: git does not skip side's commit up front
    commitAll(a, "main: a1 to X, and c");
    git(a, ["checkout", "-q", "side"]);
    const b = twin(a);
    git(a, ["rebase", "main"]);
    expect((await rebase(await session(b), "refs/heads/main")).status).toBe("done");
    expect(snapshot(b)).toEqual(snapshot(a));
    expect(git(a, ["rev-list", "--count", "main..side"]).trim()).toBe("1");
  });

  it("a directory emptied by a merge is removed", async () => {
    const a = repo({ "d/x": "x\n", "d/y": "y\n", k: "k\n" });
    git(a, ["checkout", "-qb", "side"]);
    rmSync(join(a, "d"), { recursive: true });
    commitAll(a, "side: no d");
    git(a, ["checkout", "-q", "main"]);
    write(a, "k", "k2\n");
    commitAll(a, "main: k");
    const b = twin(a);
    git(a, ["merge", "side"]);
    await merge(await session(b), "refs/heads/side");
    expect(existsSync(join(b, "d"))).toBe(false);
    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it("files a merge does not change are not rewritten, and keep their stat data", async () => {
    const a = repo({ keep: "keep\n", a: "a\n", b: "b\n" });
    git(a, ["checkout", "-qb", "side"]);
    write(a, "a", "a2\n");
    commitAll(a, "side: a");
    git(a, ["checkout", "-q", "main"]);
    write(a, "b", "b2\n");
    commitAll(a, "main: b");
    const before = statSync(join(a, "keep"), { bigint: true }).mtimeNs;
    const debug = git(a, ["ls-files", "--debug", "keep"]);
    await merge(await session(a), "refs/heads/side");
    expect(statSync(join(a, "keep"), { bigint: true }).mtimeNs).toBe(before);
    expect(git(a, ["ls-files", "--debug", "keep"])).toBe(debug);
  });
});

describe("S9 review cases", () => {
  const repo = (base: Record<string, string>) => {
    const d = tmp("x15r-");
    git(d, ["init", "-q", "-b", "main"]);
    git(d, ["config", "core.fileMode", "false"]);
    for (const [p, c] of Object.entries(base)) write(d, p, c);
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", "base"]);
    return d;
  };
  const commitAll = (d: string, msg: string) => {
    git(d, ["add", "-A"]);
    git(d, ["commit", "-qm", msg]);
  };
  /** our operation and git's refuse alike, leaving the same state */
  async function refusesAlike(
    a: string,
    gitArgs: string[],
    ours: (s: Session) => Promise<unknown>,
  ) {
    const b = twin(a);
    expect(gitMay(a, gitArgs)).toBe(false);
    await expect(ours(await session(b))).rejects.toThrow(/untracked/);
    expect(snapshot(b)).toEqual(snapshot(a));
  }

  it("untracked files a merge, cherry-pick or rebase would overwrite: refused, as git does", async () => {
    const make = () => {
      const a = repo({ a: "a\n" });
      git(a, ["checkout", "-qb", "side"]);
      write(a, "new", "theirs\n");
      commitAll(a, "side: new");
      git(a, ["checkout", "-q", "main"]);
      write(a, "b", "b\n");
      commitAll(a, "main: b");
      write(a, "new", "mine, untracked\n");
      return a;
    };
    await refusesAlike(make(), ["merge", "side"], (s) => merge(s, "refs/heads/side"));
    await refusesAlike(make(), ["cherry-pick", "side"], (s) => cherryPick(s, "refs/heads/side"));
    const r = make();
    rmSync(join(r, "new"));
    git(r, ["checkout", "-q", "main"]);
    git(r, ["checkout", "-qb", "topic"]);
    write(r, "c", "c\n");
    commitAll(r, "topic: c");
    write(r, "new", "mine, untracked\n");
    await refusesAlike(r, ["rebase", "side"], (s) => rebase(s, "refs/heads/side"));
  });

  it("a branch with merge commits is refused rather than rebased wrongly", async () => {
    const a = repo({ a: "a\n" });
    git(a, ["checkout", "-qb", "topic"]);
    write(a, "t1", "1\n");
    commitAll(a, "t1");
    git(a, ["checkout", "-qb", "sub", "main"]);
    write(a, "t2", "2\n");
    commitAll(a, "t2");
    git(a, ["checkout", "-q", "topic"]);
    git(a, ["merge", "-q", "--no-ff", "-m", "merge sub", "sub"]);
    git(a, ["checkout", "-q", "main"]);
    write(a, "m", "m\n");
    commitAll(a, "m");
    git(a, ["checkout", "-q", "topic"]);
    const before = snapshot(a);
    await expect(rebase(await session(a), "refs/heads/main")).rejects.toThrow(/merge/);
    expect(snapshot(a)).toEqual(before);
  });

  it("merge messages: a remote-tracking branch, a commit id, a lightweight tag, a detached HEAD, a short name", async () => {
    const make = () => {
      const a = repo({ a: "a\n" });
      git(a, ["checkout", "-qb", "side"]);
      write(a, "s", "s\n");
      commitAll(a, "side");
      git(a, ["checkout", "-q", "main"]);
      write(a, "m", "m\n");
      commitAll(a, "main");
      git(a, ["update-ref", "refs/remotes/origin/side", "side"]);
      git(a, ["tag", "v1", "side"]);
      return a;
    };
    const id = (d: string) => git(d, ["rev-parse", "side"]).trim();
    const cases: [string, (d: string) => string, (d: string) => void][] = [
      ["remote-tracking", () => "origin/side", () => {}],
      ["commit id", (d) => id(d), () => {}],
      ["lightweight tag", () => "v1", () => {}],
      ["detached HEAD", () => "side", (d) => git(d, ["checkout", "-q", "--detach"])],
      ["short name", () => "side", () => {}],
    ];
    for (const [name, rev, setup] of cases) {
      const a = make();
      setup(a);
      const b = twin(a);
      git(a, ["merge", "-q", "--no-edit", rev(a)]);
      await merge(await session(b), rev(b));
      expect(snapshot(b), name).toEqual(snapshot(a));
    }
    const t = make();
    git(t, ["tag", "-a", "-m", "annotated", "v2", "side"]);
    await expect(merge(await session(t), "v2")).rejects.toThrow(/annotated/);
  });

  it("messages without a final newline or with CRLF: the conflict list as git appends it", async () => {
    for (const message of ["subject\n\nbody", "subj\r\n\r\nbody\r\n", "one line"]) {
      const a = repo({ f: "1\n2\n3\n" });
      write(a, "f", "1\nS\n3\n");
      git(a, ["add", "-A"]);
      const tree = git(a, ["write-tree"]).trim();
      const pick = execFileSync("git", ["commit-tree", tree, "-p", "HEAD"], {
        cwd: a,
        env,
        input: message,
      })
        .toString()
        .trim();
      git(a, ["reset", "-q", "--hard"]);
      write(a, "f", "1\nM\n3\n");
      commitAll(a, "main");
      git(a, ["branch", "side", pick]);
      const b = twin(a);
      gitMay(a, ["cherry-pick", pick]);
      await cherryPick(await session(b), pick);
      expect(snapshot(b), JSON.stringify(message)).toEqual(snapshot(a));
      const a2 = twin(a);
      const b2 = twin(a);
      git(a2, ["cherry-pick", "--abort"]);
      git(b2, ["cherry-pick", "--abort"]);
      git(a2, ["checkout", "-q", "side"]);
      git(b2, ["checkout", "-q", "side"]);
      gitMay(a2, ["rebase", "main"]);
      await rebase(await session(b2), "refs/heads/main");
      expect(snapshot(b2), `rebase ${JSON.stringify(message)}`).toEqual(snapshot(a2));
      for (const d of [a, b]) {
        resolve(d);
        git(d, ["commit", "-q", "--no-edit"]);
      }
      expect(snapshot(b), `commit ${JSON.stringify(message)}`).toEqual(snapshot(a));
    }
  });

  it("filesRefFiles meets X5's ref contract, also through subFiles", async () => {
    for (const make of [
      async () => filesRefDb(filesRefFiles(new MemFilesApi())),
      async () => filesRefDb(filesRefFiles(subFiles(new MemFilesApi(), "/.git"))),
    ]) {
      const r = await runRefContract(make);
      expect(r.failed).toEqual([]);
      expect(r.cases).toBeGreaterThan(10);
    }
  }, 60_000);
});

/** copies a directory into a FilesApi */
async function load(files: MemFilesApi, d: string, at = d) {
  for (const e of readdirSync(at, { withFileTypes: true })) {
    const p = join(at, e.name);
    if (e.isDirectory()) await load(files, d, p);
    else await files.write(`/${relative(d, p)}`, [readFileSync(p)]);
  }
}
async function memSession(files: MemFilesApi): Promise<Session> {
  const dotGit = subFiles(files, "/.git");
  return {
    repo: await filesRepository(dotGit, filesRefFiles(dotGit)),
    git: dotGit,
    wt: { files },
    author,
    committer,
    mergeOptions,
    legacyAutoMerge,
    ...rebaseProbe,
  };
}

describe("S6 resume after a reload, in memory", () => {
  it("each step on a freshly opened repository: the same commits as git", async () => {
    let stops = 0;
    for (const seed of corpus.slice(0, 40)) {
      const a = history(seed);
      git(a, ["checkout", "-q", "side"]);
      const files = new MemFilesApi();
      await load(files, a);
      let stopped = !gitMay(a, ["rebase", "main"]);
      let r = await rebase(await memSession(files), "refs/heads/main");
      expect(r.status === "stopped", `${seed}`).toBe(stopped);
      while (stopped) {
        stops++;
        git(a, ["add", "-A"]);
        stopped = !gitMay(a, ["rebase", "--continue"]);
        await addAllOp(await memSession(files)); // a reload between steps
        r = await continueOp(await memSession(files));
        expect(r.status === "stopped", `${seed} step ${stops}`).toBe(stopped);
      }
      const s = await memSession(files);
      expect(await s.repo.refs.resolve("refs/heads/side"), `${seed}`).toBe(
        git(a, ["rev-parse", "side"]).trim(),
      );
      expect(await s.repo.refs.read("HEAD")).toEqual({ symref: "refs/heads/side" });
    }
    expect(stops).toBeGreaterThan(3);
  }, 600_000);
});

describe("S7 portable", () => {
  it("src/ has no node: imports", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of readdirSync(src))
      expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/from "node:/);
  });
});
