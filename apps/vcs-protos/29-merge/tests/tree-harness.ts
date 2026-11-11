import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { writeTree } from "../../17-repository/src/commands.js";
import { encodeCommit, type TreeEntry } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import {
  type ConflictEntry,
  type MergeMessage,
  mergeTrees,
  type TreeMergeOptions,
  type TreeMergeResult,
} from "../src/merge-trees.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const enc = new TextEncoder();
const who = { name: "A", email: "a@example.com", when: 1800000000, tz: "+0000" };
const gitVersion = execFileSync("git", ["--version"], { env: gitEnv })
  .toString()
  .match(/(\d+)\.(\d+)/)
  ?.slice(1)
  .map(Number) ?? [0, 0];
export const legacyCompaction = (gitVersion[0] as number) * 1000 + (gitVersion[1] as number) < 2054;
/**
 * Whether this git's ort honours `-Xno-renames` (2.43's ignores it): a rename on one side and an
 * edit on the other merge cleanly only with rename detection.
 */
/** whether this git drops the bytes after a file's last LF from similarity (X13c's probe) */
export const legacyHashChars = (() => {
  const d = mkdtempSync(join(tmpdir(), "x13d-probe-"));
  dirs.push(d);
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: d, env: gitEnv, input }).toString().trim();
  git(["init", "-q", "--bare"]);
  const a = git(["hash-object", "-w", "--stdin"], "aaaa\nbbbb\ncccc");
  const b = git(["hash-object", "-w", "--stdin"], "aaaa\nxxxx\ncccc");
  const ta = git(["mktree"], `100644 blob ${a}\tone\n`);
  const tb = git(["mktree"], `100644 blob ${b}\ttwo\n`);
  const out = git(["diff-tree", "-r", "-M20%", ta, tb]);
  if (/R035/.test(out)) return true;
  if (/R064/.test(out)) return false;
  throw new Error(`unexpected similarity probe: ${out}`);
})();
export const ortHonorsNoRenames = (() => {
  const d = mkdtempSync(join(tmpdir(), "x13b-probe-"));
  dirs.push(d);
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: d, env: gitEnv, input }).toString().trim();
  git(["init", "-q", "--bare"]);
  const text = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("");
  const a = git(["hash-object", "-w", "--stdin"], text);
  const a2 = git(["hash-object", "-w", "--stdin"], `${text}more\n`);
  const tree = (name: string, oid: string) => git(["mktree"], `100644 blob ${oid}\t${name}\n`);
  const commit = (t: string, parent?: string) =>
    git(["commit-tree", t, "-m", "x", ...(parent ? ["-p", parent] : [])]);
  const base = commit(tree("a", a));
  const ours = commit(tree("b", a), base);
  const theirs = commit(tree("a", a2), base);
  try {
    git(["merge-tree", "--write-tree", "-Xno-renames", ours, theirs]);
    return false;
  } catch {
    return true;
  }
})();

/** a side: path → [mode, content] */
export type Files = Map<string, [string, string]>;

export async function writeFilesWithModes(repo: Repository, files: Files): Promise<string> {
  type Dir = Map<string, Dir | [string, string]>;
  const root: Dir = new Map();
  for (const [path, v] of files) {
    const parts = path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      let next = dir.get(p);
      if (!next) {
        next = new Map();
        dir.set(p, next);
      }
      if (!(next instanceof Map)) throw new Error(`${path} under a file`);
      dir = next;
    }
    dir.set(parts[parts.length - 1] as string, v);
  }
  const write = async (dir: Dir): Promise<string> => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of dir) {
      if (v instanceof Map) entries.push({ mode: "40000", name, oid: await write(v) });
      else
        entries.push({ mode: v[0], name, oid: await repo.objects.put("blob", enc.encode(v[1])) });
    }
    return writeTree(repo, entries);
  };
  return write(root);
}

export interface Case {
  name: string;
  base: Files;
  ours: Files;
  theirs: Files;
}
/** `{O}` and `{T}` in paths stand for the case's branch names as `path~<branch>` spells them */
export const branchesOf = (i: number) => ({ ours: `o${i}`, theirs: `t/${i}` });
const withBranches = (files: Files, i: number): Files =>
  new Map(
    [...files].map(([p, v]) => [p.replaceAll("{O}", `o${i}`).replaceAll("{T}", `t_${i}`), v]),
  );
interface GitTreeResult {
  clean: boolean;
  tree: string;
  conflicts: ConflictEntry[];
  messages: MergeMessage[];
}

/** merges each case with `git merge-tree` (branches `o<i>` and `t/<i>`) and with mergeTrees */
export type MergeFn = (
  repo: Repository,
  base: string | undefined,
  ours: string,
  theirs: string,
  opts: TreeMergeOptions,
) => Promise<TreeMergeResult>;

export async function compareTrees(
  cases: Case[],
  {
    unrelated = false,
    noRenames = true,
    merge = mergeTrees,
  }: { unrelated?: boolean; noRenames?: boolean; merge?: MergeFn } = {},
) {
  const d = mkdtempSync(join(tmpdir(), "x13b-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", "--bare", d], { env: gitEnv });
  const repo = await filesRepository(new StreamingNodeFilesApi(d), nodeRefFiles(d));
  const lines: string[] = [];
  const meta: { base: string; ours: string; theirs: string; oc: string; tc: string }[] = [];
  for (const [i, c] of cases.entries()) {
    const base = await writeFilesWithModes(repo, withBranches(c.base, i));
    const ours = await writeFilesWithModes(repo, withBranches(c.ours, i));
    const theirs = await writeFilesWithModes(repo, withBranches(c.theirs, i));
    const commit = (tree: string, parents: string[], m: string) =>
      repo.objects.put(
        "commit",
        encodeCommit({ tree, parents, author: who, committer: who, message: m }),
      );
    const bc = await commit(base, [], `base ${i}\n`);
    const oc = await commit(ours, unrelated ? [] : [bc], `ours ${i}\n`);
    const tc = await commit(theirs, unrelated ? [] : [bc], `theirs ${i}\n`);
    const b = branchesOf(i);
    execFileSync("git", ["update-ref", `refs/heads/${b.ours}`, oc], { cwd: d, env: gitEnv });
    execFileSync("git", ["update-ref", `refs/heads/${b.theirs}`, tc], { cwd: d, env: gitEnv });
    lines.push(`${b.ours} ${b.theirs}`);
    meta.push({ base, ours, theirs, oc, tc });
  }
  const args = ["merge-tree", "--write-tree", "--stdin"];
  if (noRenames) args.push("-Xno-renames");
  if (unrelated) args.push("--allow-unrelated-histories");
  const out = execFileSync("git", args, {
    cwd: d,
    env: gitEnv,
    input: `${lines.join("\n")}\n`,
    maxBuffer: 1 << 28,
  }).toString();
  const tok = out.split("\0");
  let at = 0;
  const next = () => {
    if (at >= tok.length) throw new Error("merge-tree output ended early");
    return tok[at++] as string;
  };
  const results: GitTreeResult[] = [];
  for (let k = 0; k < cases.length; k++) {
    const status = next();
    if (status !== "0" && status !== "1") throw new Error(`merge-tree: status ${status}`);
    const tree = next();
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`merge-tree: tree ${tree}`);
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
        const n = Number(t);
        const paths = Array.from({ length: n }, next);
        next(); // the message type
        messages.push({ paths, text: next() });
      }
    } else if (next() !== "") throw new Error("merge-tree: a clean merge with more output");
    results.push({ clean: status === "1", tree, conflicts, messages });
  }
  const wrong: string[] = [];
  for (const [i, c] of cases.entries()) {
    const m = meta[i] as (typeof meta)[number];
    const g = results[i] as GitTreeResult;
    const r = await merge(repo, unrelated ? undefined : m.base, m.ours, m.theirs, {
      ...branchesOf(i),
      legacyCompaction,
      detectRenames: !(noRenames && ortHonorsNoRenames),
      legacyHashChars,
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
        conflicts: x.conflicts.map((e) => `${e.mode} ${e.oid.slice(0, 7)} ${e.stage} ${e.path}`),
        // merge-tree prints no messages for a clean merge
        messages: (x.clean ? [] : x.messages).map((e) => `[${e.paths.join(",")}] ${e.text.trim()}`),
      });
    const gs = show(g);
    const rs = show(r);
    if (gs !== rs)
      wrong.push(
        `${c.name}\n  git:  ${gs}\n  ours: ${rs}\n  base ${JSON.stringify([...c.base])}\n  ours ${JSON.stringify([...c.ours])}\n  theirs ${JSON.stringify([...c.theirs])}`,
      );
  }
  return {
    wrong,
    kinds: results.flatMap((g) =>
      g.messages.map((e) => /^CONFLICT \(([^)]+)\)/.exec(e.text)?.[1] ?? ""),
    ),
  };
}

export function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

/** random trees over a small universe of paths: files, executables, symlinks; dirs replaced by files and back */
export function corpus(
  n: number,
  seed: number,
  { names = ["a", "b", "c", "d"], fanout = 1 }: { names?: string[]; fanout?: number } = {},
): Case[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const randomPath = () => {
    const depth = 1 + Math.floor(rand() * 3);
    return Array.from({ length: depth }, () => pick(names)).join("/");
  };
  // new files get content of their own: a deleted file's content never reappears elsewhere, so
  // git detects no renames (merge-tree in git 2.43 ignores -Xno-renames)
  let uid = 0;
  const content = () => `fresh ${seed}-${uid++}\n`;
  /** an edit of an existing file: lines shared with its base, for content merges */
  const edited = (c: string) => {
    const lines = c.split("\n").filter(Boolean);
    const ls = lines.length < 3 ? [...lines, "two", "three"] : [...lines];
    const k = Math.floor(rand() * ls.length);
    ls[k] = rand() < 0.5 ? `${ls[k]} edited ${uid++}` : (ls[k] as string);
    if (rand() < 0.3) ls.splice(k, 0, `inserted ${uid++}`);
    return `${ls.join("\n")}\n`;
  };
  const mode = () => (rand() < 0.75 ? "100644" : rand() < 0.6 ? "100755" : "120000");
  /** adds `path` unless it collides with a file/directory already there */
  const put = (f: Files, path: string, v: [string, string]) => {
    for (const p of f.keys()) if (p.startsWith(`${path}/`) || path.startsWith(`${p}/`)) return;
    f.set(path, v);
  };
  const mutate = (base: Files): Files => {
    const f = new Map(base);
    const ops = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < ops; k++) {
      const keys = [...f.keys()];
      const r = rand();
      if (r < 0.3 && keys.length) {
        const p = pick(keys);
        const [m, c] = f.get(p) as [string, string];
        f.set(p, [m, edited(c)]);
      } else if (r < 0.45 && keys.length) f.delete(pick(keys));
      else if (r < 0.55 && keys.length) {
        const p = pick(keys);
        const [m, c] = f.get(p) as [string, string];
        f.set(p, [m === "100644" ? "100755" : m === "100755" ? "100644" : "100644", c]);
      } else if (r < 0.7 && keys.length) {
        // a file becomes a directory, or the reverse
        const p = pick(keys);
        f.delete(p);
        const k = 1 + Math.floor(rand() * fanout);
        for (let j = 0; j < k; j++)
          put(f, `${p}/${pick(names)}${fanout > 1 ? j : ""}`, [mode(), content()]);
      } else if (r < 0.8 && keys.length) {
        const p = pick(keys);
        const parent = p.split("/").slice(0, -1).join("/");
        if (parent) {
          for (const q of [...f.keys()]) if (q.startsWith(`${parent}/`)) f.delete(q);
          put(f, parent, [mode(), content()]);
        }
      } else put(f, randomPath(), [mode(), content()]);
    }
    return f;
  };
  const cases: Case[] = [];
  for (let i = 0; i < n; i++) {
    const base: Files = new Map();
    const count = Math.floor(rand() * 6);
    for (let k = 0; k < count; k++) put(base, randomPath(), [mode(), content()]);
    cases.push({ name: `#${i}`, base, ours: mutate(base), theirs: mutate(base) });
  }
  return cases;
}

/** a symlink in the base that both sides turn into regular files */
export const f = (entries: [string, string, string][]): Files =>
  new Map(entries.map(([p, m, c]) => [p, [m, c]] as [string, [string, string]]));
export const handMade: Case[] = [
  {
    // K2: three modes; K3: base of another type, so a two-way content merge
    name: "symlink → 100644 / 100755, different content",
    base: f([["x", "120000", "target\n"]]),
    ours: f([["x", "100644", "one\ntwo\nours\n"]]),
    theirs: f([["x", "100755", "one\ntwo\ntheirs\n"]]),
  },
  {
    name: "symlink → regular files, both 100644, mergeable content",
    base: f([["x", "120000", "one\ntwo\nthree\n"]]),
    ours: f([["x", "100644", "one\ntwo\nthree\nfour\n"]]),
    theirs: f([["x", "100644", "zero\none\ntwo\nthree\n"]]),
  },
  {
    name: "symlink → 100644 / 100755, same content",
    base: f([["x", "120000", "target\n"]]),
    ours: f([["x", "100644", "same\n"]]),
    theirs: f([["x", "100755", "same\n"]]),
  },
];

/** cases from the review of #95 (see README) */
export const reviewCases: Case[] = [
  {
    // unique_path checks every path any side has: a directory x~O only the base and theirs have
    name: "a moved file's name skips a directory the merge deletes",
    base: f([
      ["x", "100644", "x base\n"],
      ["x~{O}/f", "100644", "xo f\n"],
      ["z", "100644", "z\n"],
    ]),
    ours: f([
      ["x", "100644", "x base\nours\n"],
      ["z", "100644", "z\n"],
    ]),
    theirs: f([
      ["x/g", "100644", "xg new\n"],
      ["x~{O}/f", "100644", "xo f\n"],
      ["z", "100644", "z\n"],
    ]),
  },
  {
    // the deferred directory P triples the paths: ort redoes the collection with the deletions
    // known, and resolves P whole (no file/directory message)
    name: "ort's redo after renames",
    base: f([
      ["P", "100644", "p base\n"],
      ["M", "100644", "m base\n"],
    ]),
    ours: f([
      ["P", "100644", "p base\n"],
      ["M", "100644", "m base\nours\n"],
    ]),
    theirs: f(
      [0, 1, 2, 3].map((k) => [`P/f${k}`, "100644", `p new ${k}\n`] as [string, string, string]),
    ),
  },
  {
    name: "conflicts and messages in byte order (a character past U+FFFF)",
    base: f([
      ["\uff5e", "100644", "one\n"],
      ["\u{1f600}", "100644", "two\n"],
    ]),
    ours: f([["\uff5e", "100644", "one\nours\n"]]),
    theirs: f([["\u{1f600}", "100644", "two\ntheirs\n"]]),
  },
  {
    name: "a legacy mode (100664) is written as 100644",
    base: f([
      ["a", "100664", "a\n"],
      ["b", "100644", "b\n"],
    ]),
    ours: f([
      ["a", "100664", "a\n"],
      ["b", "100644", "b ours\n"],
    ]),
    theirs: f([
      ["a", "100664", "a\n"],
      ["b", "100644", "b theirs\n"],
    ]),
  },
];
