import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { writeTree } from "../../17-repository/src/commands.js";
import type { TreeEntry } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { type DiffEntry, diffTrees, type RenameOptions, spanHashes } from "../src/renames.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** path → [mode, content] */
type Files = Map<string, [string, string | Uint8Array]>;
const enc = new TextEncoder();

async function writeFiles(repo: Repository, files: Files): Promise<string> {
  type Dir = Map<string, Dir | [string, string | Uint8Array]>;
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
      else {
        const body = typeof v[1] === "string" ? enc.encode(v[1]) : v[1];
        entries.push({ mode: v[0], name, oid: await repo.objects.put("blob", body) });
      }
    }
    return writeTree(repo, entries);
  };
  return write(root);
}

interface Case {
  name: string;
  a: Files;
  b: Files;
  /** git's -M<score>% (default 50) */
  score?: number;
  /** git's -l<n> */
  limit?: number;
  renameEmpty?: boolean;
}

/**
 * Whether this git drops the bytes after a file's last LF from similarity (2.43 does, 2.56 counts
 * them): "aaaa\nxxxx\ncccc" against "aaaa\nbbbb\ncccc" scores 35% without "cccc", 64% with it.
 */
const legacyHashChars = (() => {
  const d = mkdtempSync(join(tmpdir(), "x13c-probe-"));
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

const show = (e: DiffEntry) =>
  `${e.oldMode} ${e.newMode} ${e.oldOid} ${e.newOid} ${e.status}${e.score ?? ""} ${e.oldPath}${e.newPath !== e.oldPath ? ` ${e.newPath}` : ""}`;

function parseRaw(out: string): DiffEntry[] {
  const tok = out.split("\0");
  const res: DiffEntry[] = [];
  let at = 0;
  while (at < tok.length && tok[at] !== "") {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])(\d*)$/.exec(
      tok[at++] as string,
    );
    if (!m) throw new Error(`diff-tree: ${tok[at - 1]}`);
    const status = m[5] as DiffEntry["status"];
    const oldPath = tok[at++] as string;
    const newPath = status === "R" || status === "C" ? (tok[at++] as string) : oldPath;
    res.push({
      status,
      score: m[6] ? Number(m[6]) : undefined,
      oldMode: m[1] as string,
      newMode: m[2] as string,
      oldOid: m[3] as string,
      newOid: m[4] as string,
      oldPath,
      newPath,
    });
  }
  return res;
}

async function compare(cases: Case[]) {
  const d = mkdtempSync(join(tmpdir(), "x13c-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", "--bare", d], { env: gitEnv });
  const repo = await filesRepository(new StreamingNodeFilesApi(d), nodeRefFiles(d));
  const wrong: string[] = [];
  let renames = 0;
  for (const c of cases) {
    const a = await writeFiles(repo, c.a);
    const b = await writeFiles(repo, c.b);
    const args = ["diff-tree", "-r", "--raw", "-z", `-M${c.score ?? 50}%`];
    if (c.limit !== undefined) args.push(`-l${c.limit}`);
    if (c.renameEmpty === false) args.push("--no-rename-empty");
    const git = parseRaw(execFileSync("git", [...args, a, b], { cwd: d, env: gitEnv }).toString());
    const opts: RenameOptions = {
      score: c.score ?? 50,
      limit: c.limit ?? 1000,
      renameEmpty: c.renameEmpty ?? true,
      legacyHashChars,
    };
    const ours = await diffTrees(repo, a, b, opts);
    renames += git.filter((e) => e.status === "R").length;
    const gs = git.map(show).join("\n    ");
    const os = ours.map(show).join("\n    ");
    if (gs !== os) wrong.push(`${c.name}\n  git:\n    ${gs}\n  ours:\n    ${os}`);
  }
  return { wrong, renames };
}

const f = (entries: [string, string, string | Uint8Array][]): Files =>
  new Map(entries.map(([p, m, c]) => [p, [m, c]]));
const lines = (n: number, tag = "line") =>
  Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join("");

describe("R1 hand-made rename cases, as git diff-tree -r -M", () => {
  const body = lines(20);
  const cases: Case[] = [
    {
      name: "exact rename",
      a: f([["a/x.txt", "100644", body]]),
      b: f([["b/y.txt", "100644", body]]),
    },
    {
      name: "identical sources: same basename wins, then the first",
      a: f([
        ["p/one", "100644", body],
        ["q/two", "100644", body],
        ["r/two", "100644", body],
      ]),
      b: f([
        ["s/two", "100644", body],
        ["t/zzz", "100644", body],
        ["u/yyy", "100644", body],
      ]),
    },
    {
      name: "exact symlink rename; a symlink against a regular file is no exact rename",
      a: f([
        ["l1", "120000", "target"],
        ["l2", "120000", "other target"],
      ]),
      b: f([
        ["m1", "120000", "target"],
        ["m2", "100644", "other target"],
      ]),
    },
    {
      name: "just above and below 50%",
      a: f([
        ["above", "100644", lines(10)],
        ["below", "100644", lines(10, "other")],
      ]),
      b: f([
        ["above2", "100644", `${lines(5)}${lines(4, "new")}`],
        ["below2", "100644", `${lines(4, "other")}${lines(6, "fresh")}`],
      ]),
    },
    {
      name: "a unique basename is taken before a better candidate",
      a: f([["src/util.ts", "100644", lines(40)]]),
      b: f([
        ["lib/util.ts", "100644", `${lines(32)}${lines(8, "x")}`],
        ["lib/other.ts", "100644", `${lines(40)}extra\n`],
      ]),
    },
    {
      name: "sizes too far apart",
      a: f([["small", "100644", lines(4)]]),
      b: f([["big", "100644", lines(40)]]),
    },
    {
      name: "binary files",
      a: f([
        ["bin1", "100644", new Uint8Array([0, 1, 2, 3, 10, 4, 5, 6, 10, 7, 8, 9, 10, 0, 0, 0])],
      ]),
      b: f([
        ["bin2", "100644", new Uint8Array([0, 1, 2, 3, 10, 4, 5, 6, 10, 7, 8, 9, 10, 0, 0, 1])],
      ]),
    },
    {
      name: "CRLF against LF",
      a: f([["crlf", "100644", lines(10).replaceAll("\n", "\r\n")]]),
      b: f([["lf", "100644", lines(10)]]),
    },
    {
      name: "lines longer than 64 bytes",
      a: f([["long", "100644", `${"x".repeat(200)}\n${"y".repeat(130)}\n`]]),
      b: f([["long2", "100644", `${"x".repeat(200)}\n${"y".repeat(129)}z\n`]]),
    },
    {
      name: "empty files",
      a: f([
        ["e1", "100644", ""],
        ["keep", "100644", body],
      ]),
      b: f([
        ["e2", "100644", ""],
        ["keep", "100644", body],
      ]),
    },
    {
      name: "empty files, --no-rename-empty",
      a: f([["e1", "100644", ""]]),
      b: f([["e2", "100644", ""]]),
      renameEmpty: false,
    },
    {
      name: "a type change is neither a source nor a destination",
      a: f([
        ["t", "100644", "target"],
        ["gone", "100644", body],
      ]),
      b: f([
        ["t", "120000", "target"],
        ["new", "100644", body],
      ]),
    },
    {
      name: "a mode change rename",
      a: f([["run.sh", "100644", body]]),
      b: f([["bin/run.sh", "100755", body]]),
    },
  ];
  it("each case equal to git", async () => {
    const r = await compare(cases);
    expect(r.wrong).toEqual([]);
  });
});

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

/** random trees and a second version: moves with edits, duplicates, shared basenames */
function corpus(n: number, seed: number, opts: { limits?: boolean } = {}): Case[] {
  const rand = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const dirsN = ["", "a/", "b/", "a/c/", "d/"];
  const basenames = ["x.ts", "y.ts", "z.md", "util.ts", "Makefile", "w"];
  const vocab = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta", "iota", "kappa"];
  let uid = 0;
  const content = () => {
    const n = Math.floor(rand() * 30);
    const ls = Array.from({ length: n }, () =>
      rand() < 0.5 ? `${pick(vocab)} ${pick(vocab)}` : `unique ${seed}-${uid++} ${pick(vocab)}`,
    );
    if (rand() < 0.1) ls.push("x".repeat(70 + Math.floor(rand() * 100)));
    // 40% without a final newline: git 2.56 counts the bytes after the last LF, 2.43 drops them
    let s = ls.join("\n") + (n && rand() < 0.6 ? "\n" : "");
    if (rand() < 0.05) s = s.replaceAll("\n", "\r\n");
    return s;
  };
  const edit = (s: string) => {
    const ls = s.split("\n");
    const k = Math.floor(rand() * 4);
    for (let i = 0; i < k; i++) {
      const at = Math.floor(rand() * (ls.length + 1));
      const r = rand();
      if (r < 0.4) ls.splice(at, 0, `added ${uid++}`);
      else if (r < 0.7) ls.splice(at, 1);
      else if (ls.length) ls[at % ls.length] = `changed ${uid++}`;
    }
    return ls.join("\n");
  };
  const mode = () => (rand() < 0.85 ? "100644" : rand() < 0.7 ? "100755" : "120000");
  const cases: Case[] = [];
  for (let i = 0; i < n; i++) {
    const a: Files = new Map();
    const count = 1 + Math.floor(rand() * 8);
    const usedDirs = new Set<string>();
    const freePath = (m: Files) => {
      for (let t = 0; t < 20; t++) {
        const p = `${pick(dirsN)}${pick(basenames)}${rand() < 0.3 ? uid++ : ""}`;
        if (!m.has(p) && ![...m.keys()].some((q) => q.startsWith(`${p}/`) || p.startsWith(`${q}/`)))
          return p;
      }
      return `u${uid++}`;
    };
    for (let k = 0; k < count; k++) {
      const p = freePath(a);
      usedDirs.add(p);
      a.set(p, [
        mode(),
        rand() < 0.15 && a.size ? (pick([...a.values()])[1] as string) : content(),
      ]);
    }
    const b: Files = new Map(a);
    const ops = 1 + Math.floor(rand() * 5);
    for (let k = 0; k < ops; k++) {
      const keys = [...b.keys()];
      const r = rand();
      if (r < 0.45 && keys.length) {
        // move, maybe edited
        const p = pick(keys);
        const [m, c] = b.get(p) as [string, string];
        b.delete(p);
        const q = freePath(b);
        b.set(q, [rand() < 0.1 ? (m === "100644" ? "100755" : m) : m, rand() < 0.6 ? edit(c) : c]);
      } else if (r < 0.6 && keys.length) {
        const p = pick(keys);
        const [m, c] = b.get(p) as [string, string];
        b.set(p, [m, edit(c)]);
      } else if (r < 0.7 && keys.length) b.delete(pick(keys));
      else if (r < 0.8 && keys.length) {
        // a copy of existing content at a new path
        const q = freePath(b);
        b.set(q, [mode(), pick([...b.values()])[1] as string]);
      } else b.set(freePath(b), [mode(), content()]);
    }
    const score = rand() < 0.5 ? 50 : pick([20, 30, 40, 60, 75, 90, 100]);
    const c: Case = { name: `#${i}`, a, b, score };
    if (opts.limits) {
      c.limit = pick([1, 2, 3, 5]);
      c.renameEmpty = false;
    }
    cases.push(c);
  }
  return cases;
}

describe("R2/R3 random diffs", () => {
  it("R2: 1000 random tree diffs equal to git", async () => {
    const r = await compare(corpus(1000, 31));
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
    expect(r.renames).toBeGreaterThan(500);
  }, 600_000);

  it("R3: --no-rename-empty and small rename limits, 300 diffs", async () => {
    const r = await compare(corpus(300, 32, { limits: true }));
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
    expect(r.renames).toBeGreaterThan(50);
  }, 300_000);
});

describe("R5 cases for mutants the corpora missed", () => {
  const T = lines(40, "shared");
  const variant = (k: number, n = 3) => `${T}${lines(n, `own${k}`)}`;
  const cases: Case[] = [
    {
      // C6: a chunk the destination repeats counts once per copy in the source
      name: "repeated lines in the destination",
      a: f([["src", "100644", `${lines(6)}${"rep\n".repeat(4)}`]]),
      b: f([["dst", "100644", `${lines(6)}${"rep\n".repeat(12)}`]]),
    },
    {
      // C10: a basename two sources share is not paired in the basename pass; the matrix takes
      // the better source
      name: "a shared source basename: the better source wins in the matrix",
      a: f([
        ["a/x.txt", "100644", `${T}${lines(9, "a")}`],
        ["b/x.txt", "100644", `${T}${lines(2, "b")}`],
      ]),
      b: f([["c/x.txt", "100644", `${T}${lines(2, "b")}${lines(1, "new")}`]]),
    },
    {
      // C11: each destination keeps 4 candidates; when the 4 go to better destinations, the
      // fifth source is not considered
      name: "a fifth candidate is not kept",
      a: f([1, 2, 3, 4, 5].map((k) => [`s${k}`, "100644", variant(k)] as [string, string, string])),
      b: f([
        ["d0", "100644", `${T}${lines(3, "zero")}`],
        ...[1, 2, 3, 4].map(
          (k) => [`d${k}`, "100644", `${variant(k)}tail\n`] as [string, string, string],
        ),
      ]),
    },
    {
      // C12: equal scores, the source with the destination's basename first
      name: "a tie broken by the basename",
      a: f([
        ["a/z", "100644", `${T}p1\n`],
        ["b/y", "100644", `${T}q1\n`],
        ["c/y", "100644", lines(30, "unrelated")],
      ]),
      b: f([["d/y", "100644", `${T}r1\n`]]),
    },
    {
      // C15: binary content keeps its CRs; text drops a CR before LF
      name: "binary files with CRLF inside",
      a: f([
        [
          "b1",
          "100644",
          new Uint8Array([
            0,
            ...Array.from({ length: 30 }, (_, i) => [65 + (i % 26), 13, 10]).flat(),
          ]),
        ],
      ]),
      b: f([
        [
          "b2",
          "100644",
          new Uint8Array([0, ...Array.from({ length: 30 }, (_, i) => [65 + (i % 26), 10]).flat()]),
        ],
      ]),
    },
  ];
  it("each case equal to git", async () => {
    const r = await compare(cases);
    expect(r.wrong).toEqual([]);
  });
});

describe("R6 cases from the review", () => {
  const body = lines(20);
  it("legacy modes are canonical, as git's canon_mode", async () => {
    const r = await compare([
      {
        name: "exact rename of a 100664 file",
        a: f([["p", "100664", body]]),
        b: f([["q", "100664", body]]),
      },
      {
        name: "100664 to 100644 is no change",
        a: f([["p", "100664", body]]),
        b: f([["p", "100644", body]]),
      },
      {
        name: "inexact rename of a 100664 file",
        a: f([["p", "100664", body]]),
        b: f([["q", "100644", `${body}more\n`]]),
      },
    ]);
    expect(r.wrong).toEqual([]);
  });

  it("files without a final newline", async () => {
    const r = await compare([
      {
        name: "the bytes after the last LF",
        a: f([["old.txt", "100644", `aaa\nbbb\n${"x".repeat(40)}`]]),
        b: f([["new.txt", "100644", `ccc\nddd\n${"x".repeat(40)}`]]),
      },
    ]);
    expect(r.wrong).toEqual([]);
  });

  it("hash_chars counts the bytes after the last chunk, except in legacy mode (git 2.43)", () => {
    const data = new TextEncoder().encode("ab\ncd");
    expect([...spanHashes(data).count].sort()).toEqual([2, 3]);
    expect([...spanHashes(data, true).count]).toEqual([3]);
  });
});

describe("R4 portable", () => {
  it("src/ has no node: imports", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    for (const file of readdirSync(src))
      expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/from "node:/);
  });
});
