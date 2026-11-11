import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { encodeCommit } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import type { ConflictEntry, MergeMessage } from "../../29-merge/src/merge-trees.js";
import {
  type Files,
  f,
  legacyCompaction,
  legacyHashChars,
  legacyPathInWay,
  rng,
  writeFilesWithModes,
} from "../../29-merge/tests/tree-harness.js";
import { mergeBases, mergeCommits } from "../src/recursive.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** a history: commits in order, each with its parents (earlier indices), files and date */
interface Node {
  parents: number[];
  files: Files;
  when: number;
}
interface Dag {
  name: string;
  nodes: Node[];
  ours: number;
  theirs: number;
}

async function writeDag(repo: Repository, dag: Dag): Promise<string[]> {
  const ids: string[] = [];
  for (const [k, n] of dag.nodes.entries()) {
    const tree = await writeFilesWithModes(repo, n.files);
    const who = { name: "A", email: "a@example.com", when: n.when, tz: "+0000" };
    ids.push(
      await repo.objects.put(
        "commit",
        encodeCommit({
          tree,
          parents: n.parents.map((p) => ids[p] as string),
          author: who,
          committer: who,
          message: `${dag.name} ${k}\n`,
        }),
      ),
    );
  }
  return ids;
}

async function freshRepo() {
  const d = mkdtempSync(join(tmpdir(), "x13f-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", "--bare", d], { env: gitEnv });
  return { d, repo: await filesRepository(new StreamingNodeFilesApi(d), nodeRefFiles(d)) };
}

async function compareBases(dags: Dag[]) {
  const { d, repo } = await freshRepo();
  const wrong: string[] = [];
  let multiple = 0;
  for (const dag of dags) {
    const ids = await writeDag(repo, dag);
    const a = ids[dag.ours] as string;
    const b = ids[dag.theirs] as string;
    let git: string[] = [];
    try {
      git = execFileSync("git", ["merge-base", "--all", a, b], { cwd: d, env: gitEnv })
        .toString()
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      git = []; // no common ancestor
    }
    if (git.length > 1) multiple++;
    const ours = await mergeBases(repo, a, b);
    const name = (x: string) => `n${ids.indexOf(x)}`;
    if (JSON.stringify(git) !== JSON.stringify(ours))
      wrong.push(`${dag.name}: git ${git.map(name)} ours ${ours.map(name)}`);
  }
  return { wrong, multiple };
}

async function compareMerges(dags: Dag[]) {
  const { d, repo } = await freshRepo();
  const lines: string[] = [];
  const all: string[][] = [];
  for (const [i, dag] of dags.entries()) {
    const ids = await writeDag(repo, dag);
    all.push(ids);
    execFileSync("git", ["update-ref", `refs/heads/o${i}`, ids[dag.ours] as string], {
      cwd: d,
      env: gitEnv,
    });
    execFileSync("git", ["update-ref", `refs/heads/t/${i}`, ids[dag.theirs] as string], {
      cwd: d,
      env: gitEnv,
    });
    lines.push(`o${i} t/${i}`);
  }
  const out = execFileSync(
    "git",
    ["merge-tree", "--write-tree", "--stdin", "--allow-unrelated-histories"],
    {
      cwd: d,
      env: gitEnv,
      input: `${lines.join("\n")}\n`,
      maxBuffer: 1 << 28,
    },
  ).toString();
  const tok = out.split("\0");
  let at = 0;
  const next = () => {
    if (at >= tok.length) throw new Error("merge-tree output ended early");
    return tok[at++] as string;
  };
  const wrong: string[] = [];
  const kinds: string[] = [];
  for (const [i, dag] of dags.entries()) {
    const status = next();
    if (status !== "0" && status !== "1") throw new Error(`merge-tree: status ${status}`);
    const tree = next();
    const conflicts: ConflictEntry[] = [];
    const messages: MergeMessage[] = [];
    if (status === "0") {
      for (let t = next(); t !== ""; t = next()) {
        const m = /^(\d+) ([0-9a-f]{40}) (\d)\t(.*)$/s.exec(t);
        if (!m) throw new Error(`merge-tree: entry ${t}`);
        conflicts.push({
          mode: m[1] as string,
          oid: m[2] as string,
          stage: Number(m[3]) as 1 | 2 | 3,
          path: m[4] as string,
        });
      }
      for (let t = next(); t !== ""; t = next()) {
        const paths = Array.from({ length: Number(t) }, next);
        next();
        messages.push({ paths, text: next() });
      }
    } else if (next() !== "") throw new Error("merge-tree: a clean merge with more output");
    for (const m of messages) kinds.push(/^CONFLICT \(([^)]+)\)/.exec(m.text)?.[1] ?? "");
    const ids = all[i] as string[];
    const r = await mergeCommits(repo, ids[dag.ours] as string, ids[dag.theirs] as string, {
      ours: `o${i}`,
      theirs: `t/${i}`,
      legacyCompaction,
      legacyHashChars,
      legacyPathInWay,
      allowUnrelated: true,
    });
    const show = (x: {
      clean: boolean;
      tree: string;
      conflicts: ConflictEntry[];
      messages: MergeMessage[];
    }) =>
      JSON.stringify({
        clean: x.clean,
        tree: x.tree,
        conflicts: x.conflicts.map((e) => `${e.mode} ${e.oid} ${e.stage} ${e.path}`),
        messages: (x.clean ? [] : x.messages).map((e) => `[${e.paths.join(",")}] ${e.text.trim()}`),
      });
    const gs = show({ clean: status === "1", tree, conflicts, messages });
    const rs = show(r);
    if (gs !== rs) wrong.push(`${dag.name}\n  git:  ${gs}\n  ours: ${rs}`);
  }
  return { wrong, kinds };
}

const text = (tag: string, n = 10) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i} of the file\n`).join("");
const editLine = (s: string, k: number, to: string) => {
  const ls = s.split("\n");
  ls[k] = to;
  return ls.join("\n");
};
const keep: [string, string, string] = ["keep", "100644", "kept\n"];

/**
 * the classic criss-cross: R; A1, B1 from R; A2 = merge(A1, B1) and B2 = merge(B1, A1) with the
 * given trees; heads A3, B3. Merge bases of A3 and B3: A1 and B1
 */
function crissCross(
  name: string,
  t: Record<string, Files>,
  when = (k: number) => 1800000000 + k * 60,
): Dag {
  return {
    name,
    nodes: [
      { parents: [], files: t.R as Files, when: when(0) },
      { parents: [0], files: t.A1 as Files, when: when(1) },
      { parents: [0], files: t.B1 as Files, when: when(2) },
      { parents: [1, 2], files: t.A2 as Files, when: when(3) },
      { parents: [2, 1], files: t.B2 as Files, when: when(4) },
      { parents: [3], files: t.A3 as Files, when: when(5) },
      { parents: [4], files: t.B3 as Files, when: when(6) },
    ],
    ours: 5,
    theirs: 6,
  };
}

const A = text("alpha");
const handMade: Dag[] = [
  crissCross("clean recursive merge", {
    R: f([keep, ["a", "100644", A]]),
    A1: f([keep, ["a", "100644", editLine(A, 1, "A1")]]),
    B1: f([keep, ["a", "100644", editLine(A, 8, "B1")]]),
    A2: f([keep, ["a", "100644", editLine(editLine(A, 1, "A1"), 8, "B1")]]),
    B2: f([keep, ["a", "100644", editLine(editLine(A, 1, "A1"), 8, "B1")]]),
    A3: f([keep, ["a", "100644", editLine(editLine(editLine(A, 1, "A1"), 8, "B1"), 4, "A3")]]),
    B3: f([
      keep,
      ["a", "100644", editLine(editLine(A, 1, "A1"), 8, "B1")],
      ["b", "100644", text("b")],
    ]),
  }),
  crissCross("a conflict in the virtual base", {
    R: f([keep, ["a", "100644", A]]),
    A1: f([keep, ["a", "100644", editLine(A, 4, "A1")]]),
    B1: f([keep, ["a", "100644", editLine(A, 4, "B1")]]),
    A2: f([keep, ["a", "100644", editLine(A, 4, "A1")]]),
    B2: f([keep, ["a", "100644", editLine(A, 4, "B1")]]),
    A3: f([keep, ["a", "100644", editLine(editLine(A, 4, "A1"), 0, "A3")]]),
    B3: f([keep, ["a", "100644", editLine(editLine(A, 4, "B1"), 9, "B3")]]),
  }),
  crissCross("a binary conflict in the ancestors", {
    R: f([keep, ["bin", "100644", `\u0000${A}`]]),
    A1: f([keep, ["bin", "100644", `\u0000${A}A1`]]),
    B1: f([keep, ["bin", "100644", `\u0000${A}B1`]]),
    A2: f([keep, ["bin", "100644", `\u0000${A}A1`]]),
    B2: f([keep, ["bin", "100644", `\u0000${A}B1`]]),
    A3: f([keep, ["bin", "100644", `\u0000${A}A3`]]),
    B3: f([keep, ["bin", "100644", `\u0000${A}B1`]]),
  }),
  crissCross("a symlink conflict in the ancestors", {
    R: f([keep, ["l", "120000", "target"]]),
    A1: f([keep, ["l", "120000", "target-a"]]),
    B1: f([keep, ["l", "120000", "target-b"]]),
    A2: f([keep, ["l", "120000", "target-a"]]),
    B2: f([keep, ["l", "120000", "target-b"]]),
    A3: f([keep, ["l", "120000", "target-a"]]),
    B3: f([keep, ["l", "120000", "target-c"]]),
  }),
  crissCross("a modify/delete in the ancestors", {
    R: f([keep, ["a", "100644", A]]),
    A1: f([keep, ["a", "100644", editLine(A, 2, "A1")]]),
    B1: f([keep]),
    A2: f([keep, ["a", "100644", editLine(A, 2, "A1")]]),
    B2: f([keep]),
    A3: f([keep, ["a", "100644", editLine(A, 2, "A3")]]),
    B3: f([keep, ["b", "100644", text("b")]]),
  }),
  crissCross("renames in the ancestors", {
    R: f([keep, ["a", "100644", A]]),
    A1: f([keep, ["x/a", "100644", A]]),
    B1: f([keep, ["a", "100644", editLine(A, 5, "B1")]]),
    A2: f([keep, ["x/a", "100644", editLine(A, 5, "B1")]]),
    B2: f([keep, ["a", "100644", editLine(A, 5, "B1 again")]]),
    A3: f([keep, ["x/a", "100644", editLine(editLine(A, 5, "B1"), 0, "A3")]]),
    B3: f([keep, ["a", "100644", editLine(A, 5, "B1 again")]]),
  }),
  crissCross(
    "equal commit dates",
    {
      R: f([keep, ["a", "100644", A]]),
      A1: f([keep, ["a", "100644", editLine(A, 4, "A1")]]),
      B1: f([keep, ["a", "100644", editLine(A, 4, "B1")]]),
      A2: f([keep, ["a", "100644", editLine(A, 4, "A1")]]),
      B2: f([keep, ["a", "100644", editLine(A, 4, "B1")]]),
      A3: f([keep, ["a", "100644", editLine(A, 4, "A3")]]),
      B3: f([keep, ["a", "100644", editLine(A, 4, "B3")]]),
    },
    () => 1800000000,
  ),
];

/** three lines crossing: three merge bases, two levels of virtual commits */
handMade.push({
  name: "three merge bases",
  nodes: [
    { parents: [], files: f([keep, ["a", "100644", A]]), when: 1800000000 },
    { parents: [0], files: f([keep, ["a", "100644", editLine(A, 1, "P")]]), when: 1800000060 },
    { parents: [0], files: f([keep, ["a", "100644", editLine(A, 5, "Q")]]), when: 1800000120 },
    { parents: [0], files: f([keep, ["a", "100644", editLine(A, 9, "S")]]), when: 1800000180 },
    {
      parents: [1, 2, 3],
      files: f([keep, ["a", "100644", editLine(editLine(editLine(A, 1, "P"), 5, "Q"), 9, "S")]]),
      when: 1800000240,
    },
    {
      parents: [2, 3, 1],
      files: f([keep, ["a", "100644", editLine(editLine(editLine(A, 1, "P2"), 5, "Q"), 9, "S")]]),
      when: 1800000300,
    },
  ],
  ours: 4,
  theirs: 5,
});

/** random histories: 2–3 lines, commits and cross merges, file edits on top of the first parent */
function dagCorpus(n: number, seed: number, { sameDates = false } = {}): Dag[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const names = ["a", "b", "c", "d/e", "d/f"];
  let uid = 0;
  const content = () =>
    Array.from({ length: 8 }, (_, i) => `line ${seed}-${uid++} ${i}`).join("\n") + "\n";
  const edit = (s: string) => {
    const ls = s.split("\n");
    ls[Math.floor(rand() * (ls.length - 1))] = `edited ${uid++}`;
    return ls.join("\n");
  };
  const mutate = (m: Files): Files => {
    const out: Files = new Map(m);
    const ops = 1 + Math.floor(rand() * 2);
    for (let k = 0; k < ops; k++) {
      const keys = [...out.keys()].filter((p) => p !== "keep");
      const r = rand();
      if (r < 0.6 && keys.length) {
        const p = pick(keys);
        const [mode, c] = out.get(p) as [string, string];
        out.set(p, [mode, edit(c)]);
      } else if (r < 0.75 && keys.length) out.delete(pick(keys));
      else {
        const p = pick(names);
        if (!out.has(p)) out.set(p, ["100644", content()]);
      }
    }
    return out;
  };
  const dags: Dag[] = [];
  for (let i = 0; i < n; i++) {
    let t = 1800000000;
    const when = () => {
      if (sameDates) return 1800000000;
      t += 60 + Math.floor(rand() * 600);
      return t;
    };
    const nodes: Node[] = [
      {
        parents: [],
        files: f([keep, ["a", "100644", content()], ["b", "100644", content()]]),
        when: when(),
      },
    ];
    const lines = 2 + Math.floor(rand() * 2);
    const heads = Array.from({ length: lines }, () => {
      nodes.push({ parents: [0], files: mutate(nodes[0]?.files as Files), when: when() });
      return nodes.length - 1;
    });
    const steps = 3 + Math.floor(rand() * 5);
    for (let s = 0; s < steps; s++) {
      const li = Math.floor(rand() * lines);
      const head = heads[li] as number;
      if (rand() < 0.5) {
        const lj = (li + 1 + Math.floor(rand() * (lines - 1))) % lines;
        const other = heads[lj] as number;
        // a merge commit: the first parent's files, partly the other's, edited
        const files: Files = new Map(nodes[head]?.files);
        for (const [p, v] of (nodes[other] as Node).files) if (rand() < 0.5) files.set(p, v);
        nodes.push({
          parents: [head, other],
          files: rand() < 0.5 ? mutate(files) : files,
          when: when(),
        });
      } else
        nodes.push({ parents: [head], files: mutate(nodes[head]?.files as Files), when: when() });
      heads[li] = nodes.length - 1;
    }
    dags.push({ name: `#${i}`, nodes, ours: heads[0] as number, theirs: heads[1] as number });
  }
  return dags;
}

describe("C1 merge bases", () => {
  it("500 random histories: git merge-base --all, in git's order", async () => {
    const r = await compareBases([
      ...dagCorpus(300, 707),
      ...dagCorpus(200, 708, { sameDates: true }),
      ...handMade,
    ]);
    expect(r.wrong.slice(0, 3)).toEqual([]);
    expect(r.wrong.length).toBe(0);
    expect(r.multiple).toBeGreaterThan(50);
  }, 300_000);
});

describe("C2–C3 recursive merges", () => {
  it("C2: hand-made criss-cross merges", async () => {
    const r = await compareMerges(handMade);
    expect(r.wrong).toEqual([]);
  });

  it("C3: 500 random histories", async () => {
    const r = await compareMerges([
      ...dagCorpus(300, 809),
      ...dagCorpus(200, 810, { sameDates: true }),
    ]);
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 900_000);
});

describe("C5 portable", () => {
  it("33-criss-cross/src has no node: imports", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of readdirSync(src))
      expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/from "node:/);
  });
});
