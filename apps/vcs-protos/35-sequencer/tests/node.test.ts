import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import type { Person } from "../../17-repository/src/git-format.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { rng } from "../../29-merge/tests/tree-harness.js";
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
      git(d, ["commit", "-qm", `${branch} ${i}\n\nbody ${n}`]);
    }
  };
  git(d, ["checkout", "-qb", "side"]);
  work("side", 1 + Math.floor(rand() * 3));
  git(d, ["checkout", "-q", "main"]);
  work("main", Math.floor(rand() * 3));
  return d;
}
const twin = (d: string) => {
  const t = tmp("x15t-");
  cpSync(d, t, { recursive: true });
  return t;
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
  ].map((f) => `rebase-merge/${f}`),
];
function worktreeFiles(d: string, at = d, out: Record<string, string> = {}) {
  for (const e of readdirSync(at, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = join(at, e.name);
    if (e.isDirectory()) worktreeFiles(d, p, out);
    else out[relative(d, p)] = readFileSync(p, "utf8");
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
      for (const d of [a, b, c]) git(d, ["add", "-A"]);
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
    expect(wrong.slice(0, 2)).toEqual([]);
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
    if (JSON.stringify(snapshot(a)) !== JSON.stringify(snapshot(b)))
      wrong.push(
        `${seed} ${what}\n git:  ${JSON.stringify(snapshot(a))}\n ours: ${JSON.stringify(snapshot(b))}`,
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
    expect(wrong.slice(0, 2)).toEqual([]);
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
