import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareTrees, corpus, handMade, reviewCases } from "./tree-harness.js";

describe("T1 tree merges without renames, as git merge-tree -Xno-renames", () => {
  let kinds: string[] = [];
  it("T1: 400 random tree merges: tree ids, conflicted entries and messages", async () => {
    const r = await compareTrees(corpus(400, 101));
    kinds = r.kinds;
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 300_000);

  it("T1b: 1000 random tree merges from another seed", async () => {
    const r = await compareTrees(corpus(1000, 7));
    kinds.push(...r.kinds);
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 600_000);

  it("T1c: 400 merges whose paths collide with path~branch names", async () => {
    const r = await compareTrees(
      corpus(400, 202, { names: ["a", "b", "a~{O}", "a~{O}_0", "a~{T}", "b~{T}"] }),
    );
    kinds.push(...r.kinds);
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 300_000);

  it("T1d: 300 merges where files become directories of up to 12 files (ort's redo)", async () => {
    const r = await compareTrees(corpus(300, 303, { fanout: 12 }));
    kinds.push(...r.kinds);
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 300_000);

  it("T1e: 200 merges of unrelated histories (no merge base)", async () => {
    const r = await compareTrees(corpus(200, 404), { unrelated: true });
    kinds.push(...r.kinds);
    expect(r.wrong.slice(0, 2)).toEqual([]);
    expect(r.wrong.length).toBe(0);
  }, 300_000);

  it("T2: the corpus reaches every conflict kind in scope", () => {
    const count = (k: string) => kinds.filter((x) => x === k).length;
    for (const k of ["content", "add/add", "modify/delete", "distinct types", "file/directory"])
      expect(count(k), k).toBeGreaterThan(0);
  });
});

describe("T4 hand-made cases the random corpus rarely reaches", () => {
  it("a symlink both sides turn into regular files: three modes, a two-way content merge", async () => {
    const r = await compareTrees(handMade);
    expect(r.wrong).toEqual([]);
  });
});

describe("T5 cases from the review", () => {
  it("each equal to git merge-tree", async () => {
    const r = await compareTrees(reviewCases);
    expect(r.wrong).toEqual([]);
  });
});

describe("T3 portable", () => {
  it("merge-trees.ts has no node: imports", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "../src/merge-trees.ts"), "utf8");
    expect(src).not.toMatch(/from "node:/);
  });
});
