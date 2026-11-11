import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { StreamingNodeFilesApi } from "../../09-git-objects/src/node-streaming-files.js";
import { nodeRefFiles } from "../../10-ref-transactions/src/adapters/node.js";
import { gitEnv } from "../../12-index-pack/src/git-repo.js";
import { readTree, writeFiles } from "../../17-repository/src/commands.js";
import { encodeCommit } from "../../17-repository/src/git-format.js";
import type { Repository } from "../../17-repository/src/object-store.js";
import { filesRepository } from "../../17-repository/src/repository.js";
import { XdiffLimitError } from "../src/xdiff.js";
import { type Merge, mergeContent, simplifyNonConflicts } from "../src/xmerge.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const enc = new TextEncoder();
const dec = new TextDecoder();
const who = { name: "A", email: "a@example.com", when: 1800000000, tz: "+0000" };

async function bareRepo() {
  const d = mkdtempSync(join(tmpdir(), "x13-"));
  dirs.push(d);
  execFileSync("git", ["init", "-q", "--bare", d], { env: gitEnv });
  return { d, repo: await filesRepository(new StreamingNodeFilesApi(d), nodeRefFiles(d)) };
}
async function commitOf(
  repo: Repository,
  files: Record<string, Uint8Array>,
  parents: string[],
  message: string,
) {
  const tree = await writeFiles(repo, files);
  return repo.objects.put(
    "commit",
    encodeCommit({ tree, parents, author: who, committer: who, message }),
  );
}
async function blob(repo: Repository, oid: string): Promise<Uint8Array> {
  const o = await repo.objects.get(oid);
  if (!o) throw new Error(`missing ${oid}`);
  const parts: Uint8Array[] = [];
  for await (const c of o.content) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

interface Case {
  name: string;
  base: Uint8Array;
  ours: Uint8Array;
  theirs: Uint8Array;
}
interface GitResult {
  clean: boolean;
  tree: string;
}

/** every case as base → (ours, theirs) commits on file `f`; one `git merge-tree --stdin` */
async function gitMerges(cases: Case[]) {
  const { d, repo } = await bareRepo();
  const lines: string[] = [];
  const pairs: { ours: string; theirs: string }[] = [];
  for (const [i, c] of cases.entries()) {
    const base = await commitOf(repo, { f: c.base }, [], `base ${i}\n`);
    const ours = await commitOf(repo, { f: c.ours }, [base], `ours ${i}\n`);
    const theirs = await commitOf(repo, { f: c.theirs }, [base], `theirs ${i}\n`);
    lines.push(`${ours} ${theirs}`);
    pairs.push({ ours, theirs });
  }
  const out = execFileSync("git", ["merge-tree", "--write-tree", "--stdin"], {
    cwd: d,
    env: gitEnv,
    input: `${lines.join("\n")}\n`,
    maxBuffer: 1 << 28,
  }).toString();
  // per merge: clean, tree, then for a conflicted merge its entries…, "" and its messages
  // (count, paths, type, text)…; every merge ends with ""
  const tok = out.split("\0");
  let at = 0;
  const next = () => {
    if (at >= tok.length) throw new Error("merge-tree output ended early");
    return tok[at++] as string;
  };
  const results: GitResult[] = [];
  for (let k = 0; k < cases.length; k++) {
    const status = next();
    if (status !== "0" && status !== "1")
      throw new Error(`merge-tree: status ${JSON.stringify(status)}`);
    const clean = status === "1";
    const tree = next();
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`merge-tree: tree ${JSON.stringify(tree)}`);
    if (!clean) {
      while (next() !== "");
      for (let t = next(); t !== ""; t = next()) {
        if (!/^\d+$/.test(t)) throw new Error(`merge-tree: message count ${JSON.stringify(t)}`);
        at += Number(t) + 2;
      }
    } else if (next() !== "") throw new Error("merge-tree: a clean merge with more output");
    results.push({ clean, tree });
  }
  // everything consumed (the output ends with a NUL: one empty token is left)
  if (at !== tok.length - 1 || tok[at] !== "") throw new Error("merge-tree: output left over");
  return { repo, results, pairs };
}

async function compare(cases: Case[]) {
  const { repo, results, pairs } = await gitMerges(cases);
  const wrong: string[] = [];
  for (const [i, c] of cases.entries()) {
    const g = results[i] as GitResult;
    const p = pairs[i] as { ours: string; theirs: string };
    const entry = (await readTree(repo, g.tree)).find((e) => e.name === "f");
    const expected = entry ? await blob(repo, entry.oid) : new Uint8Array(0);
    const ours = mergeContent(
      c.base,
      c.ours,
      c.theirs,
      { ours: p.ours, theirs: p.theirs },
      xdOptions,
    );
    const same = Buffer.compare(Buffer.from(ours.content), Buffer.from(expected)) === 0;
    if (!same || (ours.conflicts === 0) !== g.clean)
      wrong.push(
        `${c.name}: ${same ? "" : "content differs"} ${(ours.conflicts === 0) !== g.clean ? `clean: git ${g.clean}, ours ${ours.conflicts === 0}` : ""}\n--- git\n${dec.decode(expected)}\n--- ours\n${dec.decode(ours.content)}`,
      );
  }
  return wrong;
}

/** the installed git's merge behaviour: compaction changed in 2.54 */
const gitVersion = execFileSync("git", ["--version"], { env: gitEnv })
  .toString()
  .match(/(\d+)\.(\d+)/)
  ?.slice(1)
  .map(Number) ?? [0, 0];
const xdOptions = {
  legacyCompaction: (gitVersion[0] as number) * 1000 + (gitVersion[1] as number) < 2054,
};

const L = (...lines: string[]) => enc.encode(lines.map((l) => `${l}\n`).join(""));

describe("M1 content merge, byte-identical to git merge-tree", () => {
  it("hand-made cases: clean edits, conflicts, identical changes, adjacency, CRLF, missing newline, binary", async () => {
    const base = L("a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
    const cases: Case[] = [
      {
        name: "separate edits",
        base,
        ours: L("A", "b", "c", "d", "e", "f", "g", "h", "i", "j"),
        theirs: L("a", "b", "c", "d", "e", "f", "g", "h", "i", "J"),
      },
      {
        name: "same line",
        base,
        ours: L("a", "b", "X", "d", "e", "f", "g", "h", "i", "j"),
        theirs: L("a", "b", "Y", "d", "e", "f", "g", "h", "i", "j"),
      },
      {
        name: "identical change",
        base,
        ours: L("a", "b", "Z", "d", "e", "f", "g", "h", "i", "j"),
        theirs: L("a", "b", "Z", "d", "e", "f", "g", "h", "i", "j"),
      },
      {
        name: "adjacent lines",
        base,
        ours: L("a", "b", "C", "d", "e", "f", "g", "h", "i", "j"),
        theirs: L("a", "b", "c", "D", "e", "f", "g", "h", "i", "j"),
      },
      {
        name: "near conflicts joined",
        base,
        ours: L("a", "B", "c", "d", "E", "f", "g", "h", "i", "j"),
        theirs: L("a", "b2", "c", "d", "e2", "f", "g", "h", "i", "j"),
      },
      {
        name: "overlap differing in part",
        base,
        ours: L("a", "b", "x1", "x2", "x3", "f", "g", "h", "i", "j"),
        theirs: L("a", "b", "x1", "y2", "x3", "f", "g", "h", "i", "j"),
      },
      {
        name: "insert at the same place",
        base,
        ours: L("a", "b", "c", "d", "e", "new1", "f", "g", "h", "i", "j"),
        theirs: L("a", "b", "c", "d", "e", "new2", "f", "g", "h", "i", "j"),
      },
      {
        name: "one side deletes everything",
        base,
        ours: new Uint8Array(0),
        theirs: L("a", "b", "c", "d", "e", "F", "g", "h", "i", "j"),
      },
      {
        name: "add/add from empty",
        base: new Uint8Array(0),
        ours: L("one", "two"),
        theirs: L("one", "three"),
      },
      {
        name: "no newline at end",
        base: enc.encode("a\nb\nc"),
        ours: enc.encode("a\nB\nc"),
        theirs: enc.encode("a\nb\nC"),
      },
      {
        name: "no newline, conflict at end",
        base: enc.encode("a\nb\nc"),
        ours: enc.encode("a\nb\nX"),
        theirs: enc.encode("a\nb\nY"),
      },
      {
        name: "CRLF conflict",
        base: enc.encode("a\r\nb\r\nc\r\n"),
        ours: enc.encode("a\r\nX\r\nc\r\n"),
        theirs: enc.encode("a\r\nY\r\nc\r\n"),
      },
      {
        name: "binary",
        base: enc.encode("a\0b"),
        ours: enc.encode("a\0c"),
        theirs: enc.encode("a\0d"),
      },
      // merge-ort's trivial merges come before the binary check
      {
        name: "binary, ours unchanged",
        base: enc.encode("x\0\n"),
        ours: enc.encode("x\0\n"),
        theirs: enc.encode("y\0\n"),
      },
      {
        name: "binary, both the same",
        base: enc.encode("a\n"),
        ours: enc.encode("b\0\n"),
        theirs: enc.encode("b\0\n"),
      },
      {
        name: "binary, theirs unchanged",
        base: enc.encode("a\n"),
        ours: enc.encode("b\0\n"),
        theirs: enc.encode("a\n"),
      },
      {
        name: "repeated lines (histogram's fallback)",
        base: L(...Array.from({ length: 150 }, (_, i) => (i % 3 ? "}" : `x${i}`))),
        ours: L(
          ...Array.from({ length: 150 }, (_, i) => (i % 3 ? "}" : i === 30 ? "OURS" : `x${i}`)),
        ),
        theirs: L(
          ...Array.from({ length: 150 }, (_, i) => (i % 3 ? "}" : i === 120 ? "THEIRS" : `x${i}`)),
        ),
      },
    ];
    expect(await compare(cases)).toEqual([]);
  }, 120_000);
});

/** xorshift */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}
function edit(lines: string[], rand: () => number, alphabet: string[]): string[] {
  const out = [...lines];
  const n = 1 + Math.floor(rand() * 4);
  for (let k = 0; k < n; k++) {
    const at = Math.floor(rand() * (out.length + 1));
    const kind = rand();
    const pick = () => alphabet[Math.floor(rand() * alphabet.length)] as string;
    if (kind < 0.35) out.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, pick));
    else if (kind < 0.7) out.splice(at, 1 + Math.floor(rand() * 3));
    else
      out.splice(
        at,
        1 + Math.floor(rand() * 2),
        ...Array.from({ length: 1 + Math.floor(rand() * 3) }, pick),
      );
  }
  return out;
}

describe("M6 a generated corpus", () => {
  it("400 random merges: every merged blob and clean flag equal to git merge-tree's", async () => {
    const rand = rng(13);
    const cases: Case[] = [];
    for (let i = 0; i < 400; i++) {
      // a small alphabet: lines repeat, as code does
      const alphabet = Array.from({ length: 3 + Math.floor(rand() * 12) }, (_, k) => `line ${k}`);
      const base = Array.from(
        { length: Math.floor(rand() * 40) },
        () => alphabet[Math.floor(rand() * alphabet.length)] as string,
      );
      const ours = edit(base, rand, alphabet);
      const theirs = rand() < 0.1 ? [...ours] : edit(base, rand, alphabet);
      const nl = rand() < 0.1 ? "" : "\n";
      const join = (ls: string[]) => enc.encode(ls.length ? `${ls.join("\n")}${nl}` : "");
      cases.push({ name: `#${i}`, base: join(base), ours: join(ours), theirs: join(theirs) });
    }
    const wrong = await compare(cases);
    expect(wrong.slice(0, 3)).toEqual([]);
    expect(wrong.length).toBe(0);
  }, 300_000);
});

describe("M6b large files: histogram's fallback and the classic algorithm's cost limits", () => {
  it("60 merges of 300–3000 lines with heavy repetition and large edits", async () => {
    const rand = rng(29);
    const cases: Case[] = [];
    for (let i = 0; i < 60; i++) {
      // a few lines repeat hundreds of times (histogram falls back to classic past 64)
      const alphabet = Array.from({ length: 2 + Math.floor(rand() * 30) }, (_, k) =>
        k < 3 ? (["}", "", "  return;"][k] as string) : `stmt ${k}`,
      );
      const n = 300 + Math.floor(rand() * 2700);
      const base = Array.from(
        { length: n },
        () => alphabet[Math.floor(rand() * alphabet.length)] as string,
      );
      const big = (ls: string[]) => {
        let out = ls;
        const rounds = 5 + Math.floor(rand() * 60);
        for (let r = 0; r < rounds; r++) out = edit(out, rand, alphabet);
        return out;
      };
      const ours = big(base);
      const theirs = big(base);
      const enc2 = (ls: string[]) => enc.encode(`${ls.join("\n")}\n`);
      cases.push({ name: `big #${i}`, base: enc2(base), ours: enc2(ours), theirs: enc2(theirs) });
    }
    const wrong = await compare(cases);
    expect(wrong.map((w) => w.split("\n")[0])).toEqual([]);
  }, 600_000);
});

describe("M6c the classic algorithm's heuristics (edit cost past 256)", () => {
  it("12 merges of thousands of lines over three distinct lines, heavily edited on both sides", async () => {
    const rand = rng(31);
    const cases: Case[] = [];
    for (let i = 0; i < 12; i++) {
      const alphabet = ["x", "y", "z"];
      const n = 2000 + Math.floor(rand() * 2000);
      const base = Array.from({ length: n }, () => alphabet[Math.floor(rand() * 3)] as string);
      const heavy = (ls: string[]) => {
        let out = ls;
        for (let r = 0; r < 400; r++) out = edit(out, rand, alphabet);
        return out;
      };
      const enc2 = (ls: string[]) => enc.encode(`${ls.join("\n")}\n`);
      cases.push({
        name: `heavy #${i}`,
        base: enc2(base),
        ours: enc2(heavy(base)),
        theirs: enc2(heavy(base)),
      });
    }
    // long runs of one line (snakes past 20) between regions each side rewrites: the snake heuristic,
    // which needs the cost limit above 256 — more than 65,536 diagonals, so ~35,000 lines a side
    for (let i = 0; i < 4; i++) {
      const segs = i === 0 ? 600 : 50 + Math.floor(rand() * 30);
      const noise = () =>
        Array.from({ length: 30 + Math.floor(rand() * 30) }, () => (rand() < 0.5 ? "y" : "z"));
      const run = Array.from({ length: 25 }, () => "x");
      const make = (keep: string[][] | undefined) => {
        const out: string[][] = [];
        for (let k = 0; k < segs; k++)
          out.push(keep && rand() < 0.3 ? (keep[k] as string[]) : noise());
        return out;
      };
      const baseSegs = make(undefined);
      const join2 = (sg: string[][]) =>
        enc.encode(`${sg.flatMap((n) => [...run, ...n]).join("\n")}\n`);
      cases.push({
        name: `snakes #${i}`,
        base: join2(baseSegs),
        ours: join2(make(baseSegs)),
        theirs: join2(make(baseSegs)),
      });
    }
    const wrong = await compare(cases);
    expect(wrong.map((w) => w.split("\n")[0])).toEqual([]);
  }, 600_000);
});

describe("M6d the classic algorithm's discards (lines that cannot match amid lines that match often)", () => {
  it("4000 merges: frequent lines plus lines unique to one side, small and large", async () => {
    const rand = rng(7);
    let uid = 0;
    const common = ["x", "y", "z"];
    const pool = () => (rand() < 0.4 ? `u${uid++}` : (common[Math.floor(rand() * 3)] as string));
    const editWith = (lines: string[], n: number) => {
      const out = [...lines];
      for (let k = 0; k < n; k++) {
        const at = Math.floor(rand() * (out.length + 1));
        const kind = rand();
        if (kind < 0.35)
          out.splice(at, 0, ...Array.from({ length: 1 + Math.floor(rand() * 3) }, pool));
        else if (kind < 0.7) out.splice(at, 1 + Math.floor(rand() * 3));
        else
          out.splice(
            at,
            1 + Math.floor(rand() * 2),
            ...Array.from({ length: 1 + Math.floor(rand() * 3) }, pool),
          );
      }
      return out;
    };
    const cases: Case[] = [];
    for (let i = 0; i < 4000; i++) {
      const big = rand() < 0.5;
      const n = big ? 200 + Math.floor(rand() * 400) : 5 + Math.floor(rand() * 30);
      const base = Array.from({ length: n }, () => common[Math.floor(rand() * 3)] as string);
      const e = big ? 30 : 3;
      const ours = editWith(base, 1 + Math.floor(rand() * e));
      const theirs = editWith(base, 1 + Math.floor(rand() * e));
      const j = (l: string[]) => enc.encode(l.length ? `${l.join("\n")}\n` : "");
      cases.push({ name: `discards #${i}`, base: j(base), ours: j(ours), theirs: j(theirs) });
    }
    const wrong = await compare(cases);
    expect(wrong.map((w) => w.split("\n")[0])).toEqual([]);
  }, 900_000);
});

describe("review #93", () => {
  it("histogram's chain limit: git fails the merge; ours throws a typed error", () => {
    const X = Array.from({ length: 8400 }, (_, i) => `u${i}\n`);
    const Y: string[] = [];
    for (let k = 0; k <= 64; k++) Y.push(X[128 * k + ((128 - k) % 128)] as string);
    const Z = Array.from({ length: 65 }, (_, i) => `z${i}\n`);
    const b = (ls: string[]) => enc.encode(ls.join(""));
    expect(() =>
      mergeContent(b([...X, ...Y]), b([...X, ...Z]), b([...X, ...Y, "tail\n"]), {
        ours: "o",
        theirs: "t",
      }),
    ).toThrow(XdiffLimitError);
  });

  it("joining many refined conflicts is linear (git's is a list walk)", () => {
    // 400,000 conflicts two lines apart: all join into one. A quadratic join (an array splice per
    // join) moves ~8·10^10 entries; git's list walk, and ours, one pass.
    const n = 400_000;
    const merges: Merge[] = Array.from({ length: n }, (_, k) => ({
      mode: 0,
      i0: 3 * k,
      chg0: 1,
      i1: 3 * k,
      chg1: 1,
      i2: 3 * k,
      chg2: 1,
    }));
    const t0 = performance.now();
    const out = simplifyNonConflicts(merges);
    expect(out).toEqual([
      { mode: 0, i0: 0, chg0: 1, i1: 0, chg1: 3 * n - 2, i2: 0, chg2: 3 * n - 2 },
    ]);
    expect(performance.now() - t0).toBeLessThan(2000);
  }, 120_000);
});
